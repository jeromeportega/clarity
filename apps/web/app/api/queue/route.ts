import { createDb } from '../../../../../modules/finance/db/client';
import { gatewayFor } from '../../../../../modules/finance/core/reconciliation/gateway';
import { assembleQueue } from '../../../../../modules/finance/core/queue/assemble';
import { DEMO_HOUSEHOLD_ID } from '../../../../../modules/finance/core/scope';
import type { HouseholdScope } from '../../../../../modules/finance/core/reconciliation/types';

/**
 * Resolves the household scope for the current request.
 * story-004-007 will replace this with proper token-based auth.
 * For now, all reads are scoped to the demo household.
 */
function resolveHouseholdScope(): HouseholdScope {
  return { householdId: DEMO_HOUSEHOLD_ID };
}

export async function GET(): Promise<Response> {
  const scope = resolveHouseholdScope();
  const gw = gatewayFor(process.env as Parameters<typeof gatewayFor>[0]);
  const db = createDb();
  const items = await assembleQueue(scope, gw, db);
  return Response.json(items);
}
