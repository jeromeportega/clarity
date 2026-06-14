/**
 * The four uncertainty conditions that feed the review queue inbox.
 * Each type maps to one DB/gateway source in assembleQueue.
 */
export type QueueItemType =
  | 'sku_resolution'    // receipt_items.needs_review=1
  | 'ambiguous_match'   // gateway.getAmbiguousMatchGroups
  | 'unmatched_txn'     // gateway.listUnmatchedTransactions
  | 'flagged_receipt';  // receipts.needs_review=1 (arithmetic failure)

export interface QueueItem {
  /** Source record ID; combined with `type` forms the anti-join key in review_decisions. */
  id: string;
  type: QueueItemType;
  /** Human-readable explanation shown in the inbox. Always non-empty. */
  reason: string;
  /** Present where the source record carries a monetary amount; absent otherwise. */
  amountCents?: number;
}
