import { count, inArray } from 'drizzle-orm';

import { DEMO_HOUSEHOLD_ID } from '../scope';
import { sha256Hex, transactionDedupKey } from '../idempotency/keys';
import { reconcile } from '../reconcile/engine';
import { DrizzleReconcileSink } from '../reconcile/sink';
import type { ReconcileInputs } from '../reconcile/model';
import type { FinanceDb } from '../../db/client';
import {
  accounts,
  households,
  matches,
  orderItems,
  orders,
  receiptItems,
  receipts,
  transactions,
} from '../../db/schema';

// Stable hard-coded IDs — no Math.random / Date.now so the seed is
// byte-identical across runs (ADR-001 drift guard). IDs match the
// stub gateway in reconciliation/stub.ts so the public demo and
// offline test gate show identical state.

export { DEMO_HOUSEHOLD_ID };

export const DEMO_ACCOUNT_ID = 'acct-demo-001';

export const DEMO_ORDER_1_ID = 'order-demo-001';
export const DEMO_ORDER_2_ID = 'order-demo-002';

export const DEMO_OI_1_ID = 'oi-demo-001';
export const DEMO_OI_2_ID = 'oi-demo-002';

export const DEMO_RECEIPT_1_ID = 'receipt-demo-001';
export const DEMO_RECEIPT_2_ID = 'receipt-demo-002';

/** needs_review=1 — trips the "item needs review" uncertainty condition. */
export const DEMO_RI_1_ID = 'ri-demo-001';

// Transaction IDs must match reconciliation/stub.ts
export const DEMO_TXN_1_ID = 'txn-demo-001';
export const DEMO_TXN_2_ID = 'txn-demo-002';
/** No match row — trips the "unmatched transaction" uncertainty condition. */
export const DEMO_TXN_3_ID = 'txn-demo-003';

// Match IDs must match reconciliation/stub.ts
export const DEMO_MATCH_1_ID = 'match-demo-001';
export const DEMO_MATCH_2_ID = 'match-demo-002';
export const DEMO_MATCH_3_ID = 'match-demo-003';

export interface DemoSeedResult {
  householdId: string;
  accountId: string;
  transactionCount: number;
  receiptCount: number;
  receiptItemCount: number;
  orderCount: number;
  orderItemCount: number;
  matchCount: number;
}

/**
 * Seed the curated synthetic demo household into `db`.
 *
 * The seed is idempotent — every insert uses onConflictDoNothing on the PK,
 * so re-running against an already-seeded DB leaves row counts unchanged.
 *
 * The demo data includes one example of each of the four uncertainty
 * conditions so the queue is non-empty on first load:
 *   1. receipt_items.needs_review = 1  (ri-demo-001)
 *   2. ambiguous match candidates      (txn-demo-002 has two pending matches)
 *   3. unmatched transaction            (txn-demo-003 has no match row)
 *   4. receipt arithmetic mismatch     (receipt-demo-002: subtotal+tax ≠ total)
 */
