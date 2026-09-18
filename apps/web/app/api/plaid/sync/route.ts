import { requireWriter } from '../../../lib/auth/writer';
import { isPlaidConfigured, syncHouseholdBanks } from '../../../../lib/plaid/sync';
import { createDb, type FinanceDb } from '../../../../../../modules/finance/db/client';

export const dynamic = 'force-dynamic';

let _db: FinanceDb | undefined;
function getDb(): FinanceDb {
  _db ??= createDb();
  return _db;
}

/**
 * POST /api/plaid/sync — pull new bank activity for every connected Item in
 * the writer's household, then reconcile. 401 no writer · 503 Plaid is not
 * configured on this deployment · 200 { items: [{ ok, summary | error }], reconciled }.
 */
export async function POST(request: Request): Promise<Response> {
  const writer = await requireWriter(request);
  if (writer instanceof Response) return writer;
  if (!isPlaidConfigured()) return Response.json({ error: 'plaid_not_configured' }, { status: 503 });

  try {
    const result = await syncHouseholdBanks(getDb(), writer.householdId);
    return Response.json(result);
  } catch (err) {
    console.error('[plaid/sync] failed', err);
    return Response.json({ error: 'Sync failed' }, { status: 500 });
  }
}
