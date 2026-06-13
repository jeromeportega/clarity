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
 * H2 (Receipt Vision) shape. Declared now as part of the cross-epic contract but
 * unused in H1 — adapters return an empty `receipts` array.
 */
export interface NormalizedReceipt {
  [key: string]: never;
}
