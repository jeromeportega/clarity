import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The receipts core is pure TypeScript — zero Next/React imports (FR-1, NFR-2),
// so it stays extractable into a standalone API. This guard scans the whole
// module source (this story's files and any later story's) and fails if a
// framework import sneaks in.
const moduleRoot = dirname(fileURLToPath(import.meta.url));

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'migrations') continue;
      out.push(...collectTsFiles(join(dir, entry.name)));
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

const IMPORT_RE = /from\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;
const FORBIDDEN = ['next', 'react', 'react-dom'];

function frameworkImports(source: string): string[] {
  const offenders: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = IMPORT_RE.exec(source)) !== null) {
    const spec = match[1] ?? match[2] ?? '';
    const pkg = spec.startsWith('@')
      ? spec.split('/').slice(0, 2).join('/')
      : spec.split('/')[0];
    if (FORBIDDEN.includes(pkg)) offenders.push(spec);
  }
  return offenders;
}

describe('framework isolation (FR-1, NFR-2)', () => {
  const files = collectTsFiles(moduleRoot);

  it('finds module source files to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s imports neither next nor react', (file) => {
    expect(frameworkImports(readFileSync(file, 'utf8'))).toEqual([]);
  });
});
