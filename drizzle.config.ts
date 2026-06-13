import { defineConfig } from 'drizzle-kit';

// libSQL / Turso is SQLite-compatible (epic H1 stack decision). The receipts
// and receipt_items tables modeled here mirror H1's schema; H1 owns the real
// migrations once its schema lands. Until then `store/h1-schema.ts` is the
// stub source of truth for the H2 module's tests.
export default defineConfig({
  dialect: 'sqlite',
  schema: './modules/finance/core/receipts/store/h1-schema.ts',
  out: './modules/finance/core/receipts/store/migrations',
});
