// Guard: the mutation secret must never be rendered into a page or referenced
// from client-side code.
//
// Two layers:
//   1. Render the receipts page with a canary token in the environment and
//      assert the canary is absent from the HTML (the concrete regression).
//   2. Statically scan every 'use client' module under apps/web/app and assert
//      none references RECONCILE_MUTATION_TOKEN (the general rule).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import ReceiptsPage from '../apps/web/app/receipts/page';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = join(repoRoot, 'apps/web/app');
const CANARY = 'canary-mutation-token-9f8e7d6c5b4a';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

beforeAll(() => {
  vi.stubEnv('RECONCILE_MUTATION_TOKEN', CANARY);
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe('receipts page never serializes the mutation token', () => {
  it('rendered HTML does not contain the configured token', () => {
    const html = renderToStaticMarkup(React.createElement(ReceiptsPage));
    expect(html).not.toContain(CANARY);
    expect(html).not.toMatch(/mutationToken/);
  });

  it('page source does not read process.env.RECONCILE_MUTATION_TOKEN', () => {
    const src = readFileSync(join(APP_DIR, 'receipts/page.tsx'), 'utf8');
    expect(src).not.toMatch(ENV_READ);
  });
});

// An actual read of the secret (not a mention in a comment).
const ENV_READ = /process\.env(\.RECONCILE_MUTATION_TOKEN|\[['"]RECONCILE_MUTATION_TOKEN['"]\])/;

describe("no 'use client' module reads the mutation token", () => {
  const clientModules = walk(APP_DIR).filter((f) => /^\s*['"]use client['"]/m.test(readFileSync(f, 'utf8')));

  it('finds at least one client module (sanity)', () => {
    expect(clientModules.length).toBeGreaterThan(0);
  });

  for (const file of clientModules) {
    it(`${file.slice(repoRoot.length + 1)} does not read process.env.RECONCILE_MUTATION_TOKEN`, () => {
      expect(readFileSync(file, 'utf8')).not.toMatch(ENV_READ);
    });
  }
});
