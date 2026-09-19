import { and, eq, sql } from 'drizzle-orm';

import type { FinanceDb } from '../../db/client';
import { receiptItems, receipts, reviewDecisions } from '../../db/schema';
import type { HouseholdScope } from '../scope';
import type { ReconciliationGateway } from '../reconciliation/types';
import { compileLearnedStores, isWithinAskWindow, receiptCapableMerchant } from './receipt-capable';
import type { QueueItem, QueueItemType } from './types';

/**
 * UNION four uncertainty sources into one review queue, then anti-join out any
 * item that already has a row in review_decisions.
 *
 * Sources:
 *   1. receipt_items.needs_review=1         → sku_resolution
 *   2. gw.getAmbiguousMatchGroups()         → ambiguous_match
 *   3. gw.listUnmatchedTransactions()       → missing_receipt — only the recent
 *      debits at receipt-capable stores (see receipt-capable.ts); every other
 *      unmatched bank line is an ordinary charge and is not a queue item
 *   4. receipts.needs_review=1              → flagged_receipt (arithmetic failure)
 *
 * Anti-join key: (type, id) must NOT appear in review_decisions
 * for this household. Same item_id under a different item_type is NOT filtered.
 *
 * Scope note: DB sources are filtered by householdId in the WHERE clause.
 * Gateway sources receive the HouseholdScope and are contractually required to
 * return only matching-household data. missing_receipt adds a defense-in-depth
 * post-filter (Transaction carries householdId); AmbiguousMatchGroup does not
 * expose householdId on its type, so the gateway contract is the sole guard for
 * that source — both the stub and live implementations enforce it at the scope
 * check inside their method bodies.
 */
export interface AssembleQueueOptions {
  /** Clock for the receipt ask window; tests pin it. */
  now?: () => Date;
}

export async function assembleQueue(
  scope: HouseholdScope,
  gw: ReconciliationGateway,
  db: FinanceDb,
  opts: AssembleQueueOptions = {},
): Promise<QueueItem[]> {
  const { householdId } = scope;
  const now = opts.now ?? (() => new Date());

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
      sku: receiptItems.sku,
      canonicalName: receiptItems.canonicalName,
      categoryId: receiptItems.categoryId,
      quantity: receiptItems.quantity,
      receiptId: receipts.id,
      store: receipts.store,
      purchasedAt: receipts.purchasedAt,
      source: receipts.source,
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
        context: {
          receiptId: row.receiptId,
          store: row.store,
          purchasedAt: row.purchasedAt,
          hasImage: hasPhoto(row.source),
          sku: row.sku,
          canonicalName: row.canonicalName,
          categoryId: row.categoryId,
          quantity: row.quantity,
        },
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

  // 3. missing_receipt — of the transactions with no match at all, the recent
  //    debits at stores whose receipt would break the charge into items. The
  //    household's own receipt history widens the store list.
  const unmatched = await gw.listUnmatchedTransactions(scope);
  if (unmatched.length > 0) {
    const storeRows = await db
      .selectDistinct({ store: receipts.store })
      .from(receipts)
      .where(eq(receipts.householdId, householdId));
    const learnedStores = compileLearnedStores(
      storeRows.map((r) => r.store).filter((s): s is string => typeof s === 'string' && s.trim().length > 0),
    );
    const today = now();
    for (const txn of unmatched) {
      // Defense-in-depth: drop any txn the gateway returned for the wrong household.
      if (txn.householdId !== householdId) continue;
      if (txn.amountCents >= 0) continue; // a refund or deposit has no receipt to add
      if (!isWithinAskWindow(txn.postedDate, today)) continue;
      const merchant = receiptCapableMerchant(txn.normalizedMerchant, learnedStores);
      if (!merchant) continue;
      if (keep('missing_receipt', txn.id)) {
        items.push({
          id: txn.id,
          type: 'missing_receipt',
          reason: `${merchant} charge — upload the receipt for an item breakdown`,
          amountCents: txn.amountCents,
          transaction: { merchant, postedDate: txn.postedDate },
        });
      }
    }
  }

  // 4. flagged_receipt — receipts that failed arithmetic validation (needs_review=1)
  const flaggedRows = await db
    .select({
      id: receipts.id,
      store: receipts.store,
      purchasedAt: receipts.purchasedAt,
      totalCents: receipts.totalCents,
      source: receipts.source,
    })
    .from(receipts)
    .where(and(eq(receipts.householdId, householdId), eq(receipts.needsReview, true)));

  // How many lines each flagged receipt has (a placeholder has none) — scoped
  // by household through the same join, never by a list of ids.
  const lineCounts = new Map<string, number>();
  const counts = await db
    .select({ receiptId: receiptItems.receiptId, n: sql<number>`count(*)` })
    .from(receiptItems)
    .innerJoin(receipts, eq(receiptItems.receiptId, receipts.id))
    .where(and(eq(receipts.householdId, householdId), eq(receipts.needsReview, true)))
    .groupBy(receiptItems.receiptId);
  for (const c of counts) lineCounts.set(c.receiptId, Number(c.n));

  for (const row of flaggedRows) {
    if (keep('flagged_receipt', row.id)) {
      // An unreadable photo is persisted as a placeholder ('' store, 0 total)
      // flagged for review; say so rather than blaming its arithmetic.
      const placeholder = row.store === '' && row.totalCents === 0;
      items.push({
        id: row.id,
        type: 'flagged_receipt',
        reason: placeholder
          ? 'Flagged receipt: photo could not be read'
          : `Flagged receipt: arithmetic check failed (${row.store})`,
        amountCents: row.totalCents,
        ...(placeholder ? { unreadable: true } : {}),
        context: {
          receiptId: row.id,
          store: placeholder ? null : row.store,
          purchasedAt: placeholder ? null : row.purchasedAt,
          hasImage: hasPhoto(row.source),
          itemCount: lineCounts.get(row.id) ?? 0,
        },
      });
    }
  }

  return items;
}

// Only a photographed receipt has an image behind it; digital imports (the
// Costco export) are keyed by their own transaction id and have none.
function hasPhoto(source: string): boolean {
  return source === 'photo';
}
