import { processReceipt, type ReceiptPipelineDeps, type ProcessReceiptResult } from './process-receipt';
import { SUPPORTED_MIME_TYPES, type SupportedMimeType } from './vision/vision-provider';

export const DEFAULT_MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MiB

// Passes through the H2 result shape verbatim — callers can type-check against
// ProcessReceiptResult or UploadedReceiptResult interchangeably.
export type UploadedReceiptResult = ProcessReceiptResult;

export type UploadError =
  | { code: 'MIME_REJECTED'; mimeType: string }
  | { code: 'SIZE_EXCEEDED'; sizeBytes: number; maxBytes: number };

export type UploadOutcome =
  | { ok: true; result: UploadedReceiptResult }
  | { ok: false; error: UploadError };

// Narrow gate: only accept the MIME types the vision provider can process.
// SVG is excluded despite being an image/* because it can embed scripts.
export function isAcceptedUploadMime(mimeType: string): boolean {
  return (SUPPORTED_MIME_TYPES as readonly string[]).includes(mimeType);
}

// Validate then invoke the H2 pipeline. Validation (MIME, size) is always
// checked BEFORE processReceipt is called — the caller can assert this via a
// spy on processReceipt that must NOT have been invoked on rejection paths.
export async function handleReceiptUpload(
  bytes: Uint8Array,
  mimeType: string,
  deps: ReceiptPipelineDeps,
  opts?: { maxSizeBytes?: number },
): Promise<UploadOutcome> {
  if (!isAcceptedUploadMime(mimeType)) {
    return { ok: false, error: { code: 'MIME_REJECTED', mimeType } };
  }
  const maxBytes = opts?.maxSizeBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  if (bytes.length > maxBytes) {
    return { ok: false, error: { code: 'SIZE_EXCEEDED', sizeBytes: bytes.length, maxBytes } };
  }
  const result = await processReceipt({ bytes, mimeType: mimeType as SupportedMimeType }, deps);
  return { ok: true, result };
}
