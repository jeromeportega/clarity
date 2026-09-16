// =============================================================================
// Where the receipt images live.
//
// The pipeline persists what a receipt SAYS (`receipts` / `receipt_items`);
// the bytes the human photographed are evidence and live behind this seam,
// addressed by a key derived from what the receipt row already carries — the
// household and the image hash — so no column links the two and a digital
// receipt (whose hash is not of any image) simply has no image.
//
// Core defines the port and a local-file implementation for dev and tests;
// the app layer supplies the durable one (Vercel Blob) — core never
// constructs an SDK client.
// =============================================================================

export interface StoredImage {
  bytes: Uint8Array;
  mimeType: string;
}

export interface ImageStore {
  /** Idempotent: writing the same key again replaces the bytes. */
  put(key: string, bytes: Uint8Array, mimeType: string): Promise<void>;
  get(key: string): Promise<StoredImage | null>;
}

/** Keys are `receipts/<householdId>/<imageHash>`; both parts are opaque ids. */
export function receiptImageKey(householdId: string, imageHash: string): string {
  return `receipts/${householdId}/${imageHash}`;
}

/**
 * A key is a path of plain segments — nothing a filesystem or URL could read
 * as "up" or "root". Every implementation checks this before touching storage.
 */
export function assertSafeImageKey(key: string): void {
  const segments = key.split('/');
  const ok =
    segments.length >= 2 &&
    segments.every((s) => s.length > 0 && s !== '.' && s !== '..' && /^[A-Za-z0-9._:@+-]+$/.test(s));
  if (!ok) throw new Error(`unsafe image key: ${JSON.stringify(key)}`);
}
