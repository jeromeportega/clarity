import type { ReceiptConfig } from './config';
import { imageHash } from './image-hash';
import { type ProcessReceiptResult, readReceipt, type ReceiptPipelineDeps } from './process-receipt';
import type { ReceiptImageInput } from './vision/vision-provider';

// =============================================================================
// Read again.
//
// A photo the model could not read is persisted as a zero-item receipt flagged
// for review, and uploads are idempotent on the image hash — so without this,
// one bad read would be permanent. `reprocessReceipt` runs the same
// extract → resolve → reconcile → flag sequence over the stored image and
// replaces what the earlier read produced, keeping the row's identity.
//
// Only a receipt with NO line items may be read again here: items can carry
// review decisions and dictionary learning that a silent replacement would
// orphan. Re-reading a receipt that already has items is a later feature with
// its own rules.
// =============================================================================

export type ReprocessOutcome =
  | { ok: true; result: ProcessReceiptResult }
  | { ok: false; code: 'not_found' | 'has_items' | 'image_mismatch' };

export async function reprocessReceipt(
  receiptId: string,
  input: ReceiptImageInput,
  deps: ReceiptPipelineDeps,
  config?: Partial<ReceiptConfig>,
): Promise<ReprocessOutcome> {
  const existing = await deps.store.getReceiptById(receiptId);
  if (!existing) return { ok: false, code: 'not_found' };

  const items = await deps.store.listReceiptItems(receiptId);
  if (items.length > 0) return { ok: false, code: 'has_items' };

  // The bytes must be the photo this row stands for: the same hash that made
  // the row unique in the first place. Anything else is a different receipt.
  if (imageHash(input.bytes) !== existing.imageHash) return { ok: false, code: 'image_mismatch' };

  const reading = await readReceipt(input, deps, config);
  const replaced = await deps.store.replaceReceiptExtraction(receiptId, reading.fields, reading.items);

  return {
    ok: true,
    result: {
      receipt: replaced.receipt,
      items: replaced.items,
      status: reading.fields.needsReview ? 'needs_review' : 'ok',
      idempotent: false,
    },
  };
}
