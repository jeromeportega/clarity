/**
 * Normalized image-region bounding box, as fractions [0, 1] of image dimensions.
 * Stored as JSON text in receipt_items.bbox (NULL when H2 did not extract coordinates).
 */
export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Discriminated union of evidence sources. One of three kinds:
 *   receipt_region  — the item came from a scanned receipt (image evidence)
 *   amazon_order_row — the item came from an Amazon order export
 *   bank_line        — the item is a raw bank transaction line
 *
 * receipt_region degrades gracefully: when receipt_items.bbox is NULL,
 * bbox is omitted and the UI links the whole image (ADR-007/FR-8).
 */
export type EvidenceRef =
  | { kind: 'receipt_region'; receiptId: string; imageUrl: string; bbox?: BoundingBox }
  | { kind: 'amazon_order_row'; orderId: string; orderItemId: string }
  | { kind: 'bank_line'; transactionId: string };

/** Returned when no record matches the given itemId across all source tables. */
export interface EvidenceError {
  kind: 'not_found';
  itemId: string;
}

export type EvidenceResult = EvidenceRef | EvidenceError;
