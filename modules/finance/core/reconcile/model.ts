import type { RefundDestination } from '../model/normalized';

export type Cents = number; // signed integer cents

// ── Sign convention (frozen — flip happens ONCE, here, at ingestion) ──
//   bank purchase debit  amountCents < 0  → LedgerEvent.signedSpendCents > 0  (consumption)
//   bank/card refund     amountCents > 0  → LedgerEvent.signedSpendCents < 0  (value returning)
//   netSpendCents = Σ events.signedSpendCents
// Any consumer re-deriving sign elsewhere is a bug.

/**
 * The single bank-sign → spend-sign flip. Lives here so it happens exactly once.
 * bank debit purchase: amountCents < 0 → signedSpendCents > 0 (money consumed)
 * bank credit refund:  amountCents > 0 → signedSpendCents < 0 (value returning)
 */
export function bankSignToSignedSpend(amountCents: Cents): Cents {
  return amountCents === 0 ? 0 : -amountCents;
}

// ── Inputs (built by ReconcileSource) ──

export interface BankLine {
  id: string;
  accountId: string;
  postedDate: string; // ISO YYYY-MM-DD
  amountCents: Cents;
  direction: 'debit' | 'credit';
  normalizedMerchant: string;
  lastFour?: string;
}

export interface OrderItemView {
  id: string;
  shipmentId: string;
  description: string;
  amountCents: Cents;
  isReturn: boolean;
  refundDestination?: RefundDestination;
}

export interface OrderView {
  id: string;
  externalOrderId: string;
  orderDate: string; // ISO YYYY-MM-DD
  orderTotalCents?: Cents;
  items: OrderItemView[];
}

export interface ReceiptItemView {
  id: string;
  description?: string;
  amountCents: Cents;
}

export interface ReceiptView {
  id: string;
  merchant?: string;
  capturedAt?: string; // ISO YYYY-MM-DD
  totalCents?: Cents;
  lastFour?: string;
  items: ReceiptItemView[];
}

export interface StoreCreditAccrual {
  id: string;
  kind: 'store_credit' | 'gift_card' | 'account_balance';
  amountCents: Cents;
  occurredAt: string; // ISO YYYY-MM-DD
  orderId?: string;
  orderItemId?: string;
}

export interface ReconcileInputs {
  householdId: string;
  bankLines: BankLine[];
  orders: OrderView[];
  receipts: ReceiptView[];
  storeCreditAccruals: StoreCreditAccrual[];
}

// ── Outputs ──

export type MatchType =
  | 'receipt_bank'
  | 'order_bank'
  | 'order_bank_split'
  | 'refund_card'
  | 'store_credit_refund'
  | 'store_credit_drawdown'
  | 'dedup_merge';

export interface MatchRecord {
  id: string;
  type: MatchType;
  transactionId?: string;
  orderId?: string;
  orderItemId?: string;
  receiptId?: string;
  receiptItemId?: string;
  storeCreditBalanceId?: string;
  confidence: number; // [0,1]
  rationale: string; // FR-3
  status: 'auto_linked' | 'review'; // < confidenceThreshold ⇒ 'review' (FR-4)
}

export interface ClassifiedItem {
  itemRef: { receiptItemId?: string; orderItemId?: string };
  category: string; // ∈ H1 taxonomy
  rationale: string; // FR-10
  source: 'item_heuristic' | 'recurring' | 'merchant_fallback' | 'llm';
}

export interface LedgerEvent {
  id: string;
  signedSpendCents: Cents;
  occurredOn: string; // YYYY-MM-DD
  fundedBy: 'bank' | 'store_credit' | 'bank+store_credit';
  sources: { transactionId?: string; orderId?: string; receiptId?: string };
  mergedItems: ClassifiedItem[];
  categoryFallback?: string;
}

export interface StoreCreditDrawdown {
  id: string;
  kind: StoreCreditAccrual['kind'];
  amountCents: Cents; // < 0
  occurredAt: string;
  reason: 'partial_payment' | 'manual';
  orderId?: string;
}

export interface ReconciledLedger {
  events: LedgerEvent[];
  matches: MatchRecord[];
  reviewQueue: MatchRecord[];
  storeCreditDrawdowns: StoreCreditDrawdown[];
  unmatched: { bankLines: string[]; orderItems: string[]; receipts: string[] };
  netSpendCents: Cents; // Σ events.signedSpendCents (FR-9)
}
