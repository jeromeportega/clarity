import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';

import { syncPlaidItem, type PlaidSyncSummary } from '../../../../modules/finance/core/adapters/plaid/sync';
import type { FinanceDb } from '../../../../modules/finance/db/client';
import { plaidItems } from '../../../../modules/finance/db/schema';
import { reconcileAfterWrite } from '../reconcile';
import { isPlaidConfigured, plaidEnv, safePlaidMessage, SdkPlaidClient, type PlaidAdminClient } from './client';
import { decryptToken, encryptToken, parseTokenKey } from './token-cipher';

/**
 * The composition root for bank sync: decrypt each Item's token for the call
 * (bound to its household and Item id), run the core sync through the
 * SDK-backed client, and reconcile once at the end because new bank lines
 * only matter once matched. One Item failing does not stop the others; its
 * status and a credential-free error are recorded by the core.
 */
export interface HouseholdSyncResult {
  items: Array<{ plaidItemId: string; institutionName: string | null; ok: boolean; summary?: PlaidSyncSummary; error?: string }>;
  reconciled: boolean;
}

export async function syncHouseholdBanks(
  db: FinanceDb,
  householdId: string,
  env: Record<string, string | undefined> = process.env,
  client: PlaidAdminClient = new SdkPlaidClient(env),
): Promise<HouseholdSyncResult> {
  const key = parseTokenKey(env.PLAID_TOKEN_KEY);
  const rows = await db.select().from(plaidItems).where(eq(plaidItems.householdId, householdId));

  const items: HouseholdSyncResult['items'] = [];
  for (const row of rows) {
    try {
      const accessToken = decryptToken(row.accessToken, key, { householdId, itemId: row.itemId });
      const summary = await syncPlaidItem(
        db,
        { id: row.id, householdId, accessToken, cursor: row.cursor, institutionName: row.institutionName },
        client,
      );
      items.push({ plaidItemId: row.id, institutionName: row.institutionName, ok: true, summary });
    } catch (err) {
      items.push({ plaidItemId: row.id, institutionName: row.institutionName, ok: false, error: safePlaidMessage(err) });
    }
  }

  const reconciliation = items.some((i) => i.ok) ? await reconcileAfterWrite(db, householdId) : null;
  return { items, reconciled: reconciliation !== null && !('error' in reconciliation) };
}

export type ConnectSandboxResult =
  | { alreadyConnected: false; plaidItemId: string; summary: PlaidSyncSummary }
  | { alreadyConnected: true; plaidItemId: string };

/**
 * Sandbox only: connect a test institution to this household without Link,
 * store the encrypted token, and run the first sync. Refused outside the
 * sandbox — production Items come from Link and its exchange step. A second
 * connection to an institution the household already has is reported, not
 * duplicated (each Item would otherwise bring its own copy of every account
 * and line).
 */
export async function connectSandboxBank(
  db: FinanceDb,
  householdId: string,
  env: Record<string, string | undefined> = process.env,
  institutionId = 'ins_56',
  client: PlaidAdminClient = new SdkPlaidClient(env),
): Promise<ConnectSandboxResult> {
  if (plaidEnv(env) !== 'sandbox') throw new Error('connectSandboxBank is only available when PLAID_ENV=sandbox');
  const key = parseTokenKey(env.PLAID_TOKEN_KEY);

  const existing = await db
    .select({ id: plaidItems.id })
    .from(plaidItems)
    .where(and(eq(plaidItems.householdId, householdId), eq(plaidItems.institutionId, institutionId)))
    .limit(1);
  if (existing[0]) return { alreadyConnected: true, plaidItemId: existing[0].id };

  const created = await client.createSandboxItem(institutionId);
  const institutionName = await client.institutionName(institutionId);
  const plaidItemId = randomUUID();
  await db.insert(plaidItems).values({
    id: plaidItemId,
    householdId,
    itemId: created.itemId,
    accessToken: encryptToken(created.accessToken, key, { householdId, itemId: created.itemId }),
    institutionId,
    institutionName,
  });
  const summary = await syncPlaidItem(db, { id: plaidItemId, householdId, accessToken: created.accessToken, cursor: null, institutionName }, client);
  await reconcileAfterWrite(db, householdId);
  return { alreadyConnected: false, plaidItemId, summary };
}

export { isPlaidConfigured, plaidEnv, safePlaidMessage };
