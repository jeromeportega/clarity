import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { syncPlaidItem, type PlaidSyncSummary } from '../../../../modules/finance/core/adapters/plaid/sync';
import type { FinanceDb } from '../../../../modules/finance/db/client';
import { plaidItems } from '../../../../modules/finance/db/schema';
import { reconcileAfterWrite } from '../reconcile';
import { isPlaidConfigured, plaidEnv, SdkPlaidClient } from './client';
import { decryptToken, encryptToken, parseTokenKey } from './token-cipher';

/**
 * The composition root for bank sync: decrypt each Item's token for the call,
 * run the core sync through the SDK-backed client, and reconcile once at the
 * end because new bank lines only matter once matched. One Item failing does
 * not stop the others; its status and error are recorded by the core.
 */
export interface HouseholdSyncResult {
  items: Array<{ plaidItemId: string; institutionName: string | null; ok: boolean; summary?: PlaidSyncSummary; error?: string }>;
  reconciled: boolean;
}

export async function syncHouseholdBanks(
  db: FinanceDb,
  householdId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<HouseholdSyncResult> {
  const key = parseTokenKey(env.PLAID_TOKEN_KEY);
  const client = new SdkPlaidClient(env);
  const rows = await db.select().from(plaidItems).where(eq(plaidItems.householdId, householdId));

  const items: HouseholdSyncResult['items'] = [];
  for (const row of rows) {
    try {
      const summary = await syncPlaidItem(
        db,
        { id: row.id, householdId, accessToken: decryptToken(row.accessToken, key), cursor: row.cursor, institutionName: row.institutionName },
        client,
      );
      items.push({ plaidItemId: row.id, institutionName: row.institutionName, ok: true, summary });
    } catch (err) {
      items.push({ plaidItemId: row.id, institutionName: row.institutionName, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const reconciliation = items.some((i) => i.ok) ? await reconcileAfterWrite(db, householdId) : null;
  return { items, reconciled: reconciliation !== null && !('error' in reconciliation) };
}

/**
 * Sandbox only: connect a test institution to this household without Link,
 * store the encrypted token, and run the first sync. Refused outside the
 * sandbox — production Items come from Link and its exchange step.
 */
export async function connectSandboxBank(
  db: FinanceDb,
  householdId: string,
  env: Record<string, string | undefined> = process.env,
  institutionId = 'ins_56',
): Promise<{ plaidItemId: string; summary: PlaidSyncSummary }> {
  if (plaidEnv(env) !== 'sandbox') throw new Error('connectSandboxBank is only available when PLAID_ENV=sandbox');
  const key = parseTokenKey(env.PLAID_TOKEN_KEY);
  const client = new SdkPlaidClient(env);
  const created = await client.createSandboxItem(institutionId);
  const institutionName = await client.institutionName(institutionId);
  const plaidItemId = randomUUID();
  await db.insert(plaidItems).values({
    id: plaidItemId,
    householdId,
    itemId: created.itemId,
    accessToken: encryptToken(created.accessToken, key),
    institutionId,
    institutionName,
  });
  const summary = await syncPlaidItem(db, { id: plaidItemId, householdId, accessToken: created.accessToken, cursor: null, institutionName }, client);
  await reconcileAfterWrite(db, householdId);
  return { plaidItemId, summary };
}

export { isPlaidConfigured, plaidEnv };
