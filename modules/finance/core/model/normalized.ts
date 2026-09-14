/**
 * Normalized domain model — the common shape every {@link SourceAdapter} produces,
 * independent of the source format. Money is signed integer cents and dates are
 * ISO `YYYY-MM-DD` text, matching the persistence layer (ADR-001):
 *   - negative = money leaving / a return line
 *   - positive = money entering / a purchase line
 *
 * Pure TypeScript: no Next.js / React imports may appear under
 * `modules/finance/core` (ADR-009, enforced by the core-boundary test).
 */

export interface NormalizedTransaction {
  /** Posting date, ISO `YYYY-MM-DD`. */
  postedDate: string;
  /** Signed amount in cents. */
  amountCents: number;
  direction: 'debit' | 'credit';
  rawMerchant?: string;
  normalizedMerchant: string;
  /** Stable hash of the source row; the adapter computes it via `sha256Hex`. */
  sourceRowHash: string;
}

export type RefundDestination = 'card' | 'store_credit' | 'gift_card' | 'account_balance';

export interface NormalizedOrderItem {
  /** Per-shipment identifier: one order can ship in several parcels. */
  shipmentId: string;
  itemSeq: number;
  description: string;
  quantity: number;
  unitPriceCents?: number;
  /** Signed: a return / refund line is negative (FR-15). */
  amountCents: number;
  isReturn: boolean;
  /** Set only where the source states it; drives the store-credit ledger (FR-14). */
  refundDestination?: RefundDestination;
  sourceRowHash: string;
}

export interface NormalizedOrder {
  source: 'amazon';
  externalOrderId: string;
  /** ISO `YYYY-MM-DD`. */
  orderDate: string;
  /** ISO currency code; defaults to `USD`. */
  currency: string;
  orderTotalCents?: number;
  items: NormalizedOrderItem[];
}

/**
 * One line of a receipt produced by a file-based receipt source (e.g. a
 * retailer's digital-receipt export). Mirrors `receipt_items` and the vision
 * pipeline's conventions: `linePriceCents` is signed and gross (before
 * `discountCents`, which is >= 0), so `Σ linePrice − Σ discount + tax ≈ total`.
 */
export interface NormalizedReceiptItem {
  lineNo: number;
  /** The retailer's item code as printed (a Costco item number, a SKU), else null. */
  sku: string | null;
  /** The description as printed on the receipt. */
  rawDescription: string;
  /** The retailer's own canonical product name when the source supplies one. */
  canonicalName: string | null;
  quantity: number;
  unitPriceCents?: number | null;
  /** Signed: negative on a refund receipt. Gross of `discountCents`. */
  linePriceCents: number;
  /** Instant savings / coupons folded onto this line; >= 0. */
  discountCents: number;
  /** Set only on refund lines where the source states where the money went. */
  refundDestination?: RefundDestination;
  /** True when the line still needs a human or the resolver (no canonical name). */
  needsReview: boolean;
  sourceRowHash: string;
}

/**
 * A whole receipt from a file-based receipt source. Persisted into `receipts`
 * / `receipt_items`, the same tables the vision pipeline writes, so digital and
 * photographed receipts flow through one reconciliation and review path.
 */
export interface NormalizedReceipt {
  /** e.g. `costco_digital`; stored in `receipts.source`. */
  source: string;
  /** Merchant as a bank line would print it (e.g. `COSTCO WHSE #0021`), for matching. */
  store: string;
  /** ISO `YYYY-MM-DD`, the retailer's local purchase date. */
  purchasedAt: string;
  subtotalCents: number | null;
  taxCents: number | null;
  /** Signed: negative for a refund receipt. */
  totalCents: number;
  /** Last four digits of the tender, never more; null when not a card or not printed. */
  paymentLast4: string | null;
  /**
   * Idempotency key stored in `receipts.image_hash`: a stable hash of the
   * source's own transaction identifier, so re-importing the same export is a
   * no-op — the same role the image hash plays for photographed receipts.
   */
  sourceHash: string;
  /** True when the receipt's own arithmetic does not reconcile. */
  needsReview: boolean;
  items: NormalizedReceiptItem[];
}
