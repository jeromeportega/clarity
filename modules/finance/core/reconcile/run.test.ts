/**
 * reconcileHousehold — the runtime entry point: DB → reconcile() → DB.
 *
 * Against a real (throwaway) libSQL database, through the same read layer the
 * app uses (LiveReconciliationGateway, assembleQueue): a photographed receipt
 * and the bank line that paid for it become `matched` rows and categorised
 * items; running again changes nothing; a retracted match disappears and its
 * dollars stop counting; a below-threshold match is ONE candidate the human
 * can settle, and once settled it is honoured, categorised and counted.
 */
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type FinanceDb } from '../../db/client';
import { TAXONOMY_IDS } from '../../db/taxonomy';
import { accounts, households, matches, receiptItems, receipts, transactions } from '../../db/schema';
import { applyCorrection } from '../corrections/apply';
import { assembleQueue } from '../queue/assemble';
import { LiveReconciliationGateway } from '../reconciliation/live';
import type { HouseholdScope } from '../scope';
import { reconcileHousehold } from './run';
import { DrizzleReconcileSink, ENGINE_MATCH_ID_PREFIX, type ReconcileSink } from './sink';

const HH = 'hh-run';
const SCOPE: HouseholdScope = { householdId: HH };
const TXN = 'txn-run-1';
const RECEIPT = 'rcpt-run-1';
const RI_HUMAN = 'ri-run-human';
const RI_BLANK = 'ri-run-blank';

let db: FinanceDb;
let cleanup: () => void;

async function seedHousehold(): Promise<void> {
  await db.insert(households).values({ id: HH, name: 'Run' });
  await db.insert(accounts).values({ id: 'acct-run', householdId: HH, name: 'Checking' });
}

async function seedTransaction(id: string, amountCents: number, postedDate: string, merchant = 'COSTCO'): Promise<void> {
  await db.insert(transactions).values({
    id, accountId: 'acct-run', postedDate, amountCents, direction: amountCents > 0 ? 'credit' : 'debit',
    normalizedMerchant: merchant, sourceRowHash: id, dedupKey: id,
  });
}

/** A COSTCO receipt with a human-categorised paper-towel line and an uncategorised banana line. */
async function seedReceipt(
  id: string,
  totalCents: number,
  purchasedAt: string,
  items: Array<{ id: string; name: string; cents: number; discount?: number; categoryId?: string | null }>,
): Promise<void> {
  await db.insert(receipts).values({ id, householdId: HH, source: 'photo', store: 'COSTCO', purchasedAt, totalCents });
  await db.insert(receiptItems).values(
    items.map((i, idx) => ({
      id: i.id, receiptId: id, lineNo: idx + 1, rawDescription: i.name.toUpperCase(), canonicalName: i.name,
      categoryId: i.categoryId ?? null, categoryConfidence: i.categoryId ? 1.0 : null,
      quantity: 1, linePriceCents: i.cents, discountCents: i.discount ?? 0,
    })),
  );
}

async function seedStandardPair(): Promise<void> {
  await seedTransaction(TXN, -2599, '2025-03-02');
  await seedReceipt(RECEIPT, 2599, '2025-03-02', [
    { id: RI_HUMAN, name: 'Kirkland Paper Towels', cents: 1999, categoryId: 'household' },
    { id: RI_BLANK, name: 'Organic Bananas', cents: 600 },
  ]);
}

async function matchRowsFor(transactionId: string) {
  return db.select().from(matches).where(eq(matches.transactionId, transactionId)).orderBy(matches.id);
}

async function categoryOf(itemId: string): Promise<string | null> {
  const rows = await db.select({ categoryId: receiptItems.categoryId }).from(receiptItems).where(eq(receiptItems.id, itemId));
  return rows[0]!.categoryId;
}

async function countedCents(month = '2025-03'): Promise<number> {
  const rollups = await new LiveReconciliationGateway(db).getRollups(SCOPE, { month });
  return rollups.reduce((sum, r) => sum + r.netCents, 0);
}

