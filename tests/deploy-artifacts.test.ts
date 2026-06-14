import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function read(relPath: string): string {
  return readFileSync(join(repoRoot, relPath), 'utf8');
}

function exists(relPath: string): boolean {
  return existsSync(join(repoRoot, relPath));
}

const ARTIFACTS = ['vercel.json', 'deploy/deploy.sh', 'deploy/ENV.md', 'deploy/smoke.sh'];

const ENV_VAR_NAMES = [
  'TURSO_DATABASE_URL',
  'TURSO_AUTH_TOKEN',
  'RECONCILE_MUTATION_TOKEN',
  'PUBLIC_DEMO_MODE',
];

// Patterns that indicate a secret value is committed (name=value assignments with
// non-empty values, or high-entropy strings). Names without values are fine.
const SECRET_VALUE_PATTERNS = [
  /TURSO_AUTH_TOKEN=.+/,
  /RECONCILE_MUTATION_TOKEN=.+/,
  /TURSO_DATABASE_URL=libsql:\/\/[^y]/,  // any real URL (not the placeholder 'your-db')
  /AUTH_TOKEN=[A-Za-z0-9+/]{20,}/,
];

describe('deploy artifacts — presence (FR-14)', () => {
  for (const artifact of ARTIFACTS) {
    it(`${artifact} exists`, () => {
      expect(exists(artifact)).toBe(true);
    });
  }
});

describe('vercel.json — build config', () => {
  it('is valid JSON', () => {
    expect(() => JSON.parse(read('vercel.json'))).not.toThrow();
  });

  it('specifies framework, buildCommand, installCommand, outputDirectory', () => {
    const cfg = JSON.parse(read('vercel.json')) as Record<string, unknown>;
    expect(cfg.framework).toBe('nextjs');
    expect(typeof cfg.buildCommand).toBe('string');
    expect(typeof cfg.installCommand).toBe('string');
    expect(typeof cfg.outputDirectory).toBe('string');
  });

  it('buildCommand targets the web app (pnpm filter or cd apps/web)', () => {
    const cfg = JSON.parse(read('vercel.json')) as Record<string, unknown>;
    const build = cfg.buildCommand as string;
    expect(build).toMatch(/@clarity\/web|apps\/web/);
  });

  it('outputDirectory points into apps/web/.next', () => {
    const cfg = JSON.parse(read('vercel.json')) as Record<string, unknown>;
    expect(cfg.outputDirectory).toContain('apps/web');
  });
});

describe('ENV.md — env-var names, no values (NFR-5)', () => {
  it('lists all required env-var names', () => {
    const content = read('deploy/ENV.md');
    for (const name of ENV_VAR_NAMES) {
      expect(content).toContain(name);
    }
  });

  it('does not contain env-var values — only names', () => {
    const content = read('deploy/ENV.md');
    for (const pattern of SECRET_VALUE_PATTERNS) {
      expect(content).not.toMatch(pattern);
    }
  });

  it('does not contain any =<value> assignments with non-empty right-hand sides', () => {
    const content = read('deploy/ENV.md');
    // Allow `=` in table formatting (e.g. | `VAR` | Yes | ...) but not KEY=VALUE
    const assignmentLines = content.split('\n').filter((line) => {
      return /^[A-Z_]+=\S/.test(line.trim());
    });
    expect(assignmentLines).toHaveLength(0);
  });
});

describe('secret hygiene — no token/secret values in any artifact (NFR-5)', () => {
  for (const artifact of ARTIFACTS) {
    it(`${artifact} contains no committed secret values`, () => {
      if (!exists(artifact)) return; // presence tested separately
      const content = read(artifact);
      for (const pattern of SECRET_VALUE_PATTERNS) {
        expect(content).not.toMatch(pattern);
      }
    });
  }

  it('no artifact contains a high-entropy token-looking string (≥40 hex chars)', () => {
    for (const artifact of ARTIFACTS) {
      if (!exists(artifact)) continue;
      const content = read(artifact);
      // Match 40+ consecutive hex chars (typical token fingerprint)
      expect(content).not.toMatch(/[0-9a-f]{40,}/i);
    }
  });
});

