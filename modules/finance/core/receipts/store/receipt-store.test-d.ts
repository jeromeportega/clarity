import { expectTypeOf } from 'vitest';
import type {
  NewReceipt,
  NewReceiptItem,
  ReceiptItemRecord,
  ReceiptRecord,
} from './receipt-store';

// =============================================================================
// Type-level contract: the record types expose EXACTLY H1's columns. Adding a
// column H1 does not own is a compile error here — drift surfaces as a type
// failure, never as silent data. These assertions run under `npm test` via the
// Vitest typecheck project.
// =============================================================================

// Exact key sets. Add/remove/rename a column and these stop matching.
expectTypeOf<keyof ReceiptRecord>().toEqualTypeOf<
  | 'id'
  | 'householdId'
  | 'source'
  | 'store'
  | 'purchasedAt'
  | 'subtotalCents'
  | 'taxCents'
  | 'totalCents'
  | 'paymentLast4'
  | 'imageHash'
  | 'needsReview'
  | 'createdAt'
>();

expectTypeOf<keyof ReceiptItemRecord>().toEqualTypeOf<
  | 'id'
  | 'receiptId'
  | 'lineNo'
  | 'sku'
  | 'rawDescription'
  | 'canonicalName'
  | 'categoryId'
  | 'quantity'
  | 'unitPriceCents'
  | 'linePriceCents'
  | 'discountCents'
  | 'nameConfidence'
  | 'categoryConfidence'
  | 'refundDestination'
  | 'needsReview'
  | 'createdAt'
>();

// H1 columns present; non-H1 columns from the architect's earlier sketch absent.
expectTypeOf<ReceiptRecord>().toHaveProperty('source');
expectTypeOf<ReceiptRecord>().toHaveProperty('subtotalCents');
expectTypeOf<ReceiptRecord>().not.toHaveProperty('paymentMethod');
expectTypeOf<ReceiptItemRecord>().toHaveProperty('categoryId');
expectTypeOf<ReceiptItemRecord>().toHaveProperty('refundDestination');
expectTypeOf<ReceiptItemRecord>().not.toHaveProperty('resolutionSource');

// New* are the records minus the store-assigned columns.
expectTypeOf<NewReceipt>().toEqualTypeOf<Omit<ReceiptRecord, 'id' | 'createdAt'>>();
expectTypeOf<NewReceiptItem>().toEqualTypeOf<Omit<ReceiptItemRecord, 'id' | 'createdAt'>>();

const baseReceipt: NewReceipt = {
  householdId: 'household-1',
  source: 'photo',
  store: null,
  purchasedAt: null,
  subtotalCents: null,
  taxCents: null,
  totalCents: null,
  paymentLast4: null,
  imageHash: 'x',
  needsReview: false,
};

// @ts-expect-error 'paymentMethod' is not an H1 column — drift must not compile.
const driftReceipt: NewReceipt = { ...baseReceipt, paymentMethod: 'visa' };
void driftReceipt;

const baseItem: NewReceiptItem = {
  receiptId: 'receipt-1',
  lineNo: 1,
  sku: null,
  rawDescription: 'x',
  canonicalName: null,
  categoryId: null,
  quantity: 1,
  unitPriceCents: null,
  linePriceCents: 0,
  discountCents: 0,
  nameConfidence: null,
  categoryConfidence: null,
  refundDestination: null,
  needsReview: false,
};

// @ts-expect-error 'resolutionSource' is not an H1 receipt_items column.
const driftItem: NewReceiptItem = { ...baseItem, resolutionSource: 'auto' };
void driftItem;
