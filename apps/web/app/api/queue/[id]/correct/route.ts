import { LibsqlError } from '@libsql/client';
import { createDb } from '../../../../../../../modules/finance/db/client';
import { gatewayFor } from '../../../../../../../modules/finance/core/reconciliation/gateway';
import { applyCorrection, type CorrectionVariant } from '../../../../../../../modules/finance/core/corrections/apply';
import { DEMO_HOUSEHOLD_ID } from '../../../../../../../modules/finance/core/scope';
import { VALID_ITEM_TYPES, isValidItemType, isValidCorrectionVariant } from '../_lib/validation';
import { requireMutationToken } from '../../../../lib/auth/token';

const MAX_FIELD_LEN = 128;

function validateCorrectionFields(
  correction: Record<string, unknown>,
  variant: CorrectionVariant['variant'],
): string | null {
  if (variant === 'pickCategoryId') {
    const v = correction['categoryId'];
    if (typeof v !== 'string' || v.length === 0 || v.length > MAX_FIELD_LEN) {
      return 'pickCategoryId requires non-empty categoryId (max 128 chars)';
    }
  } else if (variant === 'pickMatchCandidateId') {
    const v = correction['candidateId'];
    if (typeof v !== 'string' || v.length === 0 || v.length > MAX_FIELD_LEN) {
      return 'pickMatchCandidateId requires non-empty candidateId (max 128 chars)';
    }
  } else {
    // editResolution
    for (const field of ['store', 'skuOrAbbrev', 'canonicalName', 'category'] as const) {
      const v = correction[field];
      if (typeof v !== 'string' || v.length === 0 || v.length > MAX_FIELD_LEN) {
        return `editResolution requires non-empty ${field} (max 128 chars)`;
      }
    }
  }
  return null;
}

export async function POST(
  request: Request,
  context: { params: { id: string } | Promise<{ id: string }> },
): Promise<Response> {
  try { requireMutationToken(request); } catch (e) { if (e instanceof Response) return e; throw e; }

  const params = context.params instanceof Promise
    ? await context.params
    : context.params;
  const itemId = params.id;

  let body: { itemType: string; correction: Record<string, unknown> & { variant?: string } };
  try {
    body = await request.json() as typeof body;
  } catch {
    return new Response('Bad Request', { status: 400 });
  }
  if (!body.itemType || !isValidItemType(body.itemType)) {
    return new Response('Bad Request: invalid itemType', { status: 400 });
  }
  if (!body.correction || typeof body.correction.variant !== 'string' || !isValidCorrectionVariant(body.correction.variant)) {
    return new Response('Bad Request: invalid correction variant', { status: 400 });
  }
  const variant = body.correction.variant as CorrectionVariant['variant'];
  const fieldError = validateCorrectionFields(body.correction, variant);
  if (fieldError) {
    return new Response(`Bad Request: ${fieldError}`, { status: 400 });
  }

  const scope = { householdId: DEMO_HOUSEHOLD_ID };
  const item = { id: itemId, type: body.itemType as (typeof VALID_ITEM_TYPES)[number], reason: '' };
  const db = createDb();
  const gw = gatewayFor({
    PUBLIC_DEMO_MODE: process.env.PUBLIC_DEMO_MODE,
    RECON_BACKEND: process.env.RECON_BACKEND as 'stub' | 'live' | undefined,
  });

  try {
    const result = await applyCorrection(
      scope,
      item,
      { type: 'correct', correction: body.correction as unknown as CorrectionVariant },
      gw,
      db,
    );
    return Response.json({ removedItemId: result.removedItemId });
  } catch (err) {
    if (err instanceof LibsqlError && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return new Response('Conflict: item already decided', { status: 409 });
    }
    console.error('[queue/correct] applyCorrection failed', err);
    return new Response('Internal Server Error', { status: 500 });
  }
}
