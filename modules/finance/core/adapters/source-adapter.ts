import type {
  NormalizedOrder,
  NormalizedReceipt,
  NormalizedTransaction,
} from '../model/normalized';

/**
 * The single normalization seam (FR-9). Every import source — bank exports,
 * Amazon order history, future retailer APIs or `.eml` files — implements this
 * one interface, so the ingest pipeline never learns about source formats.
 */

export type SourceKind = 'bank' | 'amazon' | 'receipt' | 'retailer-api' | 'eml';

export interface RawInput {
  kind: SourceKind;
  filename: string;
  /** File bytes only — never a live network connection or credentials (NFR-3). */
  bytes: Uint8Array;
  mimeType?: string;
}

/** A malformed row that could not be normalized; surfaced, never silently dropped (FR-20). */
export interface ImportError {
  rowRef: string;
  reason: string;
  raw?: unknown;
}

/**
 * The uniform output of every adapter. A given adapter fills only the array(s)
 * relevant to its source (a bank adapter fills `transactions`, an order adapter
 * fills `orders`); the others stay empty. The looser type buys one uniform seam
 * across all sources (ADR-007). `receipts` is empty throughout H1.
 */
export interface NormalizedBatch {
  transactions: NormalizedTransaction[];
  orders: NormalizedOrder[];
  receipts: NormalizedReceipt[];
  errors: ImportError[];
}

export interface SourceAdapter {
  readonly kind: SourceKind;
  /** Cheap, side-effect-free test of whether this adapter can handle the input. */
  supports(input: RawInput): boolean;
  /** Parse the bytes into the common model. May be async (e.g. workbook parsing). */
  normalize(input: RawInput): NormalizedBatch | Promise<NormalizedBatch>;
}

/** Thrown by adapter slots that are declared but not yet implemented (FR-9). */
export class NotImplementedError extends Error {
  constructor(message = 'not implemented') {
    super(message);
    this.name = 'NotImplemented';
  }
}
