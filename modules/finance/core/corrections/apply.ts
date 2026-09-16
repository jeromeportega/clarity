import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';

import type { FinanceDb } from '../../db/client';
import {
  accounts,
  matches,
  receiptItems,
  receipts,
  reviewDecisions,
  transactions,
} from '../../db/schema';
import { categoryIdFor } from '../../db/taxonomy';
import { skuDictionary } from '../receipts/dictionary/schema';
import { normalizeStore, normalizeSkuOrAbbrev } from '../receipts/dictionary/normalize';
import type { ReconciliationGateway } from '../reconciliation/types';
import type { HouseholdScope } from '../scope';
import type { QueueItem } from '../queue/types';

// ---------------------------------------------------------------------------
// Action types
// ---------------------------------------------------------------------------

export type PickCategoryCorrection = {
  variant: 'pickCategoryId';
  categoryId: string;
};

export type PickMatchCandidateCorrection = {
  variant: 'pickMatchCandidateId';
  candidateId: string;
};

/**
 * The human names the item: what it is and which category it belongs to. The
 * dictionary key (store + SKU / abbreviation) is the item's own — it is never
 * retyped by the caller, so what is learned is always what the next receipt
 * carrying this line will look up.
 */
export type EditResolutionCorrection = {
  variant: 'editResolution';
  canonicalName: string;
  category: string;
};

export type CorrectionVariant =
  | PickCategoryCorrection
  | PickMatchCandidateCorrection
  | EditResolutionCorrection;

export type CorrectionAction =
  | { type: 'confirm' }
  | { type: 'dismiss' }
  | { type: 'correct'; correction: CorrectionVariant };

export interface CorrectionResult {
  removedItemId: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A correction the caller asked for cannot be applied to this item. Always the
 * caller's fault, never a server fault — the HTTP routes map it to 400 and put
 * `code` in the body.
 *
 *   invalid_variant    — this variant is meaningless for this queue item type
 *   unknown_category   — the category is not in `db/taxonomy.ts`
 *   not_found          — the target row does not exist in this household
 *   not_queued         — the target exists but is not in the review queue
 *                        (its needs_review flag is clear), so there is no
 *                        question to answer
 *   candidate_mismatch — the match candidate is not a pending candidate of
 *                        this item
 */
export type CorrectionErrorCode =
  | 'invalid_variant'
  | 'unknown_category'
  | 'not_found'
  | 'not_queued'
  | 'candidate_mismatch';

export class CorrectionError extends Error {
  readonly code: CorrectionErrorCode;

