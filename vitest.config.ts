import { defineConfig } from 'vitest/config';

// Two projects (epic contract §10):
//   unit  — offline, no API key; every co-located *.test.ts plus the type-level
//           contract (*.test-d.ts). Runs under `npm test`.
//   eval  — key-gated vision accuracy harness (owned by story-002-006); runs
//           under `npm run vision:eval`. Each eval test self-skips without a key.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['modules/finance/core/receipts/**/*.test.ts'],
          exclude: ['**/*.eval.test.ts', '**/node_modules/**'],
          typecheck: {
            enabled: true,
            tsconfig: './tsconfig.json',
            include: ['modules/finance/core/receipts/**/*.test-d.ts'],
          },
        },
      },
      {
        test: {
          name: 'eval',
          include: ['modules/finance/core/receipts/eval/**/*.eval.test.ts'],
        },
      },
    ],
  },
});
