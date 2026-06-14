// Public surface of the receipts core (epic contract §0). The single entry
// point plus the types and pure helpers a caller needs to wire dependencies and
// read results. Concrete providers/stores are imported directly from their own
// files by whoever constructs the dependency bundle.

export { processReceipt } from './process-receipt';
export type { ReceiptPipelineDeps, ProcessReceiptResult } from './process-receipt';

export { reconcile } from './reconcile';
export type { ReconcileResult } from './reconcile';

export { DEFAULT_RECEIPT_CONFIG } from './config';
export type { ReceiptConfig } from './config';

export { imageHash } from './image-hash';
export type { Cents } from './money';

// Sørensen–Dice bigram similarity coefficient — the single canonical
// implementation, shared by H2's eval harness and H3's matching engine
// (receipt↔bank and Amazon↔bank matchers import it from here, FR-1).
export { similarityRatio } from './resolver/similarity';

export type {
  NewReceipt,
  NewReceiptItem,
  ReceiptItemRecord,
  ReceiptRecord,
  ReceiptStore,
} from './store/receipt-store';

export type { SkuDictionary, DictionaryEntry } from './dictionary/sku-dictionary';
export type { Resolution, ResolutionQuery, SkuResolver } from './resolver/sku-resolver';
export type {
  ExtractedLineItem,
  ExtractedReceipt,
  ReceiptImageInput,
  VisionProvider,
} from './vision/vision-provider';
