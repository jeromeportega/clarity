import { createHash } from 'node:crypto';

// Idempotency key for a receipt photo (FR-2) and the fixture key shared by the
// recorded vision provider (story-002-003) and the pipeline (story-002-005).
// SHA-256 hex of the raw image bytes.
export function imageHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
