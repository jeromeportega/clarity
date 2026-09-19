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

// Extending any of these lists is a deliberate security decision — do it in a reviewed change.
const SECRETS: Array<{ name: string; identifier: RegExp; allowed: Set<string> }> = [
  {
    name: 'RECONCILE_MUTATION_TOKEN',
    identifier: /\bRECONCILE_MUTATION_TOKEN\b/,
    allowed: new Set([
      'app/lib/auth/token.ts', // the gate (boolean checks only; never returns the secret)
      'instrumentation.ts', // server startup: warns when the token is unset
    ]),
  },
  {
    // The Plaid API secret and the key that encrypts bank access tokens at
    // rest. Same shape of defect: a page or component that read either would
    // serialize it into the flight payload.
    name: 'PLAID_SECRET and PLAID_TOKEN_KEY',
    identifier: /\bPLAID_(SECRET|TOKEN_KEY)\b/,
    allowed: new Set([
      'lib/plaid/client.ts', // constructs the SDK; the only reader of PLAID_SECRET
      'lib/plaid/client.test.ts', // its unit test (never imported by a page)
      'lib/plaid/sync.ts', // composition root: parses PLAID_TOKEN_KEY for the call
      'lib/plaid/token-cipher.ts', // the cipher (names the variable in its error messages)
      'lib/plaid/token-cipher.test.ts', // its unit test
      'instrumentation.ts', // server startup: warns when Plaid is half-configured
    ]),
  },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(entry)) out.push(full);
  }
  return out;
}

describe.each(SECRETS)('only the allowlisted server files mention $name', ({ identifier, allowed }) => {
  const mentions = walk(WEB_DIR)
    .filter((f) => identifier.test(readFileSync(f, 'utf8')))
    .map((f) => relative(WEB_DIR, f))
    .sort();

  it('the allowed files still mention it (sanity: the gate reads the env)', () => {
    for (const file of allowed) {
      expect(mentions, `${file} should mention the secret`).toContain(file);
    }
  });

  it('no other file under apps/web mentions it', () => {
    const unexpected = mentions.filter((m) => !allowed.has(m));
    expect(unexpected, 'unexpected mentions of the secret').toEqual([]);
  });
});

describe('receipts page never serializes the mutation token', () => {
  beforeAll(() => {
    vi.stubEnv('RECONCILE_MUTATION_TOKEN', CANARY);
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it('rendered HTML contains neither the token nor a mutationToken prop', async () => {
    // The page is an async server component (it resolves the read scope);
    // without sign-in configured and outside demo mode it renders uploads
    // disabled — and, whatever it renders, never the secret.
    const html = renderToStaticMarkup(await ReceiptsPage({}));
    expect(html).not.toContain(CANARY);
    expect(html).not.toMatch(/mutationToken/);
    expect(html).toContain('Receipt uploads are temporarily disabled');
  });
});