  constructor(code: CorrectionErrorCode, message: string) {
    super(message);
    this.name = 'CorrectionError';
    this.code = code;
    // Keeps `instanceof` working across the tsc downlevel boundary.
    Object.setPrototypeOf(this, CorrectionError.prototype);
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** The transaction handle drizzle hands the `db.transaction` callback. */
type CorrectionTx = Parameters<Parameters<FinanceDb['transaction']>[0]>[0];

interface ScopedReceiptItem {
  id: string;
  sku: string | null;
  rawDescription: string;
  canonicalName: string | null;
  categoryId: string | null;
  nameConfidence: number | null;
  /** The parent receipt's store — the dictionary key's first half. */
  store: string;
}

interface PendingCandidate {
  id: string;
  confidence: number | null;
}

/** Subquery: the ids of every receipt in the household. */
function householdReceiptIds(tx: CorrectionTx, scope: HouseholdScope) {
  return tx
    .select({ id: receipts.id })
    .from(receipts)
    .where(eq(receipts.householdId, scope.householdId));
}

/** Subquery: the ids of every transaction in the household (via accounts). */
function householdTransactionIds(tx: CorrectionTx, scope: HouseholdScope) {
  return tx
    .select({ id: transactions.id })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(eq(accounts.householdId, scope.householdId));
}

/**
 * WHERE for a receipt_items write: the row AND its household, so every update
 * re-asserts the scope the read established (receipt_items has no household
 * column of its own — it is scoped through its receipt).
 */
function scopedReceiptItem(tx: CorrectionTx, scope: HouseholdScope, itemId: string) {
  return and(eq(receiptItems.id, itemId), inArray(receiptItems.receiptId, householdReceiptIds(tx, scope)));
}

/** WHERE for a matches write, scoped through transactions → accounts. */
function scopedMatches(tx: CorrectionTx, scope: HouseholdScope, matchIds: string[]) {
  return and(inArray(matches.id, matchIds), inArray(matches.transactionId, householdTransactionIds(tx, scope)));
}

/**
 * Load a receipt item that is in this household AND currently in the review
 * queue. Throws `not_found` for a foreign or missing row and `not_queued` for
 * one whose flag is already clear — a decision on a question nobody asked is
 * refused, never applied to data the human never saw.
 */
async function loadQueuedReceiptItem(
  tx: CorrectionTx,
  scope: HouseholdScope,
  itemId: string,
): Promise<ScopedReceiptItem> {
  const rows = await tx
    .select({
      id: receiptItems.id,
      sku: receiptItems.sku,
      rawDescription: receiptItems.rawDescription,
      canonicalName: receiptItems.canonicalName,
      categoryId: receiptItems.categoryId,
      nameConfidence: receiptItems.nameConfidence,
      needsReview: receiptItems.needsReview,
      store: receipts.store,
    })
    .from(receiptItems)
    .innerJoin(receipts, eq(receiptItems.receiptId, receipts.id))
    .where(and(eq(receiptItems.id, itemId), eq(receipts.householdId, scope.householdId)))
    .limit(1);

  const row = rows[0];
  if (!row) {
    throw new CorrectionError('not_found', `receipt item "${itemId}" is not in this household`);
  }
  if (!row.needsReview) {
    throw new CorrectionError('not_queued', `receipt item "${itemId}" is not in the review queue`);
  }
  const { needsReview: _flag, ...item } = row;
  return item;
}

/** Assert a receipt is in this household and flagged (flagged_receipt targets). */
async function requireQueuedReceipt(
  tx: CorrectionTx,
  scope: HouseholdScope,
  receiptId: string,
): Promise<void> {
  const rows = await tx
    .select({ id: receipts.id, needsReview: receipts.needsReview })
    .from(receipts)
    .where(and(eq(receipts.id, receiptId), eq(receipts.householdId, scope.householdId)))
    .limit(1);

  if (!rows[0]) {
    throw new CorrectionError('not_found', `receipt "${receiptId}" is not in this household`);
  }
  if (!rows[0].needsReview) {
    throw new CorrectionError('not_queued', `receipt "${receiptId}" is not in the review queue`);
  }
}

/**
 * Assert a transaction is in this household (ambiguous_match / unmatched_txn
 * targets). `transactions` carries no household column, so scoping goes
 * through accounts.
 */
async function requireScopedTransaction(
  tx: CorrectionTx,
  scope: HouseholdScope,
  transactionId: string,
): Promise<void> {
  const rows = await tx
    .select({ id: transactions.id })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(and(eq(transactions.id, transactionId), eq(accounts.householdId, scope.householdId)))
    .limit(1);

  if (!rows[0]) {
    throw new CorrectionError('not_found', `transaction "${transactionId}" is not in this household`);
  }
}

/** The still-undecided match candidates for a (scoped) transaction. */
async function pendingCandidatesFor(
  tx: CorrectionTx,
  scope: HouseholdScope,
  transactionId: string,
): Promise<PendingCandidate[]> {
  return tx
    .select({ id: matches.id, confidence: matches.confidence })
    .from(matches)
    .innerJoin(transactions, eq(matches.transactionId, transactions.id))
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(
      and(
        eq(matches.transactionId, transactionId),
        eq(matches.status, 'pending'),
        eq(accounts.householdId, scope.householdId),
      ),
    );
}

/** Highest confidence wins; a null confidence ranks last; id breaks ties. */
function bestCandidate(candidates: PendingCandidate[]): PendingCandidate {
  return [...candidates].sort(
    (a, b) => (b.confidence ?? -1) - (a.confidence ?? -1) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )[0]!;
}

/**
 * One winner per transaction: `winnerId` becomes 'manual' (human-chosen) and
 * every other pending candidate becomes 'rejected', so the transaction stops
 * being ambiguous for the read gateway too.
 */
async function resolveAmbiguity(
  tx: CorrectionTx,
  scope: HouseholdScope,
  winnerId: string,
  pending: PendingCandidate[],
): Promise<void> {
  await tx.update(matches).set({ status: 'manual' }).where(scopedMatches(tx, scope, [winnerId]));

  const losers = pending.map((c) => c.id).filter((id) => id !== winnerId);
  if (losers.length > 0) {
    await tx.update(matches).set({ status: 'rejected' }).where(scopedMatches(tx, scope, losers));
  }
}

/** Resolve a correction's category through the ONE taxonomy, or refuse it. */
function resolveCategoryId(value: string): string {
  const id = categoryIdFor(value);
  if (!id) {
    throw new CorrectionError('unknown_category', `"${value}" is not a category in the taxonomy`);
  }
  return id;
}

/** The dictionary key for an item: its receipt's store + its SKU, else its raw text. */
function dictionaryKeyFor(row: ScopedReceiptItem): { store: string; skuOrAbbrev: string } {
  return { store: row.store, skuOrAbbrev: row.sku ?? row.rawDescription };
}

/**
 * Teach the SKU dictionary what the human said. `source: 'human'` always wins,
 * over an auto entry and over an earlier human one. `nameConfidence` is
 * whatever the caller can honestly claim for the name: 1.0 when the human
 * typed it, the item's existing confidence when they only chose a category.
 */
async function learnFromHuman(
  tx: CorrectionTx,
  entry: {
    store: string;
    skuOrAbbrev: string;
    canonicalName: string;
    category: string;
    nameConfidence: number;
  },
): Promise<void> {
  const now = Date.now();
  const set = {
    canonicalName: entry.canonicalName,
    category: entry.category,
    nameConfidence: entry.nameConfidence,
    categoryConfidence: 1.0,
    source: 'human' as const,
    updatedAt: now,
  };
  await tx
    .insert(skuDictionary)
    .values({
      store: normalizeStore(entry.store),
      skuOrAbbrev: normalizeSkuOrAbbrev(entry.skuOrAbbrev),
      ...set,
    })
    .onConflictDoUpdate({
      target: [skuDictionary.store, skuDictionary.skuOrAbbrev],
      set,
    });
}

function requireItemType(item: QueueItem, expected: QueueItem['type'], variant: string): void {
  if (item.type !== expected) {
    throw new CorrectionError(
      'invalid_variant',
      `correction "${variant}" is only valid for ${expected} items, not ${item.type}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Per-decision effects
// ---------------------------------------------------------------------------

/**
 * confirm — the human vouched for what the queue showed them, so the
 * uncertainty that put the item in the queue is resolved at its source.
 */
async function applyConfirm(
  tx: CorrectionTx,
  scope: HouseholdScope,
  item: QueueItem,
): Promise<void> {
  switch (item.type) {
    case 'sku_resolution': {
      const row = await loadQueuedReceiptItem(tx, scope, item.id);
      // Vouch only for what exists: an item with no canonical name (or no
      // category) has nothing there to be confident about, and stamping 1.0
      // on a blank would be the silent guess the queue exists to prevent.
      await tx
        .update(receiptItems)
        .set({
          needsReview: false,
          ...(row.canonicalName !== null ? { nameConfidence: 1.0 } : {}),
          ...(row.categoryId !== null ? { categoryConfidence: 1.0 } : {}),
        })
        .where(scopedReceiptItem(tx, scope, item.id));
      return;
    }
    case 'flagged_receipt': {
      await requireQueuedReceipt(tx, scope, item.id);
      await tx
        .update(receipts)
        .set({ needsReview: false })
        .where(and(eq(receipts.id, item.id), eq(receipts.householdId, scope.householdId)));
      return;
    }
    case 'ambiguous_match': {
      await requireScopedTransaction(tx, scope, item.id);
      const pending = await pendingCandidatesFor(tx, scope, item.id);
      // Nothing pending (already resolved, or never had candidates): the
      // decision row alone records the human's answer.
      if (pending.length === 0) return;
      await resolveAmbiguity(tx, scope, bestCandidate(pending).id, pending);
      return;
    }
    case 'unmatched_txn':
      // Nothing to change: there is no match row and the transaction stands.
      await requireScopedTransaction(tx, scope, item.id);
      return;
  }
}

/**
 * dismiss — "stop asking me". No judgement is recorded about the data, but the
 * flag that raised the question is cleared so flag state matches the queue.
 */
async function applyDismiss(
  tx: CorrectionTx,
  scope: HouseholdScope,
  item: QueueItem,
): Promise<void> {
  switch (item.type) {
    case 'sku_resolution': {
      await loadQueuedReceiptItem(tx, scope, item.id);
      await tx
        .update(receiptItems)
        .set({ needsReview: false })
        .where(scopedReceiptItem(tx, scope, item.id));
      return;
    }
    case 'flagged_receipt': {
      await requireQueuedReceipt(tx, scope, item.id);
      await tx
        .update(receipts)
        .set({ needsReview: false })
        .where(and(eq(receipts.id, item.id), eq(receipts.householdId, scope.householdId)));
      return;
    }
    case 'ambiguous_match':
    case 'unmatched_txn':
      await requireScopedTransaction(tx, scope, item.id);
      return;
  }
}

/** correct — the human supplied the right answer; write it where it is read. */
async function applyCorrect(
  tx: CorrectionTx,
  scope: HouseholdScope,
  item: QueueItem,
  correction: CorrectionVariant,
): Promise<void> {
  switch (correction.variant) {
    case 'pickCategoryId': {
      requireItemType(item, 'sku_resolution', correction.variant);
      const row = await loadQueuedReceiptItem(tx, scope, item.id);
      const categoryId = resolveCategoryId(correction.categoryId);

      await tx
        .update(receiptItems)
        .set({ categoryId, categoryConfidence: 1.0, needsReview: false })
        .where(scopedReceiptItem(tx, scope, item.id));

      // Learn: the next receipt carrying this SKU gets the category for free.
      // The human said nothing about the NAME, so the dictionary keeps the
      // item's own name at the item's own confidence — and when the item has
      // no canonical name at all there is nothing to teach: a raw shelf
      // abbreviation must never become a permanent "human" canonical name.
      if (row.canonicalName !== null) {
        await learnFromHuman(tx, {
          ...dictionaryKeyFor(row),
          canonicalName: row.canonicalName,
          category: categoryId,
          nameConfidence: row.nameConfidence ?? 0,
        });
      }
      return;
    }

    case 'pickMatchCandidateId': {
      requireItemType(item, 'ambiguous_match', correction.variant);
      await requireScopedTransaction(tx, scope, item.id);

      // The candidate must be one of THIS transaction's still-pending match
      // rows: a rejected or settled row is not a choice on offer.
      const candidate = await tx
        .select({ id: matches.id })
        .from(matches)
        .innerJoin(transactions, eq(matches.transactionId, transactions.id))
        .innerJoin(accounts, eq(transactions.accountId, accounts.id))
        .where(
          and(
            eq(matches.id, correction.candidateId),
            eq(matches.transactionId, item.id),
            eq(matches.status, 'pending'),
            eq(accounts.householdId, scope.householdId),
          ),
        )
        .limit(1);

      if (!candidate[0]) {
        throw new CorrectionError(
          'candidate_mismatch',
          `match "${correction.candidateId}" is not a pending candidate for transaction "${item.id}"`,
        );
      }

      const pending = await pendingCandidatesFor(tx, scope, item.id);
      await resolveAmbiguity(tx, scope, correction.candidateId, pending);
      return;
    }

    case 'editResolution': {
      requireItemType(item, 'sku_resolution', correction.variant);
      const row = await loadQueuedReceiptItem(tx, scope, item.id);
      const categoryId = resolveCategoryId(correction.category);

      // Keyed by the item, so what is learned is exactly what the next
      // receipt carrying this line will look up.
      await learnFromHuman(tx, {
        ...dictionaryKeyFor(row),
        canonicalName: correction.canonicalName,
        category: categoryId,
        nameConfidence: 1.0,
      });

      await tx
        .update(receiptItems)
        .set({
          canonicalName: correction.canonicalName,
          categoryId,
          nameConfidence: 1.0,
          categoryConfidence: 1.0,
          needsReview: false,
        })
        .where(scopedReceiptItem(tx, scope, item.id));
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// applyCorrection — the core mutation
//
// ONE libSQL transaction: write the terminal review_decisions row, apply the
// decision to the row that raised the question (receipt_items / receipts /
// matches), then call gw.recomputeRollups before committing. Any failure —
// a CorrectionError, a UNIQUE violation on the decision, a throwing gateway —
// rolls the whole thing back, so there is no partial state.
//
// Affected IDs for recomputeRollups: always [item.id] — a bounded set (the item
// under review), never the whole household.
// ---------------------------------------------------------------------------

export async function applyCorrection(
  scope: HouseholdScope,
  item: QueueItem,
  action: CorrectionAction,
  gw: ReconciliationGateway,
  db: FinanceDb,
): Promise<CorrectionResult> {
  const decisionId = randomUUID();
  const payloadJson = action.type === 'correct'
    ? JSON.stringify(action.correction)
    : null;

  await db.transaction(async (tx) => {
    // 1. The terminal decision row. Written first so a second decision on the
    //    same (household, type, id) trips ux_review_decisions_item — the
    //    routes turn that UNIQUE violation into a 409.
    await tx.insert(reviewDecisions).values({
      id: decisionId,
      householdId: scope.householdId,
      itemType: item.type,
      itemId: item.id,
      decision: action.type,
      payloadJson,
    });

    // 2. Apply the decision at its source.
    if (action.type === 'confirm') {
      await applyConfirm(tx, scope, item);
    } else if (action.type === 'dismiss') {
      await applyDismiss(tx, scope, item);
    } else {
      await applyCorrect(tx, scope, item, action.correction);
    }

    // 3. Notify the gateway. If it throws, everything above rolls back — but
    //    the gateway holds its OWN connection, not `tx`, so nothing it might
    //    write is inside this transaction, and a write there would contend
    //    with the lock this transaction holds. Both gateways compute rollups
    //    on read and treat this as a no-op; keep it that way, or thread `tx`
    //    through the seam before giving it writes. Affected set: [item.id].
    await gw.recomputeRollups(scope, [item.id]);
  });

  return { removedItemId: item.id };
}
