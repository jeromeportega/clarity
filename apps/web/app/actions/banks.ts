'use server';

import { createDb, type FinanceDb } from '../../../../modules/finance/db/client';
import { connectSandboxBank, isPlaidConfigured, plaidEnv, syncHouseholdBanks, type HouseholdSyncResult } from '../../lib/plaid/sync';
import { requireWriterFromAction } from '../lib/auth/writer';

// Public endpoints like every Server Action: no arguments to validate here,
// and the writer is resolved exactly as the routes do (`lib/auth/writer.ts`).

let _db: FinanceDb | undefined;
function getDb(): FinanceDb {
  _db ??= createDb();
  return _db;
}

export type BankActionResult =
  | { ok: true; result: HouseholdSyncResult }
  | { ok: true; connected: { plaidItemId: string; added: number; accountsCreated: number } }
  | { ok: false; code: 'plaid_not_configured' | 'sandbox_only' | 'failed' };

/** Pull new activity for every connected bank in the writer's household. */
export async function syncBanks(): Promise<BankActionResult> {
  const writer = await requireWriterFromAction();
  if (!isPlaidConfigured()) return { ok: false, code: 'plaid_not_configured' };
  try {
    return { ok: true, result: await syncHouseholdBanks(getDb(), writer.householdId) };
  } catch (err) {
    console.error('[banks/sync] failed', err);
    return { ok: false, code: 'failed' };
  }
}

/** Sandbox only: connect Plaid's test institution and run the first sync. */
export async function connectSandbox(): Promise<BankActionResult> {
  const writer = await requireWriterFromAction();
  if (!isPlaidConfigured()) return { ok: false, code: 'plaid_not_configured' };
  if (plaidEnv() !== 'sandbox') return { ok: false, code: 'sandbox_only' };
  try {
    const { plaidItemId, summary } = await connectSandboxBank(getDb(), writer.householdId);
    return { ok: true, connected: { plaidItemId, added: summary.added, accountsCreated: summary.accountsCreated } };
  } catch (err) {
    console.error('[banks/connect-sandbox] failed', err);
    return { ok: false, code: 'failed' };
  }
}
