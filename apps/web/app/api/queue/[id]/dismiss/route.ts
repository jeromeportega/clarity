import { LibsqlError } from '@libsql/client';
import { createDb } from '../../../../../../../modules/finance/db/client';
import { gatewayFor } from '../../../../../../../modules/finance/core/reconciliation/gateway';
import { applyCorrection } from '../../../../../../../modules/finance/core/corrections/apply';
import { DEMO_HOUSEHOLD_ID } from '../../../../../../../modules/finance/core/scope';
import { VALID_ITEM_TYPES } from '../_lib/validation';

export async function POST(
  request: Request,
  context: { params: { id: string } | Promise<{ id: string }> },
): Promise<Response> {
  const token = process.env.RECONCILE_MUTATION_TOKEN;
  const authHeader = request.headers.get('authorization');
  if (!token || authHeader !== `Bearer ${token}`) {
    return new Response('Unauthorized', { status: 401 });
  }

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
  if (!body.itemType || !VALID_ITEM_TYPES.includes(body.itemType as never)) {
    return new Response('Bad Request: invalid itemType', { status: 400 });
  }

  const scope = { householdId: DEMO_HOUSEHOLD_ID };
  const item = { id: itemId, type: body.itemType as (typeof VALID_ITEM_TYPES)[number], reason: '' };
  const db = createDb();
  const gw = gatewayFor({
    PUBLIC_DEMO_MODE: process.env.PUBLIC_DEMO_MODE,
    RECON_BACKEND: process.env.RECON_BACKEND as 'stub' | 'live' | undefined,
  });

  try {
    const result = await applyCorrection(scope, item, { type: 'dismiss' }, gw, db);
    return Response.json({ removedItemId: result.removedItemId });
  } catch (err) {
    if (err instanceof LibsqlError && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return new Response('Conflict: item already decided', { status: 409 });
    }
    return new Response('Internal Server Error', { status: 500 });
  }
}
