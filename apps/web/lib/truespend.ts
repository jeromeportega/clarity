import { createDb } from '../../../modules/finance/db/client';
import { gatewayFor } from '../../../modules/finance/core/reconciliation/gateway';
import { assembleBreakdown } from '../../../modules/finance/core/truespend/assemble';
import { resolveEvidence } from '../../../modules/finance/core/evidence/resolve';
import { DEMO_HOUSEHOLD_ID } from '../../../modules/finance/core/scope';
import type { HouseholdScope } from '../../../modules/finance/core/reconciliation/types';
import type { FinanceDb } from '../../../modules/finance/db/client';
import type { TrueSpendBreakdown } from '../../../modules/finance/core/truespend/assemble';
import type { EvidenceResult } from '../../../modules/finance/core/evidence/types';

export type { TrueSpendBreakdown };
export type { EvidenceResult };

export function resolveHouseholdScope(): HouseholdScope {
  return { householdId: DEMO_HOUSEHOLD_ID };
}

let _db: FinanceDb | undefined;
function getDb(): FinanceDb {
  _db ??= createDb();
  return _db;
}

function resolveBackend(): 'stub' | 'live' | undefined {
  const raw = process.env.RECON_BACKEND;
  return raw === 'stub' || raw === 'live' ? raw : undefined;
}

export async function fetchBreakdown(
  scope: HouseholdScope,
  month?: string,
): Promise<TrueSpendBreakdown> {
  const db = getDb();
  const gw = gatewayFor({
    PUBLIC_DEMO_MODE: process.env.PUBLIC_DEMO_MODE,
    RECON_BACKEND: resolveBackend(),
  });
  return assembleBreakdown(scope, gw, db, month);
}

export async function fetchEvidence(itemId: string): Promise<EvidenceResult> {
  const db = getDb();
  return resolveEvidence(itemId, db);
}