describe('no-deploy guarantee — artifacts never invoke vercel automatically (ADR-006)', () => {
  const NON_COMMENT_VERCEL_CMD = /^\s*(?!#).*\bvercel\s+(--prod|deploy)\b/m;

  for (const artifact of ARTIFACTS) {
    it(`${artifact} does not execute vercel as a shell command`, () => {
      if (!exists(artifact)) return;
      const content = read(artifact);
      // Look for lines where vercel is invoked (not in comments or echo strings)
      const execLines = content
        .split('\n')
        .filter((line) => {
          const trimmed = line.trim();
          if (trimmed.startsWith('#')) return false; // comment
          if (/^\s*echo\s+/.test(line)) return false; // echo (prints, not invokes)
          if (/^\s*vercel\s+(--version|whoami)/.test(line)) return false; // info-only commands
          return /\bvercel\s+(--prod|deploy)\b/.test(line);
        });
      expect(execLines).toHaveLength(0);
    });
  }

  it('no artifact requires a token to exist in the worktree to run checks', () => {
    for (const artifact of ARTIFACTS) {
      if (!exists(artifact)) continue;
      const content = read(artifact);
      // No artifact should assert a token env var is set (which would block offline use)
      expect(content).not.toMatch(/^\s*\[[ \t]*-[nz][ \t]+"\$\{?RECONCILE_MUTATION_TOKEN/m);
    }
  });
});

describe('smoke.sh — static contract assertions', () => {
  it('curls GET /api/queue', () => {
    const content = read('deploy/smoke.sh');
    expect(content).toMatch(/curl.*\/api\/queue/);
  });

  it('asserts HTTP 200 for the read path', () => {
    const content = read('deploy/smoke.sh');
    expect(content).toContain('"200"');
  });

  it('asserts demo-household data is present in the queue response', () => {
    const content = read('deploy/smoke.sh');
    // The script checks for demo data by asserting the JSON contains queue items
    expect(content).toMatch(/assert_contains.*demo|demo.*household|"\\"id\\""/);
  });

  it('curls a mutation route without a token', () => {
    const content = read('deploy/smoke.sh');
    // curl may span multiple lines (\ continuation), so match across newlines
    expect(content).toMatch(/curl[\s\S]*?\/api\/queue\/.+\/confirm/);
  });

  it('asserts HTTP 401 for the mutation route without token', () => {
    const content = read('deploy/smoke.sh');
    expect(content).toContain('"401"');
  });

  it('exits non-zero on any assertion failure', () => {
    const content = read('deploy/smoke.sh');
    expect(content).toMatch(/exit\s+1/);
  });
});

describe('.gitignore covers sensitive paths', () => {
  const gitignore = read('.gitignore');
  const lines = new Set(
    gitignore
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#')),
  );

  it('excludes data/ directory', () => {
    expect(lines.has('data/')).toBe(true);
  });

  it('excludes .env* files (secrets never committable)', () => {
    expect([...lines].some((l) => l === '.env' || l === '.env.*' || l === '.env*')).toBe(true);
  });
});

describe('determinism — artifacts contain no timestamps or random values', () => {
  it('vercel.json contains no generated timestamps', () => {
    const content = read('vercel.json');
    // ISO date-time pattern
    expect(content).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('smoke.sh contains no hard-coded deploy URL (placeholder examples are OK)', () => {
    const content = read('deploy/smoke.sh');
    // Reject real project-specific URLs; allow documentation placeholders like "your-app.vercel.app"
    const nonPlaceholderUrl = content
      .split('\n')
      .filter((line) => !line.trim().startsWith('#')) // exclude comments
      .join('\n')
      .match(/https:\/\/(?!your-app)[a-z0-9-]+\.vercel\.app/);
    expect(nonPlaceholderUrl).toBeNull();
  });
});
