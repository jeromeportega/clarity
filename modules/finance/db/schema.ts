import { sql } from 'drizzle-orm';
import {
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';

/**
 * Full end-to-end finance schema (ADR-004: ship every table now, even those
 * H2/H3 leave empty in H1). Conventions (ADR-001):
 *   - IDs are app-generated UUID `text` primary keys.
 *   - Money is signed `integer` cents everywhere (negative = money leaving /
 *     a return line; positive = money entering / a purchase line).
 *   - Dates / timestamps are ISO-8601 `text`.
 *
 * Returns are first-class signed-negative line items carrying a
 * `refund_destination` enum rather than a separate returns table (ADR-002).
 */

export const REFUND_DESTINATIONS = [
  'card',
  'store_credit',
  'gift_card',
  'account_balance',
] as const;

/** Non-`card` refund destinations accrue a store-credit ledger row (FR-14). */
export const STORE_CREDIT_KINDS = ['store_credit', 'gift_card', 'account_balance'] as const;

/**
 * Canonical category taxonomy (categories is the source of truth — H3 consumes
 * it; the seed script populates these names). Defined here so schema and seed
 * agree on the taxonomy.
 */
export const DEFAULT_CATEGORIES = [
  'groceries',
  'household',
  'electronics',
  'clothing',
  'utilities',
  'mortgage_rent',
  'subscriptions',
  'dining',
  'transport',
  'other',
] as const;

const createdAt = () =>
  text('created_at')
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`);

export const households = sqliteTable('households', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: createdAt(),
});

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  householdId: text('household_id')
    .notNull()
    .references(() => households.id),
  name: text('name').notNull(),
  type: text('type'),
  institution: text('institution'),
  createdAt: createdAt(),
});

export const transactions = sqliteTable(
  'transactions',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    postedDate: text('posted_date').notNull(),
    amountCents: integer('amount_cents').notNull(),
    direction: text('direction', { enum: ['debit', 'credit'] }).notNull(),
    rawMerchant: text('raw_merchant'),
    normalizedMerchant: text('normalized_merchant').notNull(),
    sourceRowHash: text('source_row_hash').notNull(),
    // SHA-256 of (account + date + amount + normalized merchant + source-row
    // hash); the FR-16 idempotency key, enforced by ux_transactions_dedup.
    dedupKey: text('dedup_key').notNull(),
    createdAt: createdAt(),
  },
  (table) => ({
    uxTransactionsDedup: uniqueIndex('ux_transactions_dedup').on(table.dedupKey),
  }),
);

export const orders = sqliteTable(
  'orders',
  {
    id: text('id').primaryKey(),
    householdId: text('household_id')
      .notNull()
      .references(() => households.id),
    source: text('source').notNull(),
    externalOrderId: text('external_order_id').notNull(),
    orderDate: text('order_date').notNull(),
    currency: text('currency').notNull().default('USD'),
    orderTotalCents: integer('order_total_cents'),
    createdAt: createdAt(),
  },
  (table) => ({
    uxOrdersExternal: uniqueIndex('ux_orders_external').on(
      table.householdId,
      table.source,
      table.externalOrderId,
    ),
  }),
);

export const orderItems = sqliteTable(
  'order_items',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id),
    // Per-shipment identifier: one order can ship in several parcels.
    shipmentId: text('shipment_id').notNull(),
    itemSeq: integer('item_seq').notNull(),
    description: text('description').notNull(),
    quantity: integer('quantity').notNull(),
    unitPriceCents: integer('unit_price_cents'),
    // Signed: return / refund lines are negative (FR-15).
    amountCents: integer('amount_cents').notNull(),
    isReturn: integer('is_return', { mode: 'boolean' }).notNull().default(false),
    refundDestination: text('refund_destination', { enum: REFUND_DESTINATIONS }),
    sourceRowHash: text('source_row_hash').notNull(),
    createdAt: createdAt(),
  },
  (table) => ({
    uxOrderItemsLine: uniqueIndex('ux_order_items_line').on(
      table.orderId,
      table.shipmentId,
      table.itemSeq,
    ),
  }),
);

/**
 * receipts / receipt_items — shaped for H2 (Receipt Vision) but unpopulated in
 * H1. Columns and semantics are a cross-epic contract with H2; do not rename or
 * drop them. `payment_last4` stores at most the last four digits, never a full
 * PAN.
 */
export const receipts = sqliteTable('receipts', {
  id: text('id').primaryKey(),
  householdId: text('household_id')
    .notNull()
    .references(() => households.id),
  source: text('source').notNull(),
  store: text('store').notNull(),
  purchasedAt: text('purchased_at').notNull(),
  subtotalCents: integer('subtotal_cents'),
  taxCents: integer('tax_cents'),
  totalCents: integer('total_cents').notNull(),
  paymentLast4: text('payment_last4'),
  imageHash: text('image_hash'),
  needsReview: integer('needs_review', { mode: 'boolean' }).notNull().default(false),
  createdAt: createdAt(),
});

export const receiptItems = sqliteTable('receipt_items', {
  id: text('id').primaryKey(),
  receiptId: text('receipt_id')
    .notNull()
    .references(() => receipts.id),
  lineNo: integer('line_no').notNull(),
  sku: text('sku'),
  rawDescription: text('raw_description').notNull(),
  canonicalName: text('canonical_name'),
  categoryId: text('category_id').references(() => categories.id),
  quantity: real('quantity').notNull(),
  unitPriceCents: integer('unit_price_cents'),
  // Signed: negative for return / refund items.
  linePriceCents: integer('line_price_cents').notNull(),
  discountCents: integer('discount_cents').notNull().default(0),
  nameConfidence: real('name_confidence'),
  categoryConfidence: real('category_confidence'),
  refundDestination: text('refund_destination', { enum: REFUND_DESTINATIONS }),
  needsReview: integer('needs_review', { mode: 'boolean' }).notNull().default(false),
  /** JSON-encoded bounding box {x,y,width,height} as fractions [0,1] of image dims. NULL when coordinates unavailable (ADR-007 graceful-degradation). */
  bbox: text('bbox'),
  createdAt: createdAt(),
});

/**
 * matches — H3 reconciles transactions against order / receipt line items. Table
 * shipped now (ADR-004); no consumer exists in H1.
 */
export const matches = sqliteTable('matches', {
  id: text('id').primaryKey(),
  transactionId: text('transaction_id')
    .notNull()
    .references(() => transactions.id),
  orderItemId: text('order_item_id').references(() => orderItems.id),
  receiptItemId: text('receipt_item_id').references(() => receiptItems.id),
  status: text('status', { enum: ['pending', 'matched', 'rejected', 'manual'] })
    .notNull()
    .default('pending'),
  confidence: real('confidence'),
  method: text('method'),
  // H3 additive columns (migration 0001_h3_matches, ADR-006):
  rationale: text('rationale'),                                          // FR-3
  storeCreditBalanceId: text('store_credit_balance_id').references(     // FR-7
    (): AnySQLiteColumn => storeCreditBalances.id,
    { onDelete: 'set null' },
  ),
  createdAt: createdAt(),
});

/**
 * categories — taxonomy source of truth for H3 categorization. Schema only in
 * H1 (seeded by the seed script from DEFAULT_CATEGORIES). `parent_id` allows a
 * hierarchy.
 */
export const categories = sqliteTable(
  'categories',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    parentId: text('parent_id').references((): AnySQLiteColumn => categories.id),
    createdAt: createdAt(),
  },
  (table) => ({
    uxCategoriesName: uniqueIndex('ux_categories_name').on(table.name),
  }),
);

/**
 * review_decisions — one row per (householdId, itemType, itemId) decision.
 * Created in story-004-002 so the queue anti-join predicate has a live table.
 * story-004-003 writes to this table; story-004-002 reads it for the anti-join.
 * payload_json stores correction detail for 'correct' decisions (added in 0004 migration).
 */
export const reviewDecisions = sqliteTable(
  'review_decisions',
  {
    id: text('id').primaryKey(),
    householdId: text('household_id').notNull(),
    itemType: text('item_type').notNull(),
    itemId: text('item_id').notNull(),
    decision: text('decision', { enum: ['confirm', 'correct', 'dismiss'] }).notNull(),
    payloadJson: text('payload_json'),
    createdAt: createdAt(),
  },
  (table) => ({
    uxReviewDecisionsItem: uniqueIndex('ux_review_decisions_item').on(
      table.householdId,
      table.itemType,
      table.itemId,
    ),
  }),
);

/**
 * store_credit_balances — append-only ledger of non-card refunds (FR-14). One
 * positive accrual row per return whose refund_destination is store_credit /
 * gift_card / account_balance; a `card` refund writes no row.
 */
export const storeCreditBalances = sqliteTable('store_credit_balances', {
  id: text('id').primaryKey(),
  householdId: text('household_id')
    .notNull()
    .references(() => households.id),
  orderItemId: text('order_item_id').references(() => orderItems.id),
  kind: text('kind', { enum: STORE_CREDIT_KINDS }).notNull(),
  amountCents: integer('amount_cents').notNull(),
  createdAt: createdAt(),
});
