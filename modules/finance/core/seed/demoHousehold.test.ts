import { asc, count, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type FinanceDb } from '../../db/client';
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
import {
  DEMO_ACCOUNT_ID,
  DEMO_HOUSEHOLD_ID,
  DEMO_MATCH_1_ID,
  DEMO_MATCH_2_ID,
  DEMO_MATCH_3_ID,
  DEMO_OI_1_ID,
  DEMO_OI_2_ID,
  DEMO_ORDER_1_ID,
  DEMO_ORDER_2_ID,
  DEMO_RECEIPT_1_ID,
  DEMO_RECEIPT_2_ID,
  DEMO_RI_1_ID,
  DEMO_TXN_1_ID,
  DEMO_TXN_2_ID,
  DEMO_TXN_3_ID,
  DemoSeedResult,
  seedDemoHousehold,
} from './demoHousehold';

let db: FinanceDb;
let cleanup: () => void;

beforeEach(async () => {
  const handle = createTestDb();
  db = handle.db;
  cleanup = handle.cleanup;
  await db.run(sql`PRAGMA foreign_keys = ON`);
});

afterEach(() => cleanup());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function rowCount(table: any): Promise<number> {
  const [r] = await db.select({ c: count() }).from(table);
  return r?.c ?? 0;
}

describe('seedDemoHousehold', () => {
  describe('demo household row', () => {
    it('creates exactly one households row with the fixed DEMO_HOUSEHOLD_ID', async () => {
      await seedDemoHousehold(db);

      const hh = await db.select().from(households);
      expect(hh).toHaveLength(1);
      expect(hh[0]?.id).toBe(DEMO_HOUSEHOLD_ID);
      expect(hh[0]?.name).toBe('Demo Household');
    });

    it('creates one account linked to the demo household', async () => {
      await seedDemoHousehold(db);

      const acct = await db
        .select()
        .from(accounts)
        .where(eq(accounts.householdId, DEMO_HOUSEHOLD_ID));
      expect(acct).toHaveLength(1);
      expect(acct[0]?.id).toBe(DEMO_ACCOUNT_ID);
    });
  });

  describe('receipts and matching bank lines', () => {
    it('seeds the expected row counts', async () => {
      await seedDemoHousehold(db);

      expect(await rowCount(transactions)).toBe(3);
      expect(await rowCount(receipts)).toBe(2);
      expect(await rowCount(receiptItems)).toBe(1);
      expect(await rowCount(orders)).toBe(2);
      expect(await rowCount(orderItems)).toBe(2);
      // The 3 curated matches PLUS engine-produced item-level matches from the
      // composed reconcile() run (the seed now persists real reconciliation
      // output). At least the 3 curated rows are always present.
      expect(await rowCount(matches)).toBeGreaterThanOrEqual(3);
    });

    it('returns the DemoSeedResult with accurate counts', async () => {
      const result: DemoSeedResult = await seedDemoHousehold(db);
      expect(result).toEqual({
        householdId: DEMO_HOUSEHOLD_ID,
        accountId: DEMO_ACCOUNT_ID,
        transactionCount: 3,
        receiptCount: 2,
        receiptItemCount: 1,
        orderCount: 2,
        orderItemCount: 2,
        matchCount: 3,
      });
    });

    it('at least one transaction is matched to an order/receipt item', async () => {
      await seedDemoHousehold(db);

      // txn-demo-001 → oi-demo-001 (status='matched') is the curated confirmed
      // pair; the engine adds its own order_bank match for the same pair too.
      const rows = await db
        .select()
        .from(matches)
        .where(eq(matches.transactionId, DEMO_TXN_1_ID));
      expect(rows.length).toBeGreaterThanOrEqual(1);
      const curated = rows.find((m) => m.id === DEMO_MATCH_1_ID);
      expect(curated).toBeDefined();
      expect(curated?.orderItemId).toBe(DEMO_OI_1_ID);
      expect(curated?.status).toBe('matched');
    });
  });

  describe('four uncertainty conditions', () => {
    it('type 1 — receipt item needs_review=1', async () => {
      await seedDemoHousehold(db);

      const flagged = await db
        .select()
        .from(receiptItems)
        .where(eq(receiptItems.needsReview, true));
      expect(flagged.length).toBeGreaterThanOrEqual(1);
      expect(flagged.some((ri) => ri.id === DEMO_RI_1_ID)).toBe(true);
    });

    it('type 2 — ambiguous match: same transaction has multiple pending candidates', async () => {
      await seedDemoHousehold(db);

      // txn-demo-002 has match-demo-002 (→ ri-001) and match-demo-003 (→ oi-002),
      // both with status='pending', modelling the ambiguous group from stub.ts.
      const pending = await db
        .select()
        .from(matches)
        .where(eq(matches.transactionId, DEMO_TXN_2_ID));
      const pendingRows = pending.filter((m) => m.status === 'pending');
      expect(pendingRows.length).toBeGreaterThanOrEqual(2);
      const ids = pendingRows.map((m) => m.id);
      expect(ids).toContain(DEMO_MATCH_2_ID);
      expect(ids).toContain(DEMO_MATCH_3_ID);
    });

    it('type 3 — unmatched transaction: txn-demo-003 has no match row', async () => {
      await seedDemoHousehold(db);

      const txn3Matches = await db
        .select()
        .from(matches)
        .where(eq(matches.transactionId, DEMO_TXN_3_ID));
      expect(txn3Matches).toHaveLength(0);
    });

    it('type 4 — receipt arithmetic mismatch: subtotal + tax ≠ total', async () => {
      await seedDemoHousehold(db);

      // receipt-demo-002: subtotal=1800, tax=220, total=2000 → 1800+220=2020 ≠ 2000
      const receipt2 = await db
        .select()
        .from(receipts)
        .where(eq(receipts.id, DEMO_RECEIPT_2_ID));
      expect(receipt2).toHaveLength(1);
      const r = receipt2[0]!;
      expect(r.subtotalCents! + r.taxCents!).not.toBe(r.totalCents);

      // At least one receipt in the demo household has bad arithmetic
      const allReceipts = await db
        .select()
        .from(receipts)
        .where(eq(receipts.householdId, DEMO_HOUSEHOLD_ID));
      const mismatched = allReceipts.filter(
        (rec) =>
          rec.subtotalCents !== null &&
          rec.taxCents !== null &&
          rec.subtotalCents + rec.taxCents !== rec.totalCents,
      );
      expect(mismatched.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('determinism and reproducibility', () => {
    it('is idempotent — re-running the seed does not add duplicate rows', async () => {
      await seedDemoHousehold(db);
      const matchesAfterFirst = await rowCount(matches);
      await seedDemoHousehold(db);

      expect(await rowCount(households)).toBe(1);
      expect(await rowCount(accounts)).toBe(1);
      expect(await rowCount(transactions)).toBe(3);
      expect(await rowCount(receipts)).toBe(2);
      expect(await rowCount(receiptItems)).toBe(1);
      expect(await rowCount(orders)).toBe(2);
      expect(await rowCount(orderItems)).toBe(2);
      // Engine match rows use deterministic ids + onConflictDoNothing, so the
      // second run adds nothing — count is stable across re-runs.
      expect(await rowCount(matches)).toBe(matchesAfterFirst);
    });

    it('two fresh DBs produce identical row sets (hard-coded IDs, dates, amounts)', async () => {
      // Seed into this test's DB (db1)
      await seedDemoHousehold(db);

      // Seed into a second independent DB
      const { db: db2, cleanup: cleanup2 } = createTestDb();
      try {
        await db2.run(sql`PRAGMA foreign_keys = ON`);
        await seedDemoHousehold(db2);

        const [txns1, txns2] = await Promise.all([
          db.select({
            id: transactions.id,
            postedDate: transactions.postedDate,
            amountCents: transactions.amountCents,
            direction: transactions.direction,
            normalizedMerchant: transactions.normalizedMerchant,
          }).from(transactions).orderBy(asc(transactions.id)),
          db2.select({
            id: transactions.id,
            postedDate: transactions.postedDate,
            amountCents: transactions.amountCents,
            direction: transactions.direction,
            normalizedMerchant: transactions.normalizedMerchant,
          }).from(transactions).orderBy(asc(transactions.id)),
        ]);
        expect(txns1).toEqual(txns2);

        const [rcpts1, rcpts2] = await Promise.all([
          db.select({
            id: receipts.id,
            store: receipts.store,
            totalCents: receipts.totalCents,
            subtotalCents: receipts.subtotalCents,
            taxCents: receipts.taxCents,
            needsReview: receipts.needsReview,
          }).from(receipts).orderBy(asc(receipts.id)),
          db2.select({
            id: receipts.id,
            store: receipts.store,
            totalCents: receipts.totalCents,
            subtotalCents: receipts.subtotalCents,
            taxCents: receipts.taxCents,
            needsReview: receipts.needsReview,
          }).from(receipts).orderBy(asc(receipts.id)),
        ]);
        expect(rcpts1).toEqual(rcpts2);

        const [mtchs1, mtchs2] = await Promise.all([
          db.select({
            id: matches.id,
            transactionId: matches.transactionId,
            orderItemId: matches.orderItemId,
            receiptItemId: matches.receiptItemId,
            status: matches.status,
            confidence: matches.confidence,
          }).from(matches).orderBy(asc(matches.id)),
          db2.select({
            id: matches.id,
            transactionId: matches.transactionId,
            orderItemId: matches.orderItemId,
            receiptItemId: matches.receiptItemId,
            status: matches.status,
            confidence: matches.confidence,
          }).from(matches).orderBy(asc(matches.id)),
        ]);
        expect(mtchs1).toEqual(mtchs2);
      } finally {
        cleanup2();
      }
    });
  });

  describe('stub alignment', () => {
    it('uses the same DEMO_HOUSEHOLD_ID as scope.ts', async () => {
      // Guard: the constant imported from this module must equal the one in scope.ts
      // so stub gateway and seeded DB agree on the household identity.
      const { DEMO_HOUSEHOLD_ID: scopeId } = await import('../scope');
      expect(DEMO_HOUSEHOLD_ID).toBe(scopeId);
    });

    it('seeded transaction IDs match the stub gateway IDs', async () => {
      await seedDemoHousehold(db);

      const txnIds = (await db.select({ id: transactions.id }).from(transactions))
        .map((r) => r.id)
        .sort();

      expect(txnIds).toContain(DEMO_TXN_1_ID);
      expect(txnIds).toContain(DEMO_TXN_2_ID);
      expect(txnIds).toContain(DEMO_TXN_3_ID);
    });

    it('seeded match IDs and statuses match the stub gateway data', async () => {
      await seedDemoHousehold(db);

      const matchRows = await db
        .select({ id: matches.id, status: matches.status })
        .from(matches)
        .orderBy(asc(matches.id));

      // The curated rows that mirror the stub gateway must be present with the
      // expected statuses (engine-produced rows are additive and ignored here).
      const curated = matchRows.filter((m) =>
        [DEMO_MATCH_1_ID, DEMO_MATCH_2_ID, DEMO_MATCH_3_ID].includes(m.id),
      );
      expect(curated).toEqual([
        { id: DEMO_MATCH_1_ID, status: 'matched' },
        { id: DEMO_MATCH_2_ID, status: 'pending' },
        { id: DEMO_MATCH_3_ID, status: 'pending' },
      ]);
    });
  });

  describe('public-safety boundary', () => {
    it('all household-scoped rows belong to the demo household only', async () => {
      await seedDemoHousehold(db);

      // Receipts
      const rcptHouseholds = await db
        .select({ householdId: receipts.householdId })
        .from(receipts);
      for (const r of rcptHouseholds) {
        expect(r.householdId).toBe(DEMO_HOUSEHOLD_ID);
      }

      // Orders
      const orderHouseholds = await db
        .select({ householdId: orders.householdId })
        .from(orders);
      for (const o of orderHouseholds) {
        expect(o.householdId).toBe(DEMO_HOUSEHOLD_ID);
      }

      // Accounts → household linkage covers transactions transitively
      const acctHouseholds = await db
        .select({ householdId: accounts.householdId })
        .from(accounts);
      for (const a of acctHouseholds) {
        expect(a.householdId).toBe(DEMO_HOUSEHOLD_ID);
      }
    });

    it('seeded data contains no real PII or secrets (IDs are synthetic demo values)', async () => {
      await seedDemoHousehold(db);

      // All IDs are prefixed with known demo prefixes — no real UUIDs, names, or PAN digits
      const txnRows = await db
        .select({ id: transactions.id, merchant: transactions.normalizedMerchant })
        .from(transactions);
      for (const t of txnRows) {
        expect(t.id).toMatch(/^txn-demo-/);
        // merchant names are generic, public-safe values
        expect(['AMAZON', 'BEST BUY', 'WHOLE FOODS']).toContain(t.merchant);
      }

      const rcptRows = await db
        .select({ id: receipts.id, paymentLast4: receipts.paymentLast4 })
        .from(receipts);
      for (const r of rcptRows) {
        expect(r.id).toMatch(/^receipt-demo-/);
        // No payment card data in the demo seed
        expect(r.paymentLast4).toBeNull();
      }
    });
  });
});
