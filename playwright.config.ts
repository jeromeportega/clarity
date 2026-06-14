import { defineConfig, devices } from '@playwright/test';

// Golden-path E2E gate (`npm run e2e`). This is intentionally SEPARATE from the
// Vitest unit gate (`npm test`): Playwright only ever looks in `./e2e`, and the
// Vitest unit project excludes `e2e/**`, so the two suites never overlap.
//
// No `webServer` is configured — we smoke-test the LIVE deployed instance at the
// baseURL below (override with E2E_BASE_URL to point at a local/preview build).
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 1,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'https://clarity-zeta-self.vercel.app',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
