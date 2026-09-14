import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// apps/web uses the `@/` alias (→ apps/web/), so tests that import route
// handlers or pages must resolve it the same way Next does.
const WEB_ALIAS = { '@': fileURLToPath(new URL('./apps/web', import.meta.url)) };

// Two projects:
//   unit — the offline gate. Every co-located *.test.ts under modules/** and
//          tests/**, plus the type-level contract tests (*.test-d.ts) in the
//          receipts module. No API key, no network. Runs under `npm test`
//          (`vitest run --project unit`).
//   eval — the key-gated vision accuracy harness. Runs under
//          `npm run vision:eval` (`vitest run --project eval`); each eval test
//          self-skips without ANTHROPIC_API_KEY and is EXCLUDED from `npm test`.
export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias: WEB_ALIAS },
        test: {
          name: 'unit',
          environment: 'node',
          include: [
            'modules/**/*.{test,spec}.ts',
            'tests/**/*.{test,spec}.ts',
          ],
          exclude: [
            '**/node_modules/**',
            '**/dist/**',
            '**/.next/**',
            '**/*.eval.test.ts',
            // Playwright golden-path E2E lives in ./e2e and is its own gate
            // (`npm run e2e`). Keep it out of the offline Vitest unit gate.
            'e2e/**',
          ],
          // Runs fully offline against file:/temp libSQL DBs.
          testTimeout: 20_000,
          typecheck: {
            enabled: true,
            // Scoped to the receipts module; the foundation tests are
            // intentionally not part of the type-level run.
            tsconfig: './modules/finance/core/receipts/tsconfig.typecheck.json',
            include: ['modules/finance/core/receipts/**/*.test-d.ts'],
          },
        },
      },
      {
        test: {
          name: 'eval',
          environment: 'node',
          include: ['modules/finance/core/receipts/eval/**/*.eval.test.ts'],
        },
      },
    ],
  },
});
