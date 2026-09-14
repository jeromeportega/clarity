// Guard: the mutation secret must never reach the browser.
//
// The original defect: a Server Component read RECONCILE_MUTATION_TOKEN and
// passed it as a prop to a 'use client' component, so Next serialized it into
// the page payload. Static HTML never showed it — only the flight data did —
// so a render-based check alone cannot catch that pattern. Hence two layers:
//
//   1. Allowlist: the ONLY modules under apps/web permitted to read
//      process.env.RECONCILE_MUTATION_TOKEN are the server-side auth gate and
//      the server actions. Any other reader (a page, a layout, a component)
//      fails this suite — that is exactly what the old receipts/page.tsx was.
//   2. Render: the receipts page rendered with a canary token in the
//      environment contains neither the canary nor a `mutationToken` prop.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import ReceiptsPage from '../apps/web/app/receipts/page';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DIR = join(repoRoot, 'apps/web');
const CANARY = 'canary-mutation-token-9f8e7d6c5b4a';

// An actual read of the secret (not a mention in a comment).
const ENV_READ = /process\.env(\.RECONCILE_MUTATION_TOKEN|\[['"]RECONCILE_MUTATION_TOKEN['"]\])/;

// Server-only modules that legitimately read the secret. Extending this list
// is a deliberate security decision — do it in a reviewed change.
const ALLOWED_READERS = new Set([
  'app/lib/auth/token.ts', // the gate
  'app/actions/queue.ts', // server actions (same gate)
  'instrumentation.ts', // server startup: warns when the token is unset
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('only server-side auth modules read RECONCILE_MUTATION_TOKEN', () => {
  const readers = walk(WEB_DIR)
    .filter((f) => ENV_READ.test(readFileSync(f, 'utf8')))
    .map((f) => relative(WEB_DIR, f));

  it('finds the allowed readers (sanity: the gate still reads the env)', () => {
    for (const allowed of ALLOWED_READERS) {
      expect(readers, `${allowed} should read the token`).toContain(allowed);
    }
  });

  it('no other file under apps/web reads the token', () => {
    const unexpected = readers.filter((r) => !ALLOWED_READERS.has(r));
    expect(unexpected, 'unexpected readers of RECONCILE_MUTATION_TOKEN').toEqual([]);
  });
});

describe('receipts page never serializes the mutation token', () => {
  beforeAll(() => {
    vi.stubEnv('RECONCILE_MUTATION_TOKEN', CANARY);
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it('rendered HTML contains neither the token nor a mutationToken prop', () => {
    const html = renderToStaticMarkup(React.createElement(ReceiptsPage));
    expect(html).not.toContain(CANARY);
    expect(html).not.toMatch(/mutationToken/);
  });
});
