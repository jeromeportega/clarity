import { and, eq } from 'drizzle-orm';

import type { FinanceDb } from '../../db/client';
import { receiptItems, receipts, reviewDecisions } from '../../db/schema';
import type { HouseholdScope } from '../scope';
import type { ReconciliationGateway } from '../reconciliation/types';
import type { QueueItem, QueueItemType } from './types';

/**
 * UNION four uncertainty sources into one review queue, then anti-join out any
 * item that already has a row in review_decisions.
 *
 * Sources:
 *   1. receipt_items.needs_review=1         → sku_resolution
 *   2. gw.getAmbiguousMatchGroups()         → ambiguous_match
 *   3. gw.listUnmatchedTransactions()       → unmatched_txn
 *   4. receipts.needs_review=1              → flagged_receipt (arithmetic failure)
 *
 * Anti-join key: (type, id) must NOT appear in review_decisions
 * for this household. Same item_id under a different item_type is NOT filtered.
 *
 * Scope note: DB sources are filtered by householdId in the WHERE clause.
 * Gateway sources receive the HouseholdScope and are contractually required to
 * return only matching-household data. unmatched_txn adds a defense-in-depth
 * post-filter (Transaction carries householdId); AmbiguousMatchGroup does not
 * expose householdId on its type, so the gateway contract is the sole guard for
 * that source — both the stub and live implementations enforce it at the scope
 * check inside their method bodies.
 */
export async function assembleQueue(
  scope: HouseholdScope,
  gw: ReconciliationGateway,
  db: FinanceDb,
): Promise<QueueItem[]> {
  const { householdId } = scope;

  // Build the decided set for the anti-join: Set<"type::id">
  const decided = await db
    .select({ itemType: reviewDecisions.itemType, itemId: reviewDecisions.itemId })
    .from(reviewDecisions)
    .where(eq(reviewDecisions.householdId, householdId));

  const decidedSet = new Set(decided.map((d) => `${d.itemType}::${d.itemId}`));

  function keep(type: QueueItemType, id: string): boolean {
    return !decidedSet.has(`${type}::${id}`);
  }

  const items: QueueItem[] = [];

  // 1. sku_resolution — receipt_items that need SKU review, scoped via parent receipt
  const skuRows = await db
    .select({
      id: receiptItems.id,
      rawDescription: receiptItems.rawDescription,
      linePriceCents: receiptItems.linePriceCents,
    })
    .from(receiptItems)
    .innerJoin(receipts, eq(receiptItems.receiptId, receipts.id))
    .where(and(eq(receipts.householdId, householdId), eq(receiptItems.needsReview, true)));

  for (const row of skuRows) {
    if (keep('sku_resolution', row.id)) {
      items.push({
        id: row.id,
        type: 'sku_resolution',
        reason: `Low-confidence SKU resolution: "${row.rawDescription}"`,
        amountCents: row.linePriceCents,
      });
    }
  }

  // 2. ambiguous_match — gateway surfaces transaction groups with multiple candidates
  const groups = await gw.getAmbiguousMatchGroups(scope);
  for (const group of groups) {
    if (keep('ambiguous_match', group.transactionId)) {
      items.push({
        id: group.transactionId,
        type: 'ambiguous_match',
        reason: `Ambiguous match: ${group.candidates.length} candidate${group.candidates.length === 1 ? '' : 's'} for transaction`,
      });
    }
  }

  // 3. unmatched_txn — gateway surfaces transactions with no match at all
  const unmatched = await gw.listUnmatchedTransactions(scope);
  for (const txn of unmatched) {
    // Defense-in-depth: drop any txn the gateway returned for the wrong household.
    if (txn.householdId !== householdId) continue;
    if (keep('unmatched_txn', txn.id)) {
      items.push({
        id: txn.id,
        type: 'unmatched_txn',
        reason: `Unmatched transaction: ${txn.normalizedMerchant}`,
        amountCents: txn.amountCents,
      });
    }
  }

  // 4. flagged_receipt — receipts that failed arithmetic validation (needs_review=1)
  const flaggedRows = await db
    .select({
      id: receipts.id,
      store: receipts.store,
      totalCents: receipts.totalCents,
    })
    .from(receipts)
    .where(and(eq(receipts.householdId, householdId), eq(receipts.needsReview, true)));

  for (const row of flaggedRows) {
    if (keep('flagged_receipt', row.id)) {
      items.push({
        id: row.id,
        type: 'flagged_receipt',
        reason: `Flagged receipt: arithmetic check failed (${row.store})`,
        amountCents: row.totalCents,
      });
    }
  }

  return items;
}
