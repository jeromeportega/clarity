import type { QueueItemType } from '../../../../../../../modules/finance/core/queue/types';
import type { CorrectionVariant } from '../../../../../../../modules/finance/core/corrections/apply';

export const VALID_ITEM_TYPES: readonly QueueItemType[] = [
  'sku_resolution',
  'ambiguous_match',
  'missing_receipt',
  'flagged_receipt',
];

export const VALID_CORRECTION_VARIANTS: readonly CorrectionVariant['variant'][] = [
  'pickCategoryId',
  'pickMatchCandidateId',
  'editResolution',
];

/** Every free-text field a correction carries is capped; ids and names are short. */
export const MAX_FIELD_LEN = 128;

export function isValidItemType(v: string): v is QueueItemType {
  return (VALID_ITEM_TYPES as readonly string[]).includes(v);
}

export function isValidCorrectionVariant(v: string): v is CorrectionVariant['variant'] {
  return (VALID_CORRECTION_VARIANTS as readonly string[]).includes(v);
}

function isBoundedString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_FIELD_LEN;
}

/**
 * Validate a client-supplied correction — the ONE rule for the API route and
 * the server action alike, so a caller that skips the route gets the same
 * refusals. Returns the typed variant or the reason it was refused.
 */
export function validateCorrection(
  raw: unknown,
): { ok: true; correction: CorrectionVariant } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'correction must be an object' };
  const c = raw as Record<string, unknown>;
  if (typeof c.variant !== 'string' || !isValidCorrectionVariant(c.variant)) {
    return { ok: false, error: 'invalid correction variant' };
  }
  switch (c.variant) {
    case 'pickCategoryId':
      if (!isBoundedString(c.categoryId)) return { ok: false, error: `pickCategoryId requires non-empty categoryId (max ${MAX_FIELD_LEN} chars)` };
      return { ok: true, correction: { variant: 'pickCategoryId', categoryId: c.categoryId } };
    case 'pickMatchCandidateId':
      if (!isBoundedString(c.candidateId)) return { ok: false, error: `pickMatchCandidateId requires non-empty candidateId (max ${MAX_FIELD_LEN} chars)` };
      return { ok: true, correction: { variant: 'pickMatchCandidateId', candidateId: c.candidateId } };
    case 'editResolution': {
      for (const field of ['canonicalName', 'category'] as const) {
        if (!isBoundedString(c[field])) return { ok: false, error: `editResolution requires non-empty ${field} (max ${MAX_FIELD_LEN} chars)` };
      }
      return { ok: true, correction: { variant: 'editResolution', canonicalName: c.canonicalName as string, category: c.category as string } };
    }
  }
}
