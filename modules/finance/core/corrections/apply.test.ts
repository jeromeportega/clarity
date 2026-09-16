import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type FinanceDb } from '../../db/client';
import {
  accounts,
  households,
  matches,
  receiptItems,
  receipts,
  reviewDecisions,
  transactions,
} from '../../db/schema';
import { skuDictionary } from '../receipts/dictionary/schema';
import { assembleQueue } from '../queue/assemble';
import type {
  AmbiguousMatchGroup,
  HouseholdScope,
  Match,
  ReconciliationGateway,
  SpendRollup,
  Transaction,
} from '../reconciliation/types';
import type { QueueItem } from '../queue/types';
import { applyCorrection, CorrectionError } from './apply';

// ---------------------------------------------------------------------------
// Controlled gateway
// ---------------------------------------------------------------------------

class SpyGateway implements ReconciliationGateway {
  recomputeRollupsCalls: Array<{ scope: HouseholdScope; ids: string[] }> = [];
  recomputeError: Error | null = null;

  async listMatches(): Promise<Match[]> { return []; }
  async getAmbiguousMatchGroups(): Promise<AmbiguousMatchGroup[]> { return []; }
  async listUnmatchedTransactions(): Promise<Transaction[]> { return []; }
  async getRollups(): Promise<SpendRollup[]> { return []; }

