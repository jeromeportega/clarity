import { createDb } from '../../../modules/finance/db/client';
import { gatewayFor } from '../../../modules/finance/core/reconciliation/gateway';
import { assembleQueue } from '../../../modules/finance/core/queue/assemble';
import { DEMO_HOUSEHOLD_ID } from '../../../modules/finance/core/scope';
import type { HouseholdScope } from '../../../modules/finance/core/reconciliation/types';
import type { QueueItem } from '../../../modules/finance/core/queue/types';

export function resolveHouseholdScope(): HouseholdScope {
  return { householdId: DEMO_HOUSEHOLD_ID };
}

export async function fetchQueue(scope: HouseholdScope): Promise<QueueItem[]> {
  const db = createDb();
  const gw = gatewayFor({
    PUBLIC_DEMO_MODE: process.env.PUBLIC_DEMO_MODE,
    RECON_BACKEND: process.env.RECON_BACKEND as 'stub' | 'live' | undefined,
  });
  return assembleQueue(scope, gw, db);
}
