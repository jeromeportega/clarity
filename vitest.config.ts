import { defineConfig } from 'vitest/config';

// Two projects spanning the merged H1 (Foundation) + H2 (Receipt Vision) tree:
//   unit — the offline gate. Every co-located *.test.ts across H1's foundation
//          (modules/**, tests/**) AND H2's receipts module, plus the H2
//          type-level contract (*.test-d.ts). No API key, no network. Runs
//          under `npm test` (`vitest run --project unit`).
//   eval — H2's key-gated vision accuracy harness (story-002-006). Runs under
//          `npm run vision:eval` (`vitest run --project eval`); each eval test
//          self-skips without ANTHROPIC_API_KEY and is EXCLUDED from `npm test`.
export default defineConfig({
  test: {
    projects: [
      {
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
          ],
          // H1's harness runs fully offline against file:/temp libSQL DBs.
          testTimeout: 20_000,
          typecheck: {
            enabled: true,
            // Scoped to the H2 receipts module so H1's (intentionally
            // un-type-checked) foundation tests are not dragged into the
            // type-level run.
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
