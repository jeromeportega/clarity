import type { Cents } from '../money';

// =============================================================================
// The vision seam (FR-5, FR-6, FR-7).
//
// `VisionProvider` is the only contract the pipeline knows about. The default
// `npm test` gate wires `RecordedVisionProvider` (offline fixtures, no key);
// `vision:eval` wires `LiveAnthropicVisionProvider`. The core never constructs
// an Anthropic client — the caller injects whichever provider it wants
// (NFR-1, G-3).
// =============================================================================

// The bytes Claude vision will read. PDF is accepted alongside JPEG/PNG because
// the real demo receipts arrive as Costco "Orders & Purchases" PDF pages, which
// Claude reads via a document block (operator guidance). Any other media type is
// out of scope (FR-5) and is rejected at the provider boundary.
export const SUPPORTED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'application/pdf',
] as const;
export type SupportedMimeType = (typeof SUPPORTED_MIME_TYPES)[number];

export interface ReceiptImageInput {
  bytes: Uint8Array;
  mimeType: SupportedMimeType;
}

// A single extracted line. Amounts are integer cents. `linePrice` is signed
// (negative for returns/refunds); `discount` is the absolute reduction (>= 0).
export interface ExtractedLineItem {
  sku: string | null;
  rawDescription: string; // abbreviated description, verbatim off the receipt
  quantity: number;
  unitPrice: Cents | null;
  linePrice: Cents;
  discount: Cents;
}

// The structured receipt the model returns. `readable: false` means the photo
// was unreadable or the model refused — `lineItems` is then empty and nothing is
// fabricated (FR-6). Printed-only fields (`paymentHint`, `tax`, `purchasedAt`)
// are null when absent from the receipt.
export interface ExtractedReceipt {
  readable: boolean;
  store: string | null;
  purchasedAt: string | null; // ISO date
  total: Cents | null;
  tax: Cents | null;
  fees: Array<{ kind: 'crv' | 'bag' | 'bottle' | 'other'; label: string; amount: Cents }>;
  paymentHint: { method: string | null; last4: string | null } | null;
  lineItems: ExtractedLineItem[];
}

export interface VisionProvider {
  extract(input: ReceiptImageInput): Promise<ExtractedReceipt>;
}

export function isSupportedMimeType(mimeType: string): mimeType is SupportedMimeType {
  return (SUPPORTED_MIME_TYPES as readonly string[]).includes(mimeType);
}

// Thrown when a caller hands the provider a media type outside FR-5 scope
// (e.g. image/heic). This is a caller error, distinct from an unreadable photo:
// an unreadable photo still parses and yields `readable: false`.
export class UnsupportedMediaTypeError extends Error {
  constructor(public readonly mimeType: string) {
    super(
      `Unsupported media type "${mimeType}". Supported: ${SUPPORTED_MIME_TYPES.join(', ')}.`,
    );
    this.name = 'UnsupportedMediaTypeError';
  }
}

export function assertSupportedMimeType(mimeType: string): asserts mimeType is SupportedMimeType {
  if (!isSupportedMimeType(mimeType)) throw new UnsupportedMediaTypeError(mimeType);
}

// The canonical "nothing could be read" record. Used on the unreadable / refusal
// path so every provider emits an identical, item-free shape (FR-6).
export function unreadableReceipt(): ExtractedReceipt {
  return {
    readable: false,
    store: null,
    purchasedAt: null,
    total: null,
    tax: null,
    fees: [],
    paymentHint: null,
    lineItems: [],
  };
}
