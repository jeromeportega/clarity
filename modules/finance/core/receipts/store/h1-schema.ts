import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Client } from '@libsql/client';

// =============================================================================
// H1's schema — the REAL tables (no longer a stub).
//
// H1 (epic-001 / story-001-002) owns the canonical `receipts`, `receipt_items`
// and `categories` tables and their Drizzle migrations under
// `modules/finance/db/`. This module re-exports those table objects verbatim so
// the H2 libSQL store reads/writes H1's real tables — there is exactly one
// Drizzle definition per table, living in H1's schema. H2 must never redefine
// these tables here; any column it needs that H1 does not own is a cross-epic
// contract negotiation, surfaced as a TypeScript failure via the contract test.
//
// Note the H1 column conventions (ADR-001): ids are app-generated UUID `text`
// primary keys and `created_at` is an ISO-8601 `text` timestamp — the H2 record
// types in `receipt-store.ts` are aligned to these.
// =============================================================================

import {
  categories,
  receiptItems,
  receipts,
  TAXONOMY,
  TAXONOMY_IDS,
} from '../../../db/schema';

export { categories, receiptItems, receipts };

export const schema = { categories, receipts, receiptItems };

// The category ids `listCategories()` returns, in taxonomy order — the one
// taxonomy (`db/taxonomy.ts`), seeded by migration 0005 and the seed scripts.
export const CATEGORY_SEED = TAXONOMY_IDS;

// Resolve H1's real migration SQL so a fresh (e.g. `:memory:`) libSQL database
// can materialize the canonical schema for the offline contract tests.
const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'db',
  'migrations',
);

// The household every offline receipt-store test row references. H1's
// `receipts.household_id` is a FK to `households.id`, and libSQL enforces FKs by
// default, so a fresh test DB must carry this row before a receipt inserts.
export const TEST_HOUSEHOLD_ID = 'household-1';

// Materialize H1's real schema (all migrations) and seed the category taxonomy
// + a test household. Applies every migration file so the in-memory test DB
// stays in sync when later stories add columns to existing tables.
// Hermetic: the caller passes a fresh libSQL client (e.g.
// `createClient({ url: ':memory:' })`).
export async function applyStubH1Schema(client: Client): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sqlText = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    if (sqlText.trim()) await client.executeMultiple(sqlText);
  }
  await client.execute({
    sql: 'INSERT OR IGNORE INTO households (id, name) VALUES (?, ?)',
    args: [TEST_HOUSEHOLD_ID, 'Test Household'],
  });
  await client.batch(
    TAXONOMY.map(({ id, name }) => ({
      sql: 'INSERT OR IGNORE INTO categories (id, name) VALUES (?, ?)',
      args: [id, name],
    })),
    'write',
  );
}
