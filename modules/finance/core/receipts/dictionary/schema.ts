import type { Client } from '@libsql/client';
import { integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// =============================================================================
// H2's OWN `sku_dictionary` table (epic contract §7). Unlike H1's receipts
// schema, this table belongs to H2, so creating it here is not contract drift
// (FR-16). It is the single source of truth for both the libSQL dictionary and
// the stub DDL below.
//
// Upsert law (enforced by LibSqlSkuDictionary / StubSkuDictionary, not by the
// table): `source='human'` always overwrites; `source='auto'` writes only when
// no row exists for the key and never overwrites an existing row. The
// confidence gate is the resolver's job, applied before upsert.
// =============================================================================

export const skuDictionary = sqliteTable(
  'sku_dictionary',
  {
    store: text('store').notNull(), // normalizeStore()
    skuOrAbbrev: text('sku_or_abbrev').notNull(), // normalizeSkuOrAbbrev()
    canonicalName: text('canonical_name').notNull(),
    category: text('category').notNull(), // a taxonomy member
    nameConfidence: real('name_confidence').notNull(),
    categoryConfidence: real('category_confidence').notNull(),
    source: text('source', { enum: ['auto', 'human'] }).notNull(),
    updatedAt: integer('updated_at').notNull(), // epoch ms
  },
  (table) => ({
    pk: primaryKey({ columns: [table.store, table.skuOrAbbrev] }),
  }),
);

export const schema = { skuDictionary };

// DDL mirroring the Drizzle table, for materializing the table in a fresh
// (e.g. `:memory:`) libSQL database. The CHECK on `source` is enforced at the
// DB level here; the Drizzle column enum gives the same constraint at the type
// level.
export const SKU_DICTIONARY_DDL = `
CREATE TABLE IF NOT EXISTS sku_dictionary (
  store               TEXT NOT NULL,
  sku_or_abbrev       TEXT NOT NULL,
  canonical_name      TEXT NOT NULL,
  category            TEXT NOT NULL,
  name_confidence     REAL NOT NULL,
  category_confidence REAL NOT NULL,
  source              TEXT NOT NULL CHECK (source IN ('auto','human')),
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (store, sku_or_abbrev)
);
`;

// Materialize the table. Hermetic: caller passes a fresh libSQL client (e.g.
// `createClient({ url: ':memory:' })`).
export async function applySkuDictionarySchema(client: Client): Promise<void> {
  await client.executeMultiple(SKU_DICTIONARY_DDL);
}
