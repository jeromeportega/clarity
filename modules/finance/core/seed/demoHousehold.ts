import { DEMO_HOUSEHOLD_ID } from '../scope';
import { sha256Hex, transactionDedupKey } from '../idempotency/keys';
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
        totalCents: 2000,
        needsReview: true,
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
        normalizedMerchant: 'WHOLE FOODS',
        sourceRowHash: txn1SourceHash,
        dedupKey: transactionDedupKey({
          accountId: DEMO_ACCOUNT_ID,
          postedDate: '2025-01-15',
          amountCents: -1200,
          normalizedMerchant: 'WHOLE FOODS',
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

  return {
    householdId: DEMO_HOUSEHOLD_ID,
    accountId: DEMO_ACCOUNT_ID,
    transactionCount: 3,
    receiptCount: 2,
    receiptItemCount: 1,
    orderCount: 2,
    orderItemCount: 2,
    matchCount: 3,
  };
}
