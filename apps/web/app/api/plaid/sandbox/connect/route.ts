import { requireWriter } from '../../../../lib/auth/writer';
import { connectSandboxBank, isPlaidConfigured, plaidEnv } from '../../../../../lib/plaid/sync';
import { createDb, type FinanceDb } from '../../../../../../../modules/finance/db/client';

export const dynamic = 'force-dynamic';

let _db: FinanceDb | undefined;
function getDb(): FinanceDb {
  _db ??= createDb();
  return _db;
}

/**
 * POST /api/plaid/sandbox/connect — connect a Plaid SANDBOX test institution
 * to the writer's household without Link and run the first sync. Exists so the
 * bank path can be exercised end to end before Link is wired in.
 * 401 no writer · 503 Plaid not configured · 404 outside the sandbox
 * (production Items come only from Link) · 200 { plaidItemId, summary }.
 */
export async function POST(request: Request): Promise<Response> {
  const writer = await requireWriter(request);
  if (writer instanceof Response) return writer;
  if (!isPlaidConfigured()) return Response.json({ error: 'plaid_not_configured' }, { status: 503 });
  if (plaidEnv() !== 'sandbox') return new Response('Not Found', { status: 404 });

  try {
    const result = await connectSandboxBank(getDb(), writer.householdId);
    return Response.json(result);
  } catch (err) {
    console.error('[plaid/sandbox/connect] failed', err);
    return Response.json({ error: 'Connect failed' }, { status: 500 });
  }
}
