import type { Client } from '@libsql/client';
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// =============================================================================
// H1's schema — STUB.
//
// H1 (epic H1 / story-001-002) owns the real `receipts`, `receipt_items` and
// `categories` tables and their migrations. Until that schema lands, this file
// stubs the exact same tables behind the identical column set so the H2 module
// is independently testable (FR-16). When H1's migrations land, this stub is
// replaced by importing H1's table definitions verbatim — the column names
// here are the agreed contract H1 is building to, so the swap is a no-op for
// every consumer of `ReceiptStore`.
//
// These Drizzle table objects are the single source of truth for both the
// libSQL store and the stub DDL below; keeping them in one file means any
// divergence shows up here rather than silently at runtime.
// =============================================================================

// The category taxonomy (epic H3 item-level classifier). `listCategories()` is
// the authoritative surface — these are the stub seed values pending H1's real
// `categories` seed. No new categories are introduced beyond this list.
export const CATEGORY_SEED = [
  'groceries',
  'household',
  'electronics',
  'clothing',
  'utilities',
  'mortgage_rent',
  'subscriptions',
  'dining',
  'transport',
] as const;

export const categories = sqliteTable('categories', {
  id: text('id').primaryKey(), // taxonomy member id (slug)
});

export const receipts = sqliteTable('receipts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  householdId: integer('household_id').notNull(),
  source: text('source').notNull(),
  store: text('store'),
  purchasedAt: text('purchased_at'),
  subtotalCents: integer('subtotal_cents'),
  taxCents: integer('tax_cents'),
  totalCents: integer('total_cents'),
  paymentLast4: text('payment_last4'),
  imageHash: text('image_hash').notNull().unique(),
  needsReview: integer('needs_review', { mode: 'boolean' }).notNull(),
  createdAt: integer('created_at').notNull(),
});

export const receiptItems = sqliteTable('receipt_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  receiptId: integer('receipt_id')
    .notNull()
    .references(() => receipts.id),
  lineNo: integer('line_no').notNull(),
  sku: text('sku'),
  rawDescription: text('raw_description').notNull(),
  canonicalName: text('canonical_name'),
  categoryId: text('category_id').references(() => categories.id),
  quantity: real('quantity').notNull(),
  unitPriceCents: integer('unit_price_cents'),
  linePriceCents: integer('line_price_cents').notNull(),
  discountCents: integer('discount_cents').notNull(),
  nameConfidence: real('name_confidence'),
  categoryConfidence: real('category_confidence'),
  refundDestination: text('refund_destination', {
    enum: ['card', 'store_credit', 'gift_card', 'account_balance'],
  }),
  needsReview: integer('needs_review', { mode: 'boolean' }).notNull(),
  createdAt: integer('created_at').notNull(),
});

export const schema = { categories, receipts, receiptItems };

// DDL mirroring the Drizzle tables above, for materializing the stub schema in
// a fresh (e.g. `:memory:`) libSQL database. H1's real migrations supersede
// this once they land.
export const STUB_H1_DDL = `
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY NOT NULL
);

CREATE TABLE IF NOT EXISTS receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  household_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  store TEXT,
  purchased_at TEXT,
  subtotal_cents INTEGER,
  tax_cents INTEGER,
  total_cents INTEGER,
  payment_last4 TEXT,
  image_hash TEXT NOT NULL UNIQUE,
  needs_review INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS receipt_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id INTEGER NOT NULL REFERENCES receipts(id),
  line_no INTEGER NOT NULL,
  sku TEXT,
  raw_description TEXT NOT NULL,
  canonical_name TEXT,
  category_id TEXT REFERENCES categories(id),
  quantity REAL NOT NULL,
  unit_price_cents INTEGER,
  line_price_cents INTEGER NOT NULL,
  discount_cents INTEGER NOT NULL,
  name_confidence REAL,
  category_confidence REAL,
  refund_destination TEXT,
  needs_review INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
`;

// Materialize the stub schema and seed the category taxonomy. Hermetic: caller
// passes a fresh libSQL client (e.g. `createClient({ url: ':memory:' })`).
export async function applyStubH1Schema(client: Client): Promise<void> {
  await client.executeMultiple(STUB_H1_DDL);
  await client.batch(
    CATEGORY_SEED.map((id) => ({
      sql: 'INSERT OR IGNORE INTO categories (id) VALUES (?)',
      args: [id],
    })),
    'write',
  );
}
