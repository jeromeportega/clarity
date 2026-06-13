import { defineConfig } from 'drizzle-kit';

// Schema and migrations live under modules/finance/db/ (story-001-002 owns the
// H1 tables). This config is the seam so `drizzle-kit generate` produces
// migrations into the folder createTestDb() applies at test time. H2's
// `sku_dictionary` (its own table, core/receipts/dictionary/schema.ts) is folded
// into the schema input so generate diffs it incrementally as 0001.
export default defineConfig({
  dialect: 'turso',
  schema: ['./db/schema.ts', './core/receipts/dictionary/schema.ts'],
  out: './db/migrations',
  dbCredentials: {
    url: process.env.TURSO_DATABASE_URL ?? 'file:local.db',
    authToken: process.env.TURSO_AUTH_TOKEN,
  },
});
