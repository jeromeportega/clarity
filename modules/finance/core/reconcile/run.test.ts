/**
 * reconcileHousehold — the runtime entry point: DB → reconcile() → DB.
 *
 * Against a real (throwaway) libSQL database: a photographed receipt and the
 * bank line that paid for it become a `matched` row and a categorised item;
 * running again changes nothing; and a re-run can neither overwrite a
 * category a human (or the resolver) set nor re-open a transaction a human
 * has settled.
 */
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type FinanceDb } from '../../db/client';
import { TAXONOMY_IDS } from '../../db/taxonomy';
import { accounts, households, matches, receiptItems, receipts, transactions } from '../../db/schema';
import type { ReconciledLedger } from './model';
import { reconcileHousehold } from './run';
import { DrizzleReconcileSink } from './sink';

const HH = 'hh-run';
const TXN = 'txn-run-1';
const RECEIPT = 'rcpt-run-1';
const RI_HUMAN = 'ri-run-human';
const RI_BLANK = 'ri-run-blank';

let db: FinanceDb;
let cleanup: () => void;

async function seed(): Promise<void> {
  await db.insert(households).values({ id: HH, name: 'Run' });
  await db.insert(accounts).values({ id: 'acct-run', householdId: HH, name: 'Checking' });
  await db.insert(transactions).values({
    id: TXN, accountId: 'acct-run', postedDate: '2025-03-02', amountCents: -2599,
    direction: 'debit', normalizedMerchant: 'COSTCO', sourceRowHash: 'r1', dedupKey: 'r1',
  });
  await db.insert(receipts).values({
    id: RECEIPT, householdId: HH, source: 'photo', store: 'COSTCO', purchasedAt: '2025-03-02', totalCents: 2599,
  });
  await db.insert(receiptItems).values([
    {
      id: RI_HUMAN, receiptId: RECEIPT, lineNo: 1, rawDescription: 'KS PAPER TOWEL', canonicalName: 'Kirkland Paper Towels',
      categoryId: 'household', categoryConfidence: 1.0, quantity: 1, linePriceCents: 1999,
    },
    {
      id: RI_BLANK, receiptId: RECEIPT, lineNo: 2, rawDescription: 'ORG BANANAS', canonicalName: 'Organic Bananas',
      categoryId: null, quantity: 1, linePriceCents: 600,
    },
  ]);
}

async function matchRowsFor(transactionId: string) {
  return db.select().from(matches).where(eq(matches.transactionId, transactionId));
}

async function categoryOf(itemId: string): Promise<string | null> {
  const rows = await db.select({ categoryId: receiptItems.categoryId }).from(receiptItems).where(eq(receiptItems.id, itemId));
  return rows[0]!.categoryId;
}

describe('reconcileHousehold', () => {
  beforeEach(async () => {
    ({ db, cleanup } = createTestDb());
    await seed();
  });
  afterEach(() => cleanup());

  it('matches the receipt to the bank line that paid for it and reports what it did', async () => {
    const summary = await reconcileHousehold(db, HH);

    expect(summary.householdId).toBe(HH);
    expect(summary.inputs).toEqual({ bankLines: 1, orders: 0, receipts: 1, storeCreditAccruals: 0 });
    expect(summary.matched).toBe(1);
    expect(summary.unmatched).toEqual({ bankLines: 0, orderItems: 0, receipts: 0 });
    expect(summary.netSpendCents).toBe(2599);

    const rows = await matchRowsFor(TXN);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.status === 'matched' && r.method === 'receipt_bank')).toBe(true);
    expect(new Set(rows.map((r) => r.receiptItemId))).toEqual(new Set([RI_HUMAN, RI_BLANK]));
  });

  it('fills in a category only where there is none — a human’s (or the resolver’s) category is never overwritten', async () => {
    await reconcileHousehold(db, HH);

    const blank = await categoryOf(RI_BLANK);
    expect(blank).not.toBeNull();
    expect(TAXONOMY_IDS).toContain(blank);
    expect(await categoryOf(RI_HUMAN)).toBe('household');
  });

  it('is idempotent: a second run adds no rows and changes no categories', async () => {
    const first = await reconcileHousehold(db, HH);
    const rowsAfterFirst = await matchRowsFor(TXN);
    const blankAfterFirst = await categoryOf(RI_BLANK);

    const second = await reconcileHousehold(db, HH);

    expect(second).toEqual(first);
    expect(await matchRowsFor(TXN)).toEqual(rowsAfterFirst);
    expect(await categoryOf(RI_BLANK)).toBe(blankAfterFirst);
    expect(await categoryOf(RI_HUMAN)).toBe('household');
  });

  it('never re-opens a transaction a human has settled', async () => {
    await reconcileHousehold(db, HH);
    // The human picked a winner: every row for this transaction is now decided.
    await db.update(matches).set({ status: 'manual' }).where(eq(matches.transactionId, TXN));
    const settled = await matchRowsFor(TXN);

    // A later run finds a fresh below-threshold candidate for the same transaction…
    const ledger: ReconciledLedger = {
      events: [],
      matches: [],
      reviewQueue: [{
        id: 'fresh-candidate', type: 'receipt_bank', transactionId: TXN, receiptId: RECEIPT,
        confidence: 0.4, rationale: 'weak', status: 'review',
      }],
      storeCreditDrawdowns: [],
      unmatched: { bankLines: [], orderItems: [], receipts: [] },
      netSpendCents: 0,
    };
    await new DrizzleReconcileSink(db).persist(HH, ledger);

    // …and writes nothing for it: no new pending sibling, the manual rows untouched.
    expect(await matchRowsFor(TXN)).toEqual(settled);
    const pending = await db.select().from(matches).where(and(eq(matches.transactionId, TXN), eq(matches.status, 'pending')));
    expect(pending).toHaveLength(0);
  });

  it('an unreadable-photo placeholder is never matched to anything', async () => {
    await db.insert(receipts).values({
      id: 'rcpt-placeholder', householdId: HH, source: 'photo', store: '', purchasedAt: '', totalCents: 0, needsReview: true,
    });
    await db.insert(transactions).values({
      id: 'txn-zero', accountId: 'acct-run', postedDate: '2025-03-03', amountCents: 0,
      direction: 'debit', normalizedMerchant: '', sourceRowHash: 'z', dedupKey: 'z',
    });

    const summary = await reconcileHousehold(db, HH);

    expect(summary.matched).toBe(1); // still just the real receipt
    expect(await matchRowsFor('txn-zero')).toEqual([]);
    expect(summary.unmatched.receipts).toBe(1);
  });

  it('a household with nothing to reconcile runs cleanly', async () => {
    await db.insert(households).values({ id: 'hh-none', name: 'None' });
    const summary = await reconcileHousehold(db, 'hh-none');
    expect(summary.matched).toBe(0);
    expect(summary.netSpendCents).toBe(0);
  });
});
