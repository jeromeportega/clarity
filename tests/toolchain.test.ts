import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function readJson(relPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(repoRoot, relPath), 'utf8')) as Record<string, unknown>;
}

function allDeps(pkg: Record<string, unknown>): Record<string, string> {
  const keys = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
  return keys.reduce<Record<string, string>>((acc, key) => {
    const section = pkg[key];
    if (section && typeof section === 'object') Object.assign(acc, section);
    return acc;
  }, {});
}

const PACKAGE_JSONS = ['package.json', 'apps/web/package.json', 'modules/finance/package.json'];

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

describe('workspace layout', () => {
  it('pnpm-workspace.yaml globs modules/* and apps/*', () => {
    const yaml = readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
    expect(yaml).toMatch(/^packages:/m);
    expect(yaml).toMatch(/modules\/\*/);
    expect(yaml).toMatch(/apps\/\*/);
  });

  it('root package.json declares the same workspace globs and a test script', () => {
    const root = readJson('package.json');
    expect(root.workspaces).toEqual(['modules/*', 'apps/*']);
    expect((root.scripts as Record<string, string>).test).toContain('vitest');
  });

  it('modules/finance is the first module', () => {
    expect(existsSync(join(repoRoot, 'modules/finance/package.json'))).toBe(true);
    expect(existsSync(join(repoRoot, 'modules/finance/db/client.ts'))).toBe(true);
  });
});

describe('stack pins (FR-2, ADR-006)', () => {
  it('depends on the geist font package, never @geist-ui/core', () => {
    const web = allDeps(readJson('apps/web/package.json'));
    expect(web.geist).toBeDefined();

    for (const rel of PACKAGE_JSONS) {
      expect(allDeps(readJson(rel))['@geist-ui/core']).toBeUndefined();
    }
  });

  it('does not pull in better-sqlite3 or on-disk sqlite anywhere', () => {
    for (const rel of PACKAGE_JSONS) {
      const deps = allDeps(readJson(rel));
      expect(deps['better-sqlite3']).toBeUndefined();
      expect(deps['sqlite3']).toBeUndefined();
    }
    // ...and it is not present in the installed dependency tree either.
    expect(existsSync(join(repoRoot, 'node_modules/better-sqlite3'))).toBe(false);
    expect(existsSync(join(repoRoot, 'node_modules/sqlite3'))).toBe(false);
  });

  it('uses the libSQL client + drizzle for persistence', () => {
    const finance = allDeps(readJson('modules/finance/package.json'));
    expect(finance['@libsql/client']).toBeDefined();
    expect(finance['drizzle-orm']).toBeDefined();
  });
});

describe('.gitignore (FR-4)', () => {
  const gitignore = readFileSync(join(repoRoot, '.gitignore'), 'utf8');
  const lines = new Set(
    gitignore
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#')),
  );

  it('excludes data/, raw uploads, local DB files, and .env*', () => {
    expect(lines.has('data/')).toBe(true);
    expect(lines.has('uploads/')).toBe(true);
    expect(lines.has('*.db')).toBe(true);
    expect([...lines].some((l) => l === '*.sqlite' || l.startsWith('*.sqlite'))).toBe(true);
    expect([...lines].some((l) => l === '.env' || l === '.env.*' || l === '.env*')).toBe(true);
  });

  it('shipped in the first (root) commit', () => {
    const rootCommit = git(['rev-list', '--max-parents=0', 'HEAD']).split('\n').pop()!;
    const addCommits = git(['log', '--diff-filter=A', '--follow', '--format=%H', '--', '.gitignore'])
      .split('\n')
      .filter(Boolean);
    expect(addCommits.length).toBeGreaterThan(0);
    // The commit that first ADDED .gitignore (oldest = last) is the root commit.
    expect(addCommits[addCommits.length - 1]).toBe(rootCommit);
  });
});
