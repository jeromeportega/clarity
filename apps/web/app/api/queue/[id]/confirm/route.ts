import { LibsqlError } from '@libsql/client';
import { createDb } from '../../../../../../../modules/finance/db/client';
import { gatewayFor } from '../../../../../../../modules/finance/core/reconciliation/gateway';
import { applyCorrection, CorrectionError } from '../../../../../../../modules/finance/core/corrections/apply';
import { DEMO_HOUSEHOLD_ID } from '../../../../../../../modules/finance/core/scope';
import { VALID_ITEM_TYPES, isValidItemType } from '../_lib/validation';
import { requireMutationToken } from '../../../../lib/auth/token';
import { reconcileAfterWrite } from '../../../../../lib/reconcile';

export async function POST(
  request: Request,
  context: { params: { id: string } | Promise<{ id: string }> },
): Promise<Response> {
  const denied = requireMutationToken(request);
  if (denied) return denied;

  const params = context.params instanceof Promise
    ? await context.params
    : context.params;
  const itemId = params.id;

  let body: { itemType: string };
  try {
    body = await request.json() as { itemType: string };
  } catch {
    return new Response('Bad Request', { status: 400 });
  }
  if (!body.itemType || !isValidItemType(body.itemType)) {
    return new Response('Bad Request: invalid itemType', { status: 400 });
  }

  const scope = { householdId: DEMO_HOUSEHOLD_ID };
  const item = { id: itemId, type: body.itemType as (typeof VALID_ITEM_TYPES)[number], reason: '' };
  const db = createDb();
  const gw = gatewayFor({
    PUBLIC_DEMO_MODE: process.env.PUBLIC_DEMO_MODE,
    RECON_BACKEND: process.env.RECON_BACKEND as 'stub' | 'live' | undefined,
  }, db);

  try {
    const result = await applyCorrection(scope, item, { type: 'confirm' }, gw, db);
    // A decision about a match changes what the engine must honour: re-derive
    // the household's matches now, so the queue and True Spend read the new
    // truth. Item-level decisions (SKU, flagged receipt) change no match.
    const reconciliation = item.type === 'ambiguous_match'
      ? await reconcileAfterWrite(db, scope.householdId)
      : undefined;
    return Response.json({
      removedItemId: result.removedItemId,
      ...(reconciliation ? { reconciled: !('error' in reconciliation), reconciliation } : {}),
    });
  } catch (err) {
    if (err instanceof LibsqlError && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return new Response('Conflict: item already decided', { status: 409 });
    }
    // The decision cannot apply to this item (e.g. not in this household).
    if (err instanceof CorrectionError) {
      return Response.json({ error: err.code, message: err.message }, { status: 400 });
    }
    console.error('[queue/confirm] applyCorrection failed', err);
    return new Response('Internal Server Error', { status: 500 });
  }
}
