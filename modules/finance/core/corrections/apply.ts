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

export type EditResolutionCorrection = {
  variant: 'editResolution';
  store: string;
  skuOrAbbrev: string;
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
 *   candidate_mismatch — the match candidate is not a candidate of this item
 */
export type CorrectionErrorCode =
  | 'invalid_variant'
  | 'unknown_category'
  | 'not_found'
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
  /** The parent receipt's store — the dictionary key's first half. */
  store: string;
}

interface PendingCandidate {
  id: string;
  confidence: number | null;
}

/**
 * Load a receipt item only if its parent receipt belongs to the household.
 * Throws `not_found` rather than silently updating nothing, so a cross-household
 * correction is a loud 400 instead of a no-op that looks like success.
 */
async function loadScopedReceiptItem(
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
  return row;
}

/** Assert a receipt belongs to the household (flagged_receipt targets). */
async function requireScopedReceipt(
  tx: CorrectionTx,
  scope: HouseholdScope,
  receiptId: string,
): Promise<void> {
  const rows = await tx
    .select({ id: receipts.id })
    .from(receipts)
    .where(and(eq(receipts.id, receiptId), eq(receipts.householdId, scope.householdId)))
    .limit(1);

  if (!rows[0]) {
    throw new CorrectionError('not_found', `receipt "${receiptId}" is not in this household`);
  }
}

/**
 * The still-undecided match candidates for a transaction. `matches` carries no
 * household column, so scoping goes through transactions → accounts.
 */
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
    (a, b) => (b.confidence ?? -1) - (a.confidence ?? -1) || a.id.localeCompare(b.id),
  )[0]!;
}

/**
 * One winner per transaction: `winnerId` becomes 'manual' (human-chosen) and
 * every other pending candidate becomes 'rejected', so the transaction stops
 * being ambiguous for the read gateway too.
 */
async function resolveAmbiguity(
  tx: CorrectionTx,
  winnerId: string,
  pending: PendingCandidate[],
): Promise<void> {
  await tx.update(matches).set({ status: 'manual' }).where(eq(matches.id, winnerId));

  const losers = pending.map((c) => c.id).filter((id) => id !== winnerId);
  if (losers.length > 0) {
    await tx.update(matches).set({ status: 'rejected' }).where(inArray(matches.id, losers));
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

/**
 * Teach the SKU dictionary what the human said. `source: 'human'` always wins,
 * over an auto entry and over an earlier human one.
 */
async function learnFromHuman(
  tx: CorrectionTx,
  entry: { store: string; skuOrAbbrev: string; canonicalName: string; category: string },
): Promise<void> {
  const now = Date.now();
  const set = {
    canonicalName: entry.canonicalName,
    category: entry.category,
    nameConfidence: 1.0,
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
      await loadScopedReceiptItem(tx, scope, item.id);
      await tx
        .update(receiptItems)
        .set({ needsReview: false, nameConfidence: 1.0, categoryConfidence: 1.0 })
        .where(eq(receiptItems.id, item.id));
      return;
    }
    case 'flagged_receipt': {
      await requireScopedReceipt(tx, scope, item.id);
      await tx
        .update(receipts)
        .set({ needsReview: false })
        .where(and(eq(receipts.id, item.id), eq(receipts.householdId, scope.householdId)));
      return;
    }
    case 'ambiguous_match': {
      const pending = await pendingCandidatesFor(tx, scope, item.id);
      // Nothing pending (already resolved, or never had candidates): the
      // decision row alone records the human's answer.
      if (pending.length === 0) return;
      await resolveAmbiguity(tx, bestCandidate(pending).id, pending);
      return;
    }
    case 'unmatched_txn':
      // Nothing to change: there is no match row and the transaction stands.
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
      await loadScopedReceiptItem(tx, scope, item.id);
      await tx
        .update(receiptItems)
        .set({ needsReview: false })
        .where(eq(receiptItems.id, item.id));
      return;
    }
    case 'flagged_receipt': {
      await requireScopedReceipt(tx, scope, item.id);
      await tx
        .update(receipts)
        .set({ needsReview: false })
        .where(and(eq(receipts.id, item.id), eq(receipts.householdId, scope.householdId)));
      return;
    }
    default:
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
      const categoryId = resolveCategoryId(correction.categoryId);
      const row = await loadScopedReceiptItem(tx, scope, item.id);

      await tx
        .update(receiptItems)
        .set({ categoryId, categoryConfidence: 1.0, needsReview: false })
        .where(eq(receiptItems.id, item.id));

      // Learn: the next receipt carrying this SKU gets the category for free.
      await learnFromHuman(tx, {
        store: row.store,
        skuOrAbbrev: row.sku ?? row.rawDescription,
        canonicalName: row.canonicalName ?? row.rawDescription,
        category: categoryId,
      });
      return;
    }

    case 'pickMatchCandidateId': {
      requireItemType(item, 'ambiguous_match', correction.variant);

      // The candidate must be one of THIS transaction's match rows, and the
      // transaction must be in this household.
      const candidate = await tx
        .select({ id: matches.id })
        .from(matches)
        .innerJoin(transactions, eq(matches.transactionId, transactions.id))
        .innerJoin(accounts, eq(transactions.accountId, accounts.id))
        .where(
          and(
            eq(matches.id, correction.candidateId),
            eq(matches.transactionId, item.id),
            eq(accounts.householdId, scope.householdId),
          ),
        )
        .limit(1);

      if (!candidate[0]) {
        throw new CorrectionError(
          'candidate_mismatch',
          `match "${correction.candidateId}" is not a candidate for transaction "${item.id}"`,
        );
      }

      const pending = await pendingCandidatesFor(tx, scope, item.id);
      await resolveAmbiguity(tx, correction.candidateId, pending);
      return;
    }

    case 'editResolution': {
      requireItemType(item, 'sku_resolution', correction.variant);
      const categoryId = resolveCategoryId(correction.category);
      await loadScopedReceiptItem(tx, scope, item.id);

      await learnFromHuman(tx, {
        store: correction.store,
        skuOrAbbrev: correction.skuOrAbbrev,
        canonicalName: correction.canonicalName,
        category: categoryId,
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
        .where(eq(receiptItems.id, item.id));
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

    // 3. Recompute rollups — inside the transaction so a failure rolls back
    //    every write above. Affected set: [item.id], never the household.
    await gw.recomputeRollups(scope, [item.id]);
  });

  return { removedItemId: item.id };
}
