// Single source of the tunable knobs (FR-12, FR-14, FR-15, NFR-3). Stories 002
// and 004 receive threshold/ratio as plain `number` arguments at their call
// sites (passed down by processReceipt); they do not import this interface, to
// avoid a back-dependency on the entry point.
export interface ReceiptConfig {
  confidenceThreshold: number; // default 0.80
  arithmeticToleranceCents: number; // default 2
  similarityRatio: number; // default 0.85
}

export const DEFAULT_RECEIPT_CONFIG: ReceiptConfig = {
  confidenceThreshold: 0.8,
  arithmeticToleranceCents: 2,
  similarityRatio: 0.85,
};
