'use server';

import { createDb, type FinanceDb } from '../../../../modules/finance/db/client';
import {
  connectSandboxBank,
  isPlaidConfigured,
  plaidEnv,
  safePlaidMessage,
  syncHouseholdBanks,
  type HouseholdSyncResult,
} from '../../lib/plaid/sync';
import { requireWriterFromAction } from '../lib/auth/writer';

// Public endpoints like every Server Action: no arguments to validate here,
// and the writer is resolved exactly as the routes do (`lib/auth/writer.ts`).
// The public demo never sits over a bank: both actions refuse there first.
// Errors are logged as credential-free one-liners only.

let _db: FinanceDb | undefined;
function getDb(): FinanceDb {
  _db ??= createDb();
  return _db;
}

export type BankActionResult =
  | { ok: true; result: HouseholdSyncResult }
  | { ok: true; connected: { plaidItemId: string; added: number; accountsCreated: number; stillPreparing: boolean } }
  | { ok: false; code: 'demo' | 'plaid_not_configured' | 'sandbox_only' | 'already_connected' | 'failed' };

/** Pull new activity for every connected bank in the writer's household. */
export async function syncBanks(): Promise<BankActionResult> {
  if (process.env.PUBLIC_DEMO_MODE === '1') return { ok: false, code: 'demo' };
  const writer = await requireWriterFromAction();
  if (!isPlaidConfigured()) return { ok: false, code: 'plaid_not_configured' };
  try {
    return { ok: true, result: await syncHouseholdBanks(getDb(), writer.householdId) };
  } catch (err) {
    console.error('[banks/sync] failed:', safePlaidMessage(err));
    return { ok: false, code: 'failed' };
  }
}

/** Sandbox only: connect Plaid's test institution and run the first sync. */
export async function connectSandbox(): Promise<BankActionResult> {
  if (process.env.PUBLIC_DEMO_MODE === '1') return { ok: false, code: 'demo' };
  const writer = await requireWriterFromAction();
  if (!isPlaidConfigured()) return { ok: false, code: 'plaid_not_configured' };
  if (plaidEnv() !== 'sandbox') return { ok: false, code: 'sandbox_only' };
  try {
    const result = await connectSandboxBank(getDb(), writer.householdId);
    if (result.alreadyConnected) return { ok: false, code: 'already_connected' };
    return {
      ok: true,
      connected: {
        plaidItemId: result.plaidItemId,
        added: result.summary.added,
        accountsCreated: result.summary.accountsCreated,
        stillPreparing: result.summary.added === 0 && result.summary.updateStatus === 'not_ready',
      },
    };
  } catch (err) {
    console.error('[banks/connect-sandbox] failed:', safePlaidMessage(err));
    return { ok: false, code: 'failed' };
  }
}