export async function seedDemoHousehold(db: FinanceDb): Promise<DemoSeedResult> {
  // 1. Household — the anchor for all FK chains
  await db
    .insert(households)
    .values({ id: DEMO_HOUSEHOLD_ID, name: 'Demo Household' })
    .onConflictDoNothing();

  // 2. Account — transactions reference this
  await db
    .insert(accounts)
    .values({
      id: DEMO_ACCOUNT_ID,
      householdId: DEMO_HOUSEHOLD_ID,
      name: 'Demo Checking',
      type: 'checking',
      institution: 'Demo Bank',
    })
    .onConflictDoNothing();

  // 3. Orders (before order_items)
  await db
    .insert(orders)
    .values([
      {
        id: DEMO_ORDER_1_ID,
        householdId: DEMO_HOUSEHOLD_ID,
        source: 'amazon',
        externalOrderId: 'AMZN-DEMO-001',
        orderDate: '2025-01-15',
        currency: 'USD',
        orderTotalCents: 1200,
      },
      {
        id: DEMO_ORDER_2_ID,
        householdId: DEMO_HOUSEHOLD_ID,
        source: 'amazon',
        externalOrderId: 'AMZN-DEMO-002',
        orderDate: '2025-01-19',
        currency: 'USD',
        orderTotalCents: 4999,
      },
    ])
    .onConflictDoNothing();

  // 4. Order items
  await db
    .insert(orderItems)
    .values([
      {
        id: DEMO_OI_1_ID,
        orderId: DEMO_ORDER_1_ID,
        shipmentId: 'ship-demo-001',
        itemSeq: 1,
        description: 'Organic Apples 3lb Bag',
        quantity: 1,
        unitPriceCents: 1200,
        amountCents: 1200,
        isReturn: false,
        sourceRowHash: sha256Hex(DEMO_OI_1_ID),
      },
      {
        id: DEMO_OI_2_ID,
        orderId: DEMO_ORDER_2_ID,
        shipmentId: 'ship-demo-002',
        itemSeq: 1,
        description: 'USB-C Charging Cable',
        quantity: 1,
        unitPriceCents: 4999,
        amountCents: 4999,
        isReturn: false,
        sourceRowHash: sha256Hex(DEMO_OI_2_ID),
      },
    ])
    .onConflictDoNothing();

  // 5. Receipts (before receipt_items)
  // receipt-demo-001: arithmetic OK, but has a needs_review item (uncertainty type 1)
  // receipt-demo-002: 1800+220=2020 ≠ 2000 — arithmetic mismatch (uncertainty type 4)
  await db
    .insert(receipts)
    .values([
      {
        id: DEMO_RECEIPT_1_ID,
        householdId: DEMO_HOUSEHOLD_ID,
        source: 'vision',
        store: 'Best Buy',
        purchasedAt: '2025-01-20',
        subtotalCents: 4699,
        taxCents: 300,
        totalCents: 4999,
        needsReview: false,
      },
      {
        id: DEMO_RECEIPT_2_ID,
        householdId: DEMO_HOUSEHOLD_ID,
        source: 'vision',
        store: 'Corner Market',
        purchasedAt: '2025-01-14',
        subtotalCents: 1800,
        taxCents: 220,
        // 1800 + 220 = 2020 ≠ 2000 — arithmetic mismatch drives uncertainty type 4
        totalCents: 2000,
        needsReview: false,
      },
    ])
    .onConflictDoNothing();

  // 6. Receipt items — ri-demo-001 has needs_review=1 (uncertainty type 1)
  await db
    .insert(receiptItems)
    .values([
      {
        id: DEMO_RI_1_ID,
        receiptId: DEMO_RECEIPT_1_ID,
        lineNo: 1,
        rawDescription: 'Wireless Headphones',
        quantity: 1,
        linePriceCents: 4999,
        needsReview: true,
      },
    ])
    .onConflictDoNothing();

  // 7. Transactions — fixed sourceRowHash = sha256Hex(txnId), dedupKey derived
  // from fixed fields so both are deterministic and unique across runs.
  const txn1SourceHash = sha256Hex(DEMO_TXN_1_ID);
  const txn2SourceHash = sha256Hex(DEMO_TXN_2_ID);
  const txn3SourceHash = sha256Hex(DEMO_TXN_3_ID);

  await db
    .insert(transactions)
    .values([
      {
        id: DEMO_TXN_1_ID,
        accountId: DEMO_ACCOUNT_ID,
        postedDate: '2025-01-15',
        amountCents: -1200,
        direction: 'debit',
        normalizedMerchant: 'AMAZON',
        sourceRowHash: txn1SourceHash,
        dedupKey: transactionDedupKey({
          accountId: DEMO_ACCOUNT_ID,
          postedDate: '2025-01-15',
          amountCents: -1200,
          normalizedMerchant: 'AMAZON',
          sourceRowHash: txn1SourceHash,
        }),
      },
      {
        id: DEMO_TXN_2_ID,
        accountId: DEMO_ACCOUNT_ID,
        postedDate: '2025-01-20',
        amountCents: -4999,
        direction: 'debit',
        normalizedMerchant: 'BEST BUY',
        sourceRowHash: txn2SourceHash,
        dedupKey: transactionDedupKey({
          accountId: DEMO_ACCOUNT_ID,
          postedDate: '2025-01-20',
          amountCents: -4999,
          normalizedMerchant: 'BEST BUY',
          sourceRowHash: txn2SourceHash,
        }),
      },
      {
        id: DEMO_TXN_3_ID,
        accountId: DEMO_ACCOUNT_ID,
        postedDate: '2025-02-10',
        amountCents: -8750,
        direction: 'debit',
        normalizedMerchant: 'WHOLE FOODS',
        sourceRowHash: txn3SourceHash,
        dedupKey: transactionDedupKey({
          accountId: DEMO_ACCOUNT_ID,
          postedDate: '2025-02-10',
          amountCents: -8750,
          normalizedMerchant: 'WHOLE FOODS',
          sourceRowHash: txn3SourceHash,
        }),
      },
    ])
    .onConflictDoNothing();

  // 8. Matches — must be inserted after all referenced rows exist
  // match-demo-001: txn-001 → oi-001, status='matched' (confirmed)
  // match-demo-002: txn-002 → ri-001, status='pending' (ambiguous candidate A)
  // match-demo-003: txn-002 → oi-002, status='pending' (ambiguous candidate B)
  // txn-demo-003 has no match row (uncertainty type 3: unmatched)
  await db
    .insert(matches)
    .values([
      {
        id: DEMO_MATCH_1_ID,
        transactionId: DEMO_TXN_1_ID,
        orderItemId: DEMO_OI_1_ID,
        receiptItemId: null,
        status: 'matched',
        confidence: 0.97,
        method: 'exact_amount',
      },
      {
        id: DEMO_MATCH_2_ID,
        transactionId: DEMO_TXN_2_ID,
        orderItemId: null,
        receiptItemId: DEMO_RI_1_ID,
        status: 'pending',
        confidence: 0.68,
        method: 'fuzzy_merchant',
      },
      {
        id: DEMO_MATCH_3_ID,
        transactionId: DEMO_TXN_2_ID,
        orderItemId: DEMO_OI_2_ID,
        receiptItemId: null,
        status: 'pending',
        confidence: 0.54,
        method: 'fuzzy_merchant',
      },
    ])
    .onConflictDoNothing();

  // 9. Run the real reconciliation pipeline over the seeded raw sources and
  // persist the result. This is what gives the demo household REAL, DB-backed
  // item-level rollups: the engine matches receipt-demo-001 ↔ txn-demo-002 and
  // order-demo-001 ↔ txn-demo-001, classifies the merged items, and the sink
  // stamps receipt_items.category_id + writes the engine's match rows.
  //
  // Inputs are built deterministically from the same constants seeded above
  // (offline; no DB round-trip / no Date.now / no Math.random), using the frozen
  // reconcile-model sign convention (bank debits negative).
  const reconcileInputs: ReconcileInputs = {
    householdId: DEMO_HOUSEHOLD_ID,
    bankLines: [
      {
        id: DEMO_TXN_1_ID,
        accountId: DEMO_ACCOUNT_ID,
        postedDate: '2025-01-15',
        amountCents: -1200,
        direction: 'debit',
        normalizedMerchant: 'AMAZON',
      },
      {
        id: DEMO_TXN_2_ID,
        accountId: DEMO_ACCOUNT_ID,
        postedDate: '2025-01-20',
        amountCents: -4999,
        direction: 'debit',
        normalizedMerchant: 'BEST BUY',
      },
      {
        id: DEMO_TXN_3_ID,
        accountId: DEMO_ACCOUNT_ID,
        postedDate: '2025-02-10',
        amountCents: -8750,
        direction: 'debit',
        normalizedMerchant: 'WHOLE FOODS',
      },
    ],
    orders: [
      {
        id: DEMO_ORDER_1_ID,
        externalOrderId: 'AMZN-DEMO-001',
        orderDate: '2025-01-15',
        orderTotalCents: 1200,
        items: [
          {
            id: DEMO_OI_1_ID,
            shipmentId: 'ship-demo-001',
            description: 'Organic Apples 3lb Bag',
            amountCents: 1200,
            isReturn: false,
          },
        ],
      },
      {
        id: DEMO_ORDER_2_ID,
        externalOrderId: 'AMZN-DEMO-002',
        orderDate: '2025-01-19',
        orderTotalCents: 4999,
        items: [
          {
            id: DEMO_OI_2_ID,
            shipmentId: 'ship-demo-002',
            description: 'USB-C Charging Cable',
            amountCents: 4999,
            isReturn: false,
          },
        ],
      },
    ],
    receipts: [
      {
        id: DEMO_RECEIPT_1_ID,
        merchant: 'Best Buy',
        capturedAt: '2025-01-20',
        totalCents: 4999,
        items: [
          {
            id: DEMO_RI_1_ID,
            description: 'Wireless Headphones',
            amountCents: 4999,
          },
        ],
      },
      {
        id: DEMO_RECEIPT_2_ID,
        merchant: 'Corner Market',
        capturedAt: '2025-01-14',
        totalCents: 2000,
        items: [],
      },
    ],
    storeCreditAccruals: [],
  };

  const ledger = reconcile(reconcileInputs);
  await new DrizzleReconcileSink(db).persist(DEMO_HOUSEHOLD_ID, ledger);

  // Derive actual counts by querying the specific IDs we attempted to insert.
  // onConflictDoNothing preserves pre-existing rows, so these counts reflect
  // actual DB state — they equal the expected values on a first run and the
  // same values on re-runs (idempotent inserts, same rows present).
  const [txnR] = await db
    .select({ c: count() })
    .from(transactions)
    .where(inArray(transactions.id, [DEMO_TXN_1_ID, DEMO_TXN_2_ID, DEMO_TXN_3_ID]));
  const [rcptR] = await db
    .select({ c: count() })
    .from(receipts)
    .where(inArray(receipts.id, [DEMO_RECEIPT_1_ID, DEMO_RECEIPT_2_ID]));
  const [riR] = await db
    .select({ c: count() })
    .from(receiptItems)
    .where(inArray(receiptItems.id, [DEMO_RI_1_ID]));
  const [orderR] = await db
    .select({ c: count() })
    .from(orders)
    .where(inArray(orders.id, [DEMO_ORDER_1_ID, DEMO_ORDER_2_ID]));
  const [oiR] = await db
    .select({ c: count() })
    .from(orderItems)
    .where(inArray(orderItems.id, [DEMO_OI_1_ID, DEMO_OI_2_ID]));
  const [matchR] = await db
    .select({ c: count() })
    .from(matches)
    .where(inArray(matches.id, [DEMO_MATCH_1_ID, DEMO_MATCH_2_ID, DEMO_MATCH_3_ID]));

  return {
    householdId: DEMO_HOUSEHOLD_ID,
    accountId: DEMO_ACCOUNT_ID,
    transactionCount: txnR?.c ?? 0,
    receiptCount: rcptR?.c ?? 0,
    receiptItemCount: riR?.c ?? 0,
    orderCount: orderR?.c ?? 0,
    orderItemCount: oiR?.c ?? 0,
    matchCount: matchR?.c ?? 0,
  };
}
