import type { Cents } from '../money';

// =============================================================================
// The H1 boundary (FR-16, FR-17).
//
// These record types model H1's `receipts` / `receipt_items` tables and expose
// ONLY the columns H1 owns. They are the single contract between H2 (this
// module) and H1's persistence layer.
//
// Column set is fixed by H1 (story-001-002):
//   receipts:      id, household_id, source, store, purchased_at, subtotal_cents,
//                  tax_cents, total_cents, payment_last4, image_hash,
//                  needs_review, created_at
//   receipt_items: id, receipt_id, line_no, sku, raw_description, canonical_name,
//                  category_id, quantity, unit_price_cents, line_price_cents,
//                  discount_cents, name_confidence, category_confidence,
//                  refund_destination, needs_review, created_at
//
// If H2 finds it needs a column not in this list, that is a contract
// negotiation with H1 — NEVER a unilateral column add here. The type-level
// contract test asserts that any extra column is a compile error, so drift
// surfaces as a TypeScript failure rather than silent data loss.
// =============================================================================

// Where a refund's value goes. `card` lands as a bank-statement credit;
// `store_credit` / `gift_card` / `account_balance` never touch the bank (H1).
export type RefundDestination =
  | 'card'
  | 'store_credit'
  | 'gift_card'
  | 'account_balance';

export interface ReceiptRecord {
  id: string; // H1 app-generated UUID (text PK)
  householdId: string; // FK -> households.id (text UUID)
  source: string;
  store: string | null;
  purchasedAt: string | null; // ISO date
  subtotalCents: Cents | null;
  taxCents: Cents | null;
  totalCents: Cents | null;
  paymentLast4: string | null; // last-4 only, never a full PAN
  imageHash: string; // idempotency key (FR-2)
  needsReview: boolean;
  createdAt: string; // ISO-8601, assigned by the store on insert
}

export interface ReceiptItemRecord {
  id: string; // H1 app-generated UUID (text PK)
  receiptId: string; // FK -> receipts.id (text UUID)
  lineNo: number;
  sku: string | null;
  rawDescription: string;
  canonicalName: string | null;
  categoryId: string | null; // taxonomy member id; see ReceiptStore.listCategories
  quantity: number;
  unitPriceCents: Cents | null;
  linePriceCents: Cents; // signed; negative for returns
  discountCents: Cents; // >= 0
  nameConfidence: number | null;
  categoryConfidence: number | null;
  refundDestination: RefundDestination | null;
  needsReview: boolean;
  createdAt: string; // ISO-8601, assigned by the store on insert
}

// `id` and `created_at` are assigned by the store on insert. `receipt_id` is
// supplied by the caller to link an item to its parent receipt.
export type NewReceipt = Omit<ReceiptRecord, 'id' | 'createdAt'>;
export type NewReceiptItem = Omit<ReceiptItemRecord, 'id' | 'createdAt'>;

export interface ReceiptStore {
  findReceiptByImageHash(hash: string): Promise<ReceiptRecord | null>;
  insertReceipt(r: NewReceipt): Promise<ReceiptRecord>;
  insertReceiptItems(items: NewReceiptItem[]): Promise<ReceiptItemRecord[]>;
  // SOLE source of the category taxonomy. Every downstream story reads the
  // allowed categories through this method; a category outside it is invalid.
  listCategories(): Promise<readonly string[]>;
}
