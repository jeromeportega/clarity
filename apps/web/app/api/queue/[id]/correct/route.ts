import { createDb } from '../../../../../../../modules/finance/db/client';
import { gatewayFor } from '../../../../../../../modules/finance/core/reconciliation/gateway';
import { applyCorrection } from '../../../../../../../modules/finance/core/corrections/apply';
import { DEMO_HOUSEHOLD_ID } from '../../../../../../../modules/finance/core/scope';
import type { QueueItemType } from '../../../../../../../modules/finance/core/queue/types';
import type { CorrectionVariant } from '../../../../../../../modules/finance/core/corrections/apply';

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

  let body: { itemType: QueueItemType; correction: CorrectionVariant };
  try {
    body = await request.json() as { itemType: QueueItemType; correction: CorrectionVariant };
  } catch {
    return new Response('Bad Request', { status: 400 });
  }
  if (!body.itemType || !body.correction) {
    return new Response('Bad Request: itemType and correction required', { status: 400 });
  }

  const scope = { householdId: DEMO_HOUSEHOLD_ID };
  const item = { id: itemId, type: body.itemType, reason: '' };
  const db = createDb();
  const gw = gatewayFor({
    PUBLIC_DEMO_MODE: process.env.PUBLIC_DEMO_MODE,
    RECON_BACKEND: process.env.RECON_BACKEND as 'stub' | 'live' | undefined,
  });

  try {
    const result = await applyCorrection(
      scope,
      item,
      { type: 'correct', correction: body.correction },
      gw,
      db,
    );
    return Response.json({ removedItemId: result.removedItemId });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    if (message.includes('UNIQUE') || message.includes('constraint')) {
      return new Response('Conflict: item already decided', { status: 409 });
    }
    return new Response('Internal Server Error', { status: 500 });
  }
}