  async recomputeRollups(scope: HouseholdScope, ids: string[]): Promise<void> {
    this.recomputeRollupsCalls.push({ scope, ids });
    if (this.recomputeError) throw this.recomputeError;
  }
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

const HH = 'test-household-corrections';
const OTHER_HH = 'other-household-corrections';
const SCOPE: HouseholdScope = { householdId: HH };

let db: FinanceDb;
let cleanup: () => void;
let gw: SpyGateway;

async function seedHouseholds(): Promise<void> {
  await db.insert(households).values([
    { id: HH, name: 'Test Household' },
    { id: OTHER_HH, name: 'Other Household' },
  ]);
  await db.insert(accounts).values([
    { id: `acct-${HH}`, householdId: HH, name: 'Checking' },
    { id: `acct-${OTHER_HH}`, householdId: OTHER_HH, name: 'Checking' },
  ]);
}

async function seedReceipt(
  opts: { householdId?: string; needsReview?: boolean; store?: string } = {},
): Promise<string> {
  const receiptId = `receipt-${randomUUID()}`;
  await db.insert(receipts).values({
    id: receiptId,
    householdId: opts.householdId ?? HH,
    source: 'manual',
    store: opts.store ?? 'COSTCO',
    purchasedAt: '2025-01-15',
    totalCents: 1000,
    needsReview: opts.needsReview ?? false,
  });
  return receiptId;
}

let lineNo = 0;

async function seedReceiptItem(
  opts: {
    householdId?: string;
    needsReview?: boolean;
    sku?: string | null;
    canonicalName?: string | null;
    rawDescription?: string;
    store?: string;
    receiptId?: string;
    categoryId?: string | null;
    nameConfidence?: number;
  } = {},
): Promise<{ receiptId: string; itemId: string }> {
  const receiptId = opts.receiptId
    ?? (await seedReceipt({ householdId: opts.householdId, store: opts.store }));
  const itemId = `ri-${randomUUID()}`;
  await db.insert(receiptItems).values({
    id: itemId,
    receiptId,
    lineNo: ++lineNo,
    sku: opts.sku ?? null,
    rawDescription: opts.rawDescription ?? 'KS EVOO',
    canonicalName: opts.canonicalName ?? null,
    categoryId: opts.categoryId ?? null,
    quantity: 1,
    linePriceCents: 1000,
    nameConfidence: opts.nameConfidence ?? 0.4,
    categoryConfidence: 0.3,
    needsReview: opts.needsReview ?? false,
  });
  return { receiptId, itemId };
}

async function seedTransaction(householdId = HH): Promise<string> {
  const txnId = `txn-${randomUUID()}`;
  await db.insert(transactions).values({
    id: txnId,
    accountId: `acct-${householdId}`,
    postedDate: '2025-01-16',
    amountCents: -1000,
    direction: 'debit',
    normalizedMerchant: 'COSTCO',
    sourceRowHash: txnId,
    dedupKey: txnId,
  });
  return txnId;
}

async function seedMatch(
  transactionId: string,
  opts: { confidence?: number | null; status?: 'pending' | 'matched' | 'rejected' | 'manual' } = {},
): Promise<string> {
  const matchId = `match-${randomUUID()}`;
  await db.insert(matches).values({
    id: matchId,
    transactionId,
    orderItemId: null,
    receiptItemId: null,
    status: opts.status ?? 'pending',
    confidence: opts.confidence === undefined ? 0.5 : opts.confidence,
    method: 'fuzzy_merchant',
  });
  return matchId;
}

function item(id: string, type: QueueItem['type']): QueueItem {
  return { id, type, reason: 'test', amountCents: 1000 };
}

async function readItem(itemId: string) {
  const rows = await db.select().from(receiptItems).where(eq(receiptItems.id, itemId));
  return rows[0]!;
}

async function readMatchStatus(matchId: string): Promise<string> {
  const rows = await db.select().from(matches).where(eq(matches.id, matchId));
  return rows[0]!.status;
}

async function readDecisions(itemId: string) {
  return db.select().from(reviewDecisions).where(eq(reviewDecisions.itemId, itemId));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('applyCorrection', () => {
  beforeEach(async () => {
    ({ db, cleanup } = createTestDb());
    await seedHouseholds();
    gw = new SpyGateway();
  });

  afterEach(() => cleanup());

  // -------------------------------------------------------------------------
  // confirm
  // -------------------------------------------------------------------------

  describe('confirm', () => {
    it('writes review_decisions row with decision=confirm, payloadJson=null', async () => {
      const { itemId } = await seedReceiptItem({ needsReview: true });

      const result = await applyCorrection(
        SCOPE, item(itemId, 'sku_resolution'), { type: 'confirm' }, gw, db,
      );

      expect(result.removedItemId).toBe(itemId);

      const rows = await readDecisions(itemId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.decision).toBe('confirm');
      expect(rows[0]!.payloadJson).toBeNull();
      expect(rows[0]!.householdId).toBe(HH);
    });

    it('sku_resolution: clears needs_review and vouches for both confidences when both halves exist', async () => {
      const { itemId } = await seedReceiptItem({
        needsReview: true,
        canonicalName: 'Kirkland Olive Oil',
        categoryId: 'groceries',
      });

      await applyCorrection(SCOPE, item(itemId, 'sku_resolution'), { type: 'confirm' }, gw, db);

      const row = await readItem(itemId);
      expect(row.needsReview).toBe(false);
      expect(row.nameConfidence).toBe(1);
      expect(row.categoryConfidence).toBe(1);
    });

    it('sku_resolution: vouches only for what exists — an unresolved item keeps its confidences', async () => {
      // A Costco import: raw description only, no canonical name, no category.
      const { itemId } = await seedReceiptItem({ needsReview: true, canonicalName: null, categoryId: null });

      await applyCorrection(SCOPE, item(itemId, 'sku_resolution'), { type: 'confirm' }, gw, db);

      const row = await readItem(itemId);
      expect(row.needsReview).toBe(false);
      expect(row.nameConfidence).toBe(0.4);
      expect(row.categoryConfidence).toBe(0.3);
      expect(row.canonicalName).toBeNull();
      expect(row.categoryId).toBeNull();
    });

    it('sku_resolution: a named but uncategorised item gets only its name vouched for', async () => {
      const { itemId } = await seedReceiptItem({ needsReview: true, canonicalName: 'Kirkland Olive Oil', categoryId: null });

      await applyCorrection(SCOPE, item(itemId, 'sku_resolution'), { type: 'confirm' }, gw, db);

      const row = await readItem(itemId);
      expect(row.nameConfidence).toBe(1);
      expect(row.categoryConfidence).toBe(0.3);
    });

    it('flagged_receipt: clears receipts.needs_review', async () => {
      const receiptId = await seedReceipt({ needsReview: true });

      await applyCorrection(SCOPE, item(receiptId, 'flagged_receipt'), { type: 'confirm' }, gw, db);

      const rows = await db.select().from(receipts).where(eq(receipts.id, receiptId));
      expect(rows[0]!.needsReview).toBe(false);
    });

    it('ambiguous_match: promotes the highest-confidence pending match, rejects the rest', async () => {
      const txnId = await seedTransaction();
      const weak = await seedMatch(txnId, { confidence: 0.54 });
      const strong = await seedMatch(txnId, { confidence: 0.81 });
      const nullConf = await seedMatch(txnId, { confidence: null });

      await applyCorrection(SCOPE, item(txnId, 'ambiguous_match'), { type: 'confirm' }, gw, db);

      expect(await readMatchStatus(strong)).toBe('manual');
      expect(await readMatchStatus(weak)).toBe('rejected');
      expect(await readMatchStatus(nullConf)).toBe('rejected');
    });

    it('ambiguous_match: leaves an already-settled match alone and only records the decision', async () => {
      const txnId = await seedTransaction();
      const settled = await seedMatch(txnId, { status: 'matched', confidence: 0.9 });

      await applyCorrection(SCOPE, item(txnId, 'ambiguous_match'), { type: 'confirm' }, gw, db);

      expect(await readMatchStatus(settled)).toBe('matched');
      expect(await readDecisions(txnId)).toHaveLength(1);
    });

    it('ambiguous_match: does not touch another transaction’s pending matches', async () => {
      const txnId = await seedTransaction();
      const mine = await seedMatch(txnId, { confidence: 0.6 });
      const otherTxn = await seedTransaction();
      const theirs = await seedMatch(otherTxn, { confidence: 0.99 });

      await applyCorrection(SCOPE, item(txnId, 'ambiguous_match'), { type: 'confirm' }, gw, db);

      expect(await readMatchStatus(mine)).toBe('manual');
      expect(await readMatchStatus(theirs)).toBe('pending');
    });

    it('unmatched_txn: records the decision and changes nothing else', async () => {
      const txnId = await seedTransaction();

      await applyCorrection(SCOPE, item(txnId, 'unmatched_txn'), { type: 'confirm' }, gw, db);

      const rows = await readDecisions(txnId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.decision).toBe('confirm');
      expect(await db.select().from(matches)).toHaveLength(0);
    });

    it('does NOT upsert sku_dictionary', async () => {
      const { itemId } = await seedReceiptItem({ needsReview: true });

      await applyCorrection(SCOPE, item(itemId, 'sku_resolution'), { type: 'confirm' }, gw, db);

      expect(await db.select().from(skuDictionary)).toHaveLength(0);
    });

    it('calls recomputeRollups with [item.id]', async () => {
      const { itemId } = await seedReceiptItem({ needsReview: true });

      await applyCorrection(SCOPE, item(itemId, 'sku_resolution'), { type: 'confirm' }, gw, db);

      expect(gw.recomputeRollupsCalls).toHaveLength(1);
      expect(gw.recomputeRollupsCalls[0]!.ids).toEqual([itemId]);
    });
  });

  // -------------------------------------------------------------------------
  // dismiss
  // -------------------------------------------------------------------------

  describe('dismiss', () => {
    it('sku_resolution: records the decision, clears needs_review, leaves confidences alone', async () => {
      const { itemId } = await seedReceiptItem({ needsReview: true });

      const result = await applyCorrection(
        SCOPE, item(itemId, 'sku_resolution'), { type: 'dismiss' }, gw, db,
      );
      expect(result.removedItemId).toBe(itemId);

      const decRows = await readDecisions(itemId);
      expect(decRows).toHaveLength(1);
      expect(decRows[0]!.decision).toBe('dismiss');

      const row = await readItem(itemId);
      expect(row.needsReview).toBe(false);
      expect(row.nameConfidence).toBe(0.4);
      expect(row.categoryConfidence).toBe(0.3);

      expect(await db.select().from(skuDictionary)).toHaveLength(0);
    });

    it('flagged_receipt: clears receipts.needs_review', async () => {
      const receiptId = await seedReceipt({ needsReview: true });

      await applyCorrection(SCOPE, item(receiptId, 'flagged_receipt'), { type: 'dismiss' }, gw, db);

      const rows = await db.select().from(receipts).where(eq(receipts.id, receiptId));
      expect(rows[0]!.needsReview).toBe(false);
    });

    it('ambiguous_match: records the decision without settling any match', async () => {
      const txnId = await seedTransaction();
      const pending = await seedMatch(txnId, { confidence: 0.7 });

      await applyCorrection(SCOPE, item(txnId, 'ambiguous_match'), { type: 'dismiss' }, gw, db);

      expect(await readMatchStatus(pending)).toBe('pending');
      expect(await readDecisions(txnId)).toHaveLength(1);
    });

    it('unmatched_txn: records the decision only', async () => {
      const txnId = await seedTransaction();

      await applyCorrection(SCOPE, item(txnId, 'unmatched_txn'), { type: 'dismiss' }, gw, db);

      expect(await readDecisions(txnId)).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // correct — pickCategoryId
  // -------------------------------------------------------------------------

  describe('correct → pickCategoryId', () => {
    const pick = (categoryId: string) => ({
      type: 'correct' as const,
      correction: { variant: 'pickCategoryId' as const, categoryId },
    });

    it('re-categorises the item, pins category confidence and clears needs_review', async () => {
      const { itemId } = await seedReceiptItem({ needsReview: true });

      await applyCorrection(SCOPE, item(itemId, 'sku_resolution'), pick('household'), gw, db);

      const row = await readItem(itemId);
      expect(row.categoryId).toBe('household');
      expect(row.categoryConfidence).toBe(1);
      expect(row.needsReview).toBe(false);

      const decRows = await readDecisions(itemId);
      expect(decRows[0]!.decision).toBe('correct');
      expect(JSON.parse(decRows[0]!.payloadJson!)).toEqual(pick('household').correction);
    });

    it('learns: writes a human sku_dictionary row keyed by store + sku, carrying the item’s own name confidence', async () => {
      const { itemId } = await seedReceiptItem({
        needsReview: true,
        store: "trader  joe's",
        sku: ' ks-evoo ',
        canonicalName: 'Kirkland Olive Oil',
        nameConfidence: 0.62,
      });

      await applyCorrection(SCOPE, item(itemId, 'sku_resolution'), pick('groceries'), gw, db);

      const rows = await db.select().from(skuDictionary);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.store).toBe("TRADER JOE'S");
      expect(rows[0]!.skuOrAbbrev).toBe('KS-EVOO');
      expect(rows[0]!.canonicalName).toBe('Kirkland Olive Oil');
      expect(rows[0]!.category).toBe('groceries');
      // The human chose a category, not a name: the category is certain, the
      // name is exactly as certain as it was before.
      expect(rows[0]!.nameConfidence).toBe(0.62);
      expect(rows[0]!.categoryConfidence).toBe(1);
      expect(rows[0]!.source).toBe('human');
    });

    it('keys by raw_description when the item has no sku', async () => {
      const { itemId } = await seedReceiptItem({
        needsReview: true,
        sku: null,
        canonicalName: 'Kirkland Olive Oil 2L',
        rawDescription: 'KS EVOO 2L',
      });

      await applyCorrection(SCOPE, item(itemId, 'sku_resolution'), pick('groceries'), gw, db);

      const rows = await db.select().from(skuDictionary);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.skuOrAbbrev).toBe('KS EVOO 2L');
      expect(rows[0]!.canonicalName).toBe('Kirkland Olive Oil 2L');
    });

    it('teaches the dictionary nothing when the item has no canonical name — the category lands on the item only', async () => {
      // A raw shelf abbreviation must never become a permanent "human" name.
      const { itemId } = await seedReceiptItem({
        needsReview: true,
        sku: null,
        canonicalName: null,
        rawDescription: 'KS EVOO 2L',
      });

      await applyCorrection(SCOPE, item(itemId, 'sku_resolution'), pick('groceries'), gw, db);

      expect(await db.select().from(skuDictionary)).toHaveLength(0);
      const row = await readItem(itemId);
      expect(row.categoryId).toBe('groceries');
      expect(row.categoryConfidence).toBe(1);
      expect(row.canonicalName).toBeNull();
      expect(row.needsReview).toBe(false);
    });

    it('accepts a display name and stores the slug id', async () => {
      const { itemId } = await seedReceiptItem({ needsReview: true });

      await applyCorrection(SCOPE, item(itemId, 'sku_resolution'), pick('Health & Medical'), gw, db);

      expect((await readItem(itemId)).categoryId).toBe('health-medical');
    });

    it('rejects a category outside the taxonomy and writes nothing', async () => {
      const { itemId } = await seedReceiptItem({ needsReview: true });

      await expect(
        applyCorrection(SCOPE, item(itemId, 'sku_resolution'), pick('not-a-category'), gw, db),
      ).rejects.toMatchObject({ code: 'unknown_category' });

      expect(await readDecisions(itemId)).toHaveLength(0);
      expect((await readItem(itemId)).needsReview).toBe(true);
      expect(await db.select().from(skuDictionary)).toHaveLength(0);
    });

    it('rejects the variant on a non-sku_resolution item', async () => {
      const txnId = await seedTransaction();

      await expect(
        applyCorrection(SCOPE, item(txnId, 'unmatched_txn'), pick('groceries'), gw, db),
      ).rejects.toMatchObject({ code: 'invalid_variant' });

      expect(await readDecisions(txnId)).toHaveLength(0);
    });

    it('refuses an item belonging to another household', async () => {
      const { itemId } = await seedReceiptItem({ householdId: OTHER_HH, needsReview: true });

      await expect(
        applyCorrection(SCOPE, item(itemId, 'sku_resolution'), pick('groceries'), gw, db),
      ).rejects.toMatchObject({ code: 'not_found' });

      const row = await readItem(itemId);
      expect(row.categoryId).toBeNull();
      expect(row.needsReview).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // correct — pickMatchCandidateId
  // -------------------------------------------------------------------------

  describe('correct → pickMatchCandidateId', () => {
    const pickMatch = (candidateId: string) => ({
      type: 'correct' as const,
      correction: { variant: 'pickMatchCandidateId' as const, candidateId },
    });

    it('promotes the chosen candidate to manual and rejects the other pending ones', async () => {
      const txnId = await seedTransaction();
      const chosen = await seedMatch(txnId, { confidence: 0.4 });
      const strongerButNotChosen = await seedMatch(txnId, { confidence: 0.92 });

      await applyCorrection(SCOPE, item(txnId, 'ambiguous_match'), pickMatch(chosen), gw, db);

      expect(await readMatchStatus(chosen)).toBe('manual');
      expect(await readMatchStatus(strongerButNotChosen)).toBe('rejected');

      const decRows = await readDecisions(txnId);
      expect(decRows[0]!.decision).toBe('correct');
    });

    it('rejects a candidate belonging to a different transaction', async () => {
      const txnId = await seedTransaction();
      const mine = await seedMatch(txnId, { confidence: 0.4 });
      const otherTxn = await seedTransaction();
      const theirs = await seedMatch(otherTxn, { confidence: 0.9 });

      await expect(
        applyCorrection(SCOPE, item(txnId, 'ambiguous_match'), pickMatch(theirs), gw, db),
      ).rejects.toMatchObject({ code: 'candidate_mismatch' });

      expect(await readMatchStatus(mine)).toBe('pending');
      expect(await readMatchStatus(theirs)).toBe('pending');
      expect(await readDecisions(txnId)).toHaveLength(0);
    });

    it('rejects a candidate whose transaction belongs to another household', async () => {
      const foreignTxn = await seedTransaction(OTHER_HH);
      const foreignMatch = await seedMatch(foreignTxn, { confidence: 0.9 });

      await expect(
        applyCorrection(
          SCOPE, item(foreignTxn, 'ambiguous_match'), pickMatch(foreignMatch), gw, db,
        ),
      ).rejects.toMatchObject({ code: 'not_found' });

      expect(await readMatchStatus(foreignMatch)).toBe('pending');
      expect(await readDecisions(foreignTxn)).toHaveLength(0);
    });

    it('rejects a candidate id that does not exist', async () => {
      const txnId = await seedTransaction();
      await seedMatch(txnId, { confidence: 0.4 });

      await expect(
        applyCorrection(SCOPE, item(txnId, 'ambiguous_match'), pickMatch('no-such-match'), gw, db),
      ).rejects.toMatchObject({ code: 'candidate_mismatch' });
    });

    it('rejects a candidate that is no longer pending and leaves the pending rows alone', async () => {
      const txnId = await seedTransaction();
      const alreadyRejected = await seedMatch(txnId, { status: 'rejected', confidence: 0.9 });
      const settled = await seedMatch(txnId, { status: 'matched', confidence: 0.8 });
      const stillPending = await seedMatch(txnId, { confidence: 0.5 });

      for (const notOnOffer of [alreadyRejected, settled]) {
        await expect(
          applyCorrection(SCOPE, item(txnId, 'ambiguous_match'), pickMatch(notOnOffer), gw, db),
        ).rejects.toMatchObject({ code: 'candidate_mismatch' });
      }

      expect(await readMatchStatus(alreadyRejected)).toBe('rejected');
      expect(await readMatchStatus(settled)).toBe('matched');
      expect(await readMatchStatus(stillPending)).toBe('pending');
      expect(await readDecisions(txnId)).toHaveLength(0);
    });

    it('rejects the variant on a non-ambiguous_match item', async () => {
      const { itemId } = await seedReceiptItem({ needsReview: true });

      await expect(
        applyCorrection(SCOPE, item(itemId, 'sku_resolution'), pickMatch('anything'), gw, db),
      ).rejects.toMatchObject({ code: 'invalid_variant' });
    });
  });

  // -------------------------------------------------------------------------
  // correct — editResolution
  // -------------------------------------------------------------------------

  describe('correct → editResolution', () => {
    const edit = (over: Partial<{ canonicalName: string; category: string }> = {}) => ({
      type: 'correct' as const,
      correction: {
        variant: 'editResolution' as const,
        canonicalName: 'Kirkland Organic Olive Oil',
        category: 'groceries',
        ...over,
      },
    });

    it('upserts sku_dictionary at confidence 1.0 / source human AND rewrites the item', async () => {
      const { itemId } = await seedReceiptItem({ needsReview: true });

      await applyCorrection(SCOPE, item(itemId, 'sku_resolution'), edit(), gw, db);

      const decRows = await readDecisions(itemId);
      expect(decRows).toHaveLength(1);
      expect(decRows[0]!.decision).toBe('correct');

      const skuRows = await db.select().from(skuDictionary);
      expect(skuRows).toHaveLength(1);
      // Keyed by the ITEM (its receipt's store + sku ?? raw_description), not
      // by anything the caller typed.
      expect(skuRows[0]!.store).toBe('COSTCO');
      expect(skuRows[0]!.skuOrAbbrev).toBe('KS EVOO');
      expect(skuRows[0]!.canonicalName).toBe('Kirkland Organic Olive Oil');
      expect(skuRows[0]!.category).toBe('groceries');
      expect(skuRows[0]!.nameConfidence).toBe(1.0);
      expect(skuRows[0]!.categoryConfidence).toBe(1.0);
      expect(skuRows[0]!.source).toBe('human');

      const row = await readItem(itemId);
      expect(row.canonicalName).toBe('Kirkland Organic Olive Oil');
      expect(row.categoryId).toBe('groceries');
      expect(row.nameConfidence).toBe(1);
      expect(row.categoryConfidence).toBe(1);
      expect(row.needsReview).toBe(false);
    });

    it('stores the slug id when the correction carries a display name', async () => {
      const { itemId } = await seedReceiptItem({ needsReview: true });

      await applyCorrection(
        SCOPE, item(itemId, 'sku_resolution'), edit({ category: 'Books & Media' }), gw, db,
      );

      expect((await readItem(itemId)).categoryId).toBe('books-media');
      expect((await db.select().from(skuDictionary))[0]!.category).toBe('books-media');
    });

    it('keys the dictionary by the item’s store + sku, normalised', async () => {
      const { itemId } = await seedReceiptItem({
        needsReview: true,
        store: "trader  joe's",
        sku: ' ks-evoo ',
      });

      await applyCorrection(SCOPE, item(itemId, 'sku_resolution'), edit(), gw, db);

      const skuRows = await db.select().from(skuDictionary);
      expect(skuRows).toHaveLength(1);
      expect(skuRows[0]!.store).toBe("TRADER JOE'S");
      expect(skuRows[0]!.skuOrAbbrev).toBe('KS-EVOO');
    });

    it('overwrites an existing auto sku_dictionary entry on conflict', async () => {
      const { itemId } = await seedReceiptItem({ needsReview: true, sku: 'KS-EVOO' });
      await db.insert(skuDictionary).values({
        store: 'COSTCO',
        skuOrAbbrev: 'KS-EVOO',
        canonicalName: 'Old Name',
        category: 'groceries',
        nameConfidence: 0.7,
        categoryConfidence: 0.6,
        source: 'auto',
        updatedAt: 1000,
      });

      await applyCorrection(
        SCOPE,
        item(itemId, 'sku_resolution'),
        edit({ canonicalName: 'Updated Name', category: 'household' }),
        gw,
        db,
      );

      const skuRows = await db.select().from(skuDictionary);
      expect(skuRows).toHaveLength(1);
      expect(skuRows[0]!.canonicalName).toBe('Updated Name');
      expect(skuRows[0]!.category).toBe('household');
      expect(skuRows[0]!.source).toBe('human');
    });

    it('overwrites an existing human entry (human-over-human always wins)', async () => {
      const { itemId } = await seedReceiptItem({ needsReview: true, store: 'WALMART', sku: 'GV-BREAD' });
      await db.insert(skuDictionary).values({
        store: 'WALMART',
        skuOrAbbrev: 'GV-BREAD',
        canonicalName: 'Great Value White Bread',
        category: 'groceries',
        nameConfidence: 1.0,
        categoryConfidence: 1.0,
        source: 'human',
        updatedAt: 1000,
      });

      await applyCorrection(
        SCOPE,
        item(itemId, 'sku_resolution'),
        edit({ canonicalName: 'Great Value Wheat Bread' }),
        gw,
        db,
      );

      const skuRows = await db.select().from(skuDictionary).where(
        eq(skuDictionary.skuOrAbbrev, 'GV-BREAD'),
      );
      expect(skuRows).toHaveLength(1);
      expect(skuRows[0]!.canonicalName).toBe('Great Value Wheat Bread');
      expect(skuRows[0]!.source).toBe('human');
    });

    it('rejects a category outside the taxonomy and writes nothing', async () => {
      const { itemId } = await seedReceiptItem({ needsReview: true });

      await expect(
        applyCorrection(
          SCOPE, item(itemId, 'sku_resolution'), edit({ category: 'snacks' }), gw, db,
        ),
      ).rejects.toMatchObject({ code: 'unknown_category' });

      expect(await db.select().from(skuDictionary)).toHaveLength(0);
      expect(await readDecisions(itemId)).toHaveLength(0);
      expect((await readItem(itemId)).needsReview).toBe(true);
    });

    it('rejects the variant on a non-sku_resolution item', async () => {
      const receiptId = await seedReceipt({ needsReview: true });

      await expect(
        applyCorrection(SCOPE, item(receiptId, 'flagged_receipt'), edit(), gw, db),
      ).rejects.toMatchObject({ code: 'invalid_variant' });
    });

    it('refuses an item belonging to another household', async () => {
      const { itemId } = await seedReceiptItem({ householdId: OTHER_HH, needsReview: true });

      await expect(
        applyCorrection(SCOPE, item(itemId, 'sku_resolution'), edit(), gw, db),
      ).rejects.toMatchObject({ code: 'not_found' });

      expect(await db.select().from(skuDictionary)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // CorrectionError shape
  // -------------------------------------------------------------------------

  describe('CorrectionError', () => {
    it('is an Error with a stable code', async () => {
      const txnId = await seedTransaction();
      const err = await applyCorrection(
        SCOPE,
        item(txnId, 'unmatched_txn'),
        { type: 'correct', correction: { variant: 'pickCategoryId', categoryId: 'groceries' } },
        gw,
        db,
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(CorrectionError);
      expect(err).toBeInstanceOf(Error);
      expect((err as CorrectionError).code).toBe('invalid_variant');
    });
  });

  // -------------------------------------------------------------------------
  // Queue state after a correction
  // -------------------------------------------------------------------------

  describe('queue state', () => {
    it('a corrected item leaves the queue AND its needs_review flag is cleared', async () => {
      const { itemId } = await seedReceiptItem({ needsReview: true });
      const { itemId: untouched } = await seedReceiptItem({ needsReview: true });

      const before = await assembleQueue(SCOPE, gw, db);
      expect(before.map((i) => i.id)).toContain(itemId);

      await applyCorrection(
        SCOPE,
        item(itemId, 'sku_resolution'),
        { type: 'correct', correction: { variant: 'pickCategoryId', categoryId: 'groceries' } },
        gw,
        db,
      );

      const after = await assembleQueue(SCOPE, gw, db);
      expect(after.map((i) => i.id)).not.toContain(itemId);
      expect(after.map((i) => i.id)).toContain(untouched);
      expect((await readItem(itemId)).needsReview).toBe(false);
    });

    it('a confirmed flagged receipt leaves the queue AND its flag is cleared', async () => {
      const receiptId = await seedReceipt({ needsReview: true });

      await applyCorrection(SCOPE, item(receiptId, 'flagged_receipt'), { type: 'confirm' }, gw, db);

      const after = await assembleQueue(SCOPE, gw, db);
      expect(after.map((i) => i.id)).not.toContain(receiptId);
      const rows = await db.select().from(receipts).where(eq(receipts.id, receiptId));
      expect(rows[0]!.needsReview).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Household scoping
  // -------------------------------------------------------------------------

  describe('household scoping', () => {
    it('confirm on a receipt item in another household throws not_found and writes nothing', async () => {
      const { itemId } = await seedReceiptItem({ householdId: OTHER_HH, needsReview: true });

      await expect(
        applyCorrection(SCOPE, item(itemId, 'sku_resolution'), { type: 'confirm' }, gw, db),
      ).rejects.toMatchObject({ code: 'not_found' });

      expect(await readDecisions(itemId)).toHaveLength(0);
      expect((await readItem(itemId)).needsReview).toBe(true);
    });

    it('dismiss on a flagged receipt in another household throws not_found', async () => {
      const receiptId = await seedReceipt({ householdId: OTHER_HH, needsReview: true });

      await expect(
        applyCorrection(SCOPE, item(receiptId, 'flagged_receipt'), { type: 'dismiss' }, gw, db),
      ).rejects.toMatchObject({ code: 'not_found' });

      const rows = await db.select().from(receipts).where(eq(receipts.id, receiptId));
      expect(rows[0]!.needsReview).toBe(true);
    });

    it('confirm on an ambiguous match in another household throws not_found and writes nothing', async () => {
      const foreignTxn = await seedTransaction(OTHER_HH);
      const foreignMatch = await seedMatch(foreignTxn, { confidence: 0.9 });

      await expect(
        applyCorrection(SCOPE, item(foreignTxn, 'ambiguous_match'), { type: 'confirm' }, gw, db),
      ).rejects.toMatchObject({ code: 'not_found' });

      expect(await readMatchStatus(foreignMatch)).toBe('pending');
      expect(await readDecisions(foreignTxn)).toHaveLength(0);
    });

    it('confirm on an unmatched transaction in another household throws not_found', async () => {
      const foreignTxn = await seedTransaction(OTHER_HH);

      await expect(
        applyCorrection(SCOPE, item(foreignTxn, 'unmatched_txn'), { type: 'confirm' }, gw, db),
      ).rejects.toMatchObject({ code: 'not_found' });

      expect(await readDecisions(foreignTxn)).toHaveLength(0);
    });

    it('dismiss on a transaction-typed item in another household throws not_found', async () => {
      const foreignTxn = await seedTransaction(OTHER_HH);

      for (const type of ['ambiguous_match', 'unmatched_txn'] as const) {
        await expect(
          applyCorrection(SCOPE, item(foreignTxn, type), { type: 'dismiss' }, gw, db),
        ).rejects.toMatchObject({ code: 'not_found' });
      }
      expect(await readDecisions(foreignTxn)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Only queued items take decisions
  // -------------------------------------------------------------------------

  describe('not_queued', () => {
    it('confirm on a receipt item whose flag is clear throws not_queued and rewrites nothing', async () => {
      const { itemId } = await seedReceiptItem({
        needsReview: false,
        canonicalName: 'Kirkland Olive Oil',
        categoryId: 'groceries',
      });

      await expect(
        applyCorrection(SCOPE, item(itemId, 'sku_resolution'), { type: 'confirm' }, gw, db),
      ).rejects.toMatchObject({ code: 'not_queued' });

      const row = await readItem(itemId);
      expect(row.nameConfidence).toBe(0.4);
      expect(row.categoryConfidence).toBe(0.3);
      expect(await readDecisions(itemId)).toHaveLength(0);
    });

    it('dismiss and correct on an unflagged receipt item throw not_queued', async () => {
      const { itemId } = await seedReceiptItem({ needsReview: false });

      await expect(
        applyCorrection(SCOPE, item(itemId, 'sku_resolution'), { type: 'dismiss' }, gw, db),
      ).rejects.toMatchObject({ code: 'not_queued' });
      await expect(
        applyCorrection(
          SCOPE,
          item(itemId, 'sku_resolution'),
          { type: 'correct', correction: { variant: 'pickCategoryId', categoryId: 'groceries' } },
          gw,
          db,
        ),
      ).rejects.toMatchObject({ code: 'not_queued' });

      expect((await readItem(itemId)).categoryId).toBeNull();
      expect(await db.select().from(skuDictionary)).toHaveLength(0);
    });

    it('confirm on a receipt that is not flagged throws not_queued', async () => {
      const receiptId = await seedReceipt({ needsReview: false });

      await expect(
        applyCorrection(SCOPE, item(receiptId, 'flagged_receipt'), { type: 'confirm' }, gw, db),
      ).rejects.toMatchObject({ code: 'not_queued' });

      expect(await readDecisions(receiptId)).toHaveLength(0);
    });

    it('a foreign item is not_found before it is not_queued', async () => {
      const { itemId } = await seedReceiptItem({ householdId: OTHER_HH, needsReview: false });

      await expect(
        applyCorrection(SCOPE, item(itemId, 'sku_resolution'), { type: 'confirm' }, gw, db),
      ).rejects.toMatchObject({ code: 'not_found' });
    });
  });

  // -------------------------------------------------------------------------
  // Atomicity: recomputeRollups throwing rolls back writes
  // -------------------------------------------------------------------------

  describe('atomicity', () => {
    it('rolls back every write if recomputeRollups throws', async () => {
      const { itemId } = await seedReceiptItem({ needsReview: true });
      gw.recomputeError = new Error('rollup engine down');

      await expect(
        applyCorrection(
          SCOPE,
          item(itemId, 'sku_resolution'),
          {
            type: 'correct',
            correction: {
              variant: 'editResolution',
              store: 'WALMART',
              skuOrAbbrev: 'GV-MILK',
              canonicalName: 'Great Value Milk',
              category: 'groceries',
            },
          },
          gw,
          db,
        ),
      ).rejects.toThrow('rollup engine down');

      expect(await readDecisions(itemId)).toHaveLength(0);
      expect(await db.select().from(skuDictionary)).toHaveLength(0);
      const row = await readItem(itemId);
      expect(row.needsReview).toBe(true);
      expect(row.categoryId).toBeNull();
    });

    it('rolls back a promoted match if recomputeRollups throws', async () => {
      const txnId = await seedTransaction();
      const candidate = await seedMatch(txnId, { confidence: 0.8 });
      gw.recomputeError = new Error('rollup engine down');

      await expect(
        applyCorrection(SCOPE, item(txnId, 'ambiguous_match'), { type: 'confirm' }, gw, db),
      ).rejects.toThrow('rollup engine down');

      expect(await readMatchStatus(candidate)).toBe('pending');
    });
  });

  // -------------------------------------------------------------------------
  // Idempotency / UNIQUE constraint
  // -------------------------------------------------------------------------

  describe('idempotency', () => {
    it('second terminal decision on same (itemType, itemId) is rejected by UNIQUE constraint', async () => {
      const { itemId } = await seedReceiptItem({ needsReview: true });

      await applyCorrection(SCOPE, item(itemId, 'sku_resolution'), { type: 'confirm' }, gw, db);

      await expect(
        applyCorrection(SCOPE, item(itemId, 'sku_resolution'), { type: 'dismiss' }, gw, db),
      ).rejects.toThrow();

      const rows = await readDecisions(itemId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.decision).toBe('confirm');
    });
  });

  // -------------------------------------------------------------------------
  // Bounded recompute
  // -------------------------------------------------------------------------

  describe('bounded recompute', () => {
    it('recomputeRollups receives only [item.id], not all household items', async () => {
      const { itemId: id1 } = await seedReceiptItem({ needsReview: true });
      const { itemId: id2 } = await seedReceiptItem({ needsReview: true });

      await applyCorrection(SCOPE, item(id1, 'sku_resolution'), { type: 'confirm' }, gw, db);

      expect(gw.recomputeRollupsCalls).toHaveLength(1);
      const call = gw.recomputeRollupsCalls[0]!;
      expect(call.ids).toEqual([id1]);
      expect(call.ids).not.toContain(id2);
    });
  });
});
