import { requireWriter } from '../../../lib/auth/writer';
import { isPlaidConfigured, safePlaidMessage, syncHouseholdBanks } from '../../../../lib/plaid/sync';
import { createDb, type FinanceDb } from '../../../../../../modules/finance/db/client';

export const dynamic = 'force-dynamic';

let _db: FinanceDb | undefined;
function getDb(): FinanceDb {
  _db ??= createDb();
  return _db;
}

/**
 * POST /api/plaid/sync — pull new bank activity for every connected Item in
 * the writer's household, then reconcile.
 *   404 on the public demo (it never sits over a bank) · 401 no writer
 *   503 Plaid is not configured · 200 { items: [{ ok, summary | error }], reconciled }
 * Errors are logged as credential-free one-liners only: an SDK error object
 * would carry the request headers and body.
 */
export async function POST(request: Request): Promise<Response> {
  if (process.env.PUBLIC_DEMO_MODE === '1') return new Response('Not Found', { status: 404 });
  const writer = await requireWriter(request);
  if (writer instanceof Response) return writer;
  if (!isPlaidConfigured()) return Response.json({ error: 'plaid_not_configured' }, { status: 503 });

  try {
    const result = await syncHouseholdBanks(getDb(), writer.householdId);
    return Response.json(result);
  } catch (err) {
    console.error('[plaid/sync] failed:', safePlaidMessage(err));
    return Response.json({ error: 'Sync failed' }, { status: 500 });
  }
}
