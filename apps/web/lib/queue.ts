import { createDb } from '../../../modules/finance/db/client';
import { gatewayFor } from '../../../modules/finance/core/reconciliation/gateway';
import { assembleQueue } from '../../../modules/finance/core/queue/assemble';
import { DEMO_HOUSEHOLD_ID } from '../../../modules/finance/core/scope';
import type { HouseholdScope } from '../../../modules/finance/core/reconciliation/types';
import type { FinanceDb } from '../../../modules/finance/db/client';
import type { QueueItem } from '../../../modules/finance/core/queue/types';

export function resolveHouseholdScope(): HouseholdScope {
  return { householdId: DEMO_HOUSEHOLD_ID };
}

// Module-level singleton — avoids opening a new file handle per request.
let _db: FinanceDb | undefined;
function getDb(): FinanceDb {
  _db ??= createDb();
  return _db;
}

function resolveBackend(): 'stub' | 'live' | undefined {
  const raw = process.env.RECON_BACKEND;
  return raw === 'stub' || raw === 'live' ? raw : undefined;
}

export async function fetchQueue(scope: HouseholdScope): Promise<QueueItem[]> {
  const db = getDb();
  const gw = gatewayFor({
    PUBLIC_DEMO_MODE: process.env.PUBLIC_DEMO_MODE,
    RECON_BACKEND: resolveBackend(),
  });
  return assembleQueue(scope, gw, db);
}