describe('reconcileHousehold', () => {
  beforeEach(async () => {
    ({ db, cleanup } = createTestDb());
    await seedHousehold();
  });
  afterEach(() => cleanup());

  it('matches the receipt to the bank line that paid for it and reports what it did', async () => {
    await seedStandardPair();
    const summary = await reconcileHousehold(db, HH);

    expect(summary.householdId).toBe(HH);
    expect(summary.inputs).toEqual({ bankLines: 1, orders: 0, receipts: 1, storeCreditAccruals: 0, confirmedMatches: 0 });
    expect(summary.matched).toBe(1);
    expect(summary.review).toBe(0);
    expect(summary.unmatched).toEqual({ bankLines: 0, orderItems: 0, receipts: 0 });
    expect(summary.netSpendCents).toBe(2599);

    const rows = await matchRowsFor(TXN);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.id.startsWith(ENGINE_MATCH_ID_PREFIX)).toBe(true);
      expect(r.status).toBe('matched');
      expect(r.method).toBe('receipt_bank');
      expect(r.receiptId).toBe(RECEIPT);
    }
    expect(new Set(rows.map((r) => r.receiptItemId))).toEqual(new Set([RI_HUMAN, RI_BLANK]));
  });

  it('fills in a category only where there is none — a human’s (or the resolver’s) category is never overwritten', async () => {
    await seedStandardPair();
    await reconcileHousehold(db, HH);

    const blank = await categoryOf(RI_BLANK);
    expect(blank).not.toBeNull();
    expect(TAXONOMY_IDS).toContain(blank);
    expect(await categoryOf(RI_HUMAN)).toBe('household');
  });

  it('a matched receipt’s lines are counted dollars in True Spend — net of their discounts', async () => {
    await seedTransaction(TXN, -2099, '2025-03-02');
    await seedReceipt(RECEIPT, 2099, '2025-03-02', [
      { id: RI_HUMAN, name: 'Kirkland Paper Towels', cents: 1999, discount: 500, categoryId: 'household' },
      { id: RI_BLANK, name: 'Organic Bananas', cents: 600 },
    ]);
    await reconcileHousehold(db, HH);

    // 1999 − 500 + 600 = 2099, i.e. exactly what the bank line paid.
    expect(await countedCents()).toBe(-2099);
  });

  it('is idempotent: a second run adds no rows and changes no categories', async () => {
    await seedStandardPair();
    const first = await reconcileHousehold(db, HH);
    const rowsAfterFirst = await matchRowsFor(TXN);
    const blankAfterFirst = await categoryOf(RI_BLANK);

    const second = await reconcileHousehold(db, HH);

    expect(second).toEqual(first);
    expect(await matchRowsFor(TXN)).toEqual(rowsAfterFirst);
    expect(await categoryOf(RI_BLANK)).toBe(blankAfterFirst);
    expect(await categoryOf(RI_HUMAN)).toBe('household');
  });

  it('a match the engine retracts is deleted, and its dollars stop counting — one bank line, one receipt', async () => {
    // Run 1: a near-miss receipt (50¢ short, a day early) is the best the engine has.
    await seedTransaction(TXN, -2599, '2025-03-02');
    await seedReceipt('rcpt-near', 2549, '2025-03-01', [{ id: 'ri-near', name: 'Organic Bananas', cents: 2549 }]);
    await reconcileHousehold(db, HH);
    expect((await matchRowsFor(TXN)).map((r) => r.receiptId)).toEqual(['rcpt-near']);
    expect(await countedCents()).toBe(-2549);

    // Run 2: the exact receipt arrives (the digital copy, say) and outscores it.
    await seedReceipt(RECEIPT, 2599, '2025-03-02', [
      { id: RI_HUMAN, name: 'Kirkland Paper Towels', cents: 1999, categoryId: 'household' },
      { id: RI_BLANK, name: 'Organic Bananas', cents: 600 },
    ]);
    const summary = await reconcileHousehold(db, HH);

    expect(summary.matched).toBe(1);
    expect(summary.unmatched.receipts).toBe(1);
    const rows = await matchRowsFor(TXN);
    expect(new Set(rows.map((r) => r.receiptId))).toEqual(new Set([RECEIPT]));
    expect(rows.some((r) => r.receiptItemId === 'ri-near')).toBe(false);
    // The near-miss keeps its category but is no longer a counted dollar.
    expect(await categoryOf('ri-near')).not.toBeNull();
    expect(await countedCents()).toBe(-2599);
    expect((await new LiveReconciliationGateway(db).listMatches(SCOPE)).filter((m) => m.transactionId === TXN && m.status === 'confirmed'))
      .toHaveLength(2);
  });

  describe('a below-threshold match', () => {
    // Same merchant, 1000¢ apart, 3 days apart: passes every gate, scores 0.55 < 0.70.
    async function seedWeakPair(): Promise<void> {
      await seedTransaction(TXN, -3599, '2025-03-05');
      await seedReceipt(RECEIPT, 2599, '2025-03-02', [
        { id: RI_HUMAN, name: 'Kirkland Paper Towels', cents: 1999, categoryId: 'household' },
        { id: RI_BLANK, name: 'Organic Bananas', cents: 600 },
      ]);
    }

    it('persists as ONE candidate row naming the receipt, and the queue shows one candidate', async () => {
      await seedWeakPair();
      const summary = await reconcileHousehold(db, HH);

      expect(summary.review).toBe(1);
      expect(summary.matched).toBe(0);
      const rows = await matchRowsFor(TXN);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'pending', receiptId: RECEIPT, orderId: null, receiptItemId: null, orderItemId: null });

      const queue = await assembleQueue(SCOPE, new LiveReconciliationGateway(db), db);
      const ambiguous = queue.filter((q) => q.type === 'ambiguous_match');
      expect(ambiguous).toHaveLength(1);
      expect(ambiguous[0]!.reason).toBe('Ambiguous match: 1 candidate for transaction');
      // Not yet a counted dollar, and no category was guessed for it.
      expect(await countedCents()).toBe(0);
      expect(await categoryOf(RI_BLANK)).toBeNull();
    });

    it('once a human confirms it, the next run honours the decision: linked, categorised, counted', async () => {
      await seedWeakPair();
      await reconcileHousehold(db, HH);
      const gw = new LiveReconciliationGateway(db);

      await applyCorrection(SCOPE, { id: TXN, type: 'ambiguous_match', reason: '' }, { type: 'confirm' }, gw, db);
      const manual = await db.select().from(matches).where(and(eq(matches.transactionId, TXN), eq(matches.status, 'manual')));
      expect(manual).toHaveLength(1);

      const summary = await reconcileHousehold(db, HH);

      expect(summary.inputs.confirmedMatches).toBe(1);
      expect(summary.matched).toBe(1);
      expect(summary.review).toBe(0);
      const rows = await matchRowsFor(TXN);
      // The human's row is untouched; the engine adds the item-level links.
      expect(rows.filter((r) => r.status === 'manual')).toEqual(manual);
      const engineRows = rows.filter((r) => r.status === 'matched');
      expect(new Set(engineRows.map((r) => r.receiptItemId))).toEqual(new Set([RI_HUMAN, RI_BLANK]));
      expect(engineRows.every((r) => r.confidence === 100 && r.rationale?.includes('confirmed by human'))).toBe(true);
      expect(rows.some((r) => r.status === 'rejected' || r.status === 'pending')).toBe(false);
      // …and the receipt is now categorised and counted.
      expect(await categoryOf(RI_BLANK)).not.toBeNull();
      expect(await categoryOf(RI_HUMAN)).toBe('household');
      expect(await countedCents()).toBe(-2599);
      expect(await assembleQueue(SCOPE, gw, db)).toEqual([]);
      // A further run changes nothing.
      const again = await reconcileHousehold(db, HH);
      expect(again).toEqual(summary);
      expect(await matchRowsFor(TXN)).toEqual(rows);
    });

    it('a decision stands even when the engine would now prefer another receipt', async () => {
      await seedWeakPair();
      await reconcileHousehold(db, HH);
      await applyCorrection(SCOPE, { id: TXN, type: 'ambiguous_match', reason: '' }, { type: 'confirm' }, new LiveReconciliationGateway(db), db);
      // An exact-amount receipt shows up later: without the decision it would win.
      await seedReceipt('rcpt-exact', 3599, '2025-03-05', [{ id: 'ri-exact', name: 'Something Else', cents: 3599 }]);

      const summary = await reconcileHousehold(db, HH);

      expect(summary.matched).toBe(1);
      expect(summary.unmatched.receipts).toBe(1);
      expect(new Set((await matchRowsFor(TXN)).map((r) => r.receiptId))).toEqual(new Set([RECEIPT]));
      expect(await countedCents()).toBe(-2599);
    });
  });

  it('never touches a human’s rows, whatever their id', async () => {
    await seedStandardPair();
    await reconcileHousehold(db, HH);
    await db.insert(matches).values({
      id: `${ENGINE_MATCH_ID_PREFIX}looks-like-ours`, transactionId: TXN, receiptId: RECEIPT, status: 'rejected', confidence: 10, method: 'receipt_bank',
    });

    await reconcileHousehold(db, HH);

    const rejected = await db.select().from(matches).where(eq(matches.id, `${ENGINE_MATCH_ID_PREFIX}looks-like-ours`));
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.status).toBe('rejected');
  });

  it('an unreadable-photo placeholder is never matched to anything', async () => {
    await seedStandardPair();
    await db.insert(receipts).values({
      id: 'rcpt-placeholder', householdId: HH, source: 'photo', store: '', purchasedAt: '', totalCents: 0, needsReview: true,
    });
    await seedTransaction('txn-zero', 0, '2025-03-03', '');

    const summary = await reconcileHousehold(db, HH);

    expect(summary.matched).toBe(1); // still just the real receipt
    expect(await matchRowsFor('txn-zero')).toEqual([]);
    expect(summary.unmatched.receipts).toBe(1);
  });

  describe('concurrency', () => {
    it('two runs racing on one shared handle both succeed, and the handle keeps working afterwards', async () => {
      await seedStandardPair();

      const [a, b] = await Promise.all([reconcileHousehold(db, HH), reconcileHousehold(db, HH)]);
      expect(a.matched).toBe(1);
      expect(b.matched).toBe(1);
      expect(await matchRowsFor(TXN)).toHaveLength(2);

      // The handle is not poisoned: a later run still lands.
      const c = await reconcileHousehold(db, HH);
      expect(c).toEqual(a);
    });

    it('a burst of runs coalesces: every caller gets a result, and the last run sees the newest data', async () => {
      await seedTransaction(TXN, -2599, '2025-03-02');
      const first = reconcileHousehold(db, HH);
      // Arrivals while the first run is in flight wait for it and then run once
      // over whatever is in the database by then.
      await seedReceipt(RECEIPT, 2599, '2025-03-02', [
        { id: RI_HUMAN, name: 'Kirkland Paper Towels', cents: 1999, categoryId: 'household' },
        { id: RI_BLANK, name: 'Organic Bananas', cents: 600 },
      ]);
      const [r1, r2, r3] = await Promise.all([first, reconcileHousehold(db, HH), reconcileHousehold(db, HH)]);

      expect(r1.inputs.bankLines).toBe(1);
      expect(r2).toEqual(r3);
      expect(r3.inputs.receipts).toBe(1);
      expect(r3.matched).toBe(1);
      expect(await matchRowsFor(TXN)).toHaveLength(2);
    });

    it('a run that loses the database lock is retried whole and then succeeds', async () => {
      await seedStandardPair();
      const real = new DrizzleReconcileSink(db);
      let attempts = 0;
      const flaky: ReconcileSink = {
        async persist(householdId, ledger) {
          attempts += 1;
          if (attempts === 1) throw Object.assign(new Error('SQLITE_BUSY: database is locked'), { code: 'SQLITE_BUSY' });
          await real.persist(householdId, ledger);
        },
      };
      const slept: number[] = [];

      const summary = await reconcileHousehold(db, HH, { sink: flaky, retryDelaysMs: [1, 2], sleep: async (ms) => { slept.push(ms); } });

      expect(summary.matched).toBe(1);
      expect(attempts).toBe(2);
      expect(slept).toEqual([1]);
      expect(await matchRowsFor(TXN)).toHaveLength(2);
    });

    it('any other failure is not retried, and the household is free for the next run', async () => {
      await seedStandardPair();
      const broken: ReconcileSink = { async persist() { throw new Error('disk on fire'); } };

      await expect(reconcileHousehold(db, HH, { sink: broken, retryDelaysMs: [1], sleep: async () => {} })).rejects.toThrow('disk on fire');
      expect((await reconcileHousehold(db, HH)).matched).toBe(1);
    });
  });

  it('a household with nothing to reconcile runs cleanly', async () => {
    await db.insert(households).values({ id: 'hh-none', name: 'None' });
    const summary = await reconcileHousehold(db, 'hh-none');
    expect(summary.matched).toBe(0);
    expect(summary.netSpendCents).toBe(0);
  });
});
