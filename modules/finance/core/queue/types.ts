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
  /**
   * `flagged_receipt` only: the photo could not be read (zero items, placeholder
   * row). Such a receipt can be read again; others are decided in the queue.
   */
  unreadable?: boolean;
  /**
   * What the person needs in front of them to decide, for the two receipt-borne
   * types: which receipt (store, date), what the model made of the line
   * (`sku_resolution` only), and whether a photo can be shown.
   */
  context?: QueueItemContext;
}

export interface QueueItemContext {
  receiptId: string;
  store: string | null;
  purchasedAt: string | null;
  /** True when the receipt came from a photo the image store may hold. */
  hasImage: boolean;
  /** `sku_resolution`: the model's current answer for the line. */
  sku?: string | null;
  canonicalName?: string | null;
  categoryId?: string | null;
  quantity?: number;
  /** `flagged_receipt`: how many lines the read produced. */
  itemCount?: number;
}
