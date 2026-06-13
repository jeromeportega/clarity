import { defineConfig } from 'drizzle-kit';

// Schema (./db/schema.ts) and migrations (./db/migrations) are owned by
// story-001-002; this config is the seam so `drizzle-kit generate` produces
// migrations into the folder createTestDb() applies at test time.
export default defineConfig({
  dialect: 'turso',
  schema: './db/schema.ts',
  out: './db/migrations',
  dbCredentials: {
    url: process.env.TURSO_DATABASE_URL ?? 'file:local.db',
    authToken: process.env.TURSO_AUTH_TOKEN,
  },
});
