/**
 * The four conditions that feed the review queue inbox.
 * Each type maps to one DB/gateway source in assembleQueue.
 *
 * Three are questions the person must answer. `missing_receipt` is an offer:
 * a recent charge at a store whose receipt breaks down into items, with no
 * receipt uploaded — add one and the charge becomes items with categories.
 * An ordinary charge (fuel, rent, a restaurant) is not a queue item at all.
 */
export type QueueItemType =
  | 'sku_resolution'    // receipt_items.needs_review=1
  | 'ambiguous_match'   // gateway.getAmbiguousMatchGroups
  | 'missing_receipt'   // gateway.listUnmatchedTransactions, filtered to receipt-capable recent debits
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
  /** `missing_receipt` only: the bank charge the receipt would explain. */
  transaction?: { merchant: string; postedDate: string };
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
