// Guard: the mutation secret must never reach the browser.
//
// The original defect: a Server Component read RECONCILE_MUTATION_TOKEN and
// passed it as a prop to a 'use client' component, so Next serialized it into
// the page payload. Static HTML never showed it — only the flight data did —
// so a render-based check alone cannot catch that pattern. Hence:
//
//   1. Allowlist: the ONLY files under apps/web permitted to mention the
//      identifier RECONCILE_MUTATION_TOKEN at all — in code, comments, or
//      strings — are the server-side auth gate and the startup check. Any
//      other occurrence (a page, layout, component, helper; direct read,
//      destructuring, aliasing) fails this suite. This is deliberately blunt:
//      there is no legitimate reason for the name to appear anywhere else.
//   2. Render: the receipts page rendered with a canary token in the
//      environment contains neither the canary nor a `mutationToken` prop.
//
// Note the gate exposes only boolean checks (`isValidMutationToken`,
// `requireMutationToken`) — nothing returns the secret, so an allowlisted
// module cannot hand it to a page either.

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

const IDENTIFIER = /\bRECONCILE_MUTATION_TOKEN\b/;

// Extending this list is a deliberate security decision — do it in a reviewed change.
const ALLOWED = new Set([
  'app/lib/auth/token.ts', // the gate (boolean checks only; never returns the secret)
  'instrumentation.ts', // server startup: warns when the token is unset
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('only the server-side auth gate mentions RECONCILE_MUTATION_TOKEN', () => {
  const mentions = walk(WEB_DIR)
    .filter((f) => IDENTIFIER.test(readFileSync(f, 'utf8')))
    .map((f) => relative(WEB_DIR, f))
    .sort();

  it('the allowed files still mention it (sanity: the gate reads the env)', () => {
    for (const allowed of ALLOWED) {
      expect(mentions, `${allowed} should mention the token`).toContain(allowed);
    }
  });

  it('no other file under apps/web mentions it', () => {
    const unexpected = mentions.filter((m) => !ALLOWED.has(m));
    expect(unexpected, 'unexpected mentions of RECONCILE_MUTATION_TOKEN').toEqual([]);
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
