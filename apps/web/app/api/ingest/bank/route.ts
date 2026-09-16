import { eq } from 'drizzle-orm';

import { amazonAdapter } from '../../../../../../modules/finance/core/adapters/amazon/amazon.adapter';
import { bankAdapter } from '../../../../../../modules/finance/core/adapters/bank/bank.adapter';
import { emlAdapter } from '../../../../../../modules/finance/core/adapters/eml.adapter';
import { retailerApiAdapter } from '../../../../../../modules/finance/core/adapters/retailer-api.adapter';
import type { RawInput, SourceAdapter } from '../../../../../../modules/finance/core/adapters/source-adapter';
import { importSource } from '../../../../../../modules/finance/core/ingest/pipeline';
import { createDb } from '../../../../../../modules/finance/db/client';
import { accounts } from '../../../../../../modules/finance/db/schema';
import { requireMutationToken } from '../../../lib/auth/token';
import { rejectOversizedBody } from '../../../lib/http/body-limit';
import { reconcileAfterWrite } from '../../../../lib/reconcile';

/**
 * POST /api/ingest/bank — multipart/form-data { file: File, accountId: string }.
 *
 * Mutation route: guarded by x-reconcile-token like every other write, with a
 * Content-Length cap before the body is buffered.
 *
 * Thin by design (the entry-point seam): this handler only parses the request,
 * resolves the household from the account, and shapes the response. ALL ingest
 * logic — adapter selection, normalization, idempotency, persistence — lives in
 * `importSource`. This file is one of the two composition roots that import all
 * four adapters.
 *
 * TODO(auth): the household is derived from the client-supplied `accountId`.
 * With one shared secret and one seeded household that is acceptable; once
 * users exist, the account must be checked against the caller's household
 * (otherwise any caller could write into another household's account).
 */
const adapters: SourceAdapter[] = [bankAdapter, amazonAdapter, retailerApiAdapter, emlAdapter];

// Bank exports are small; this only bounds memory before parsing.
const MAX_BODY_BYTES = 25 * 1024 * 1024;

export async function POST(request: Request): Promise<Response> {
  const denied = requireMutationToken(request);
  if (denied) return denied;

  const tooBig = rejectOversizedBody(request, MAX_BODY_BYTES);
  if (tooBig) return tooBig;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: 'Invalid multipart request' }, { status: 400 });
  }
  const file = form.get('file');
  const accountId = form.get('accountId');

  if (!(file instanceof File)) {
    return Response.json({ error: 'file is required' }, { status: 400 });
  }
  if (typeof accountId !== 'string' || accountId.length === 0) {
    return Response.json({ error: 'accountId is required' }, { status: 400 });
  }

  const db = createDb();
  const rows = await db
    .select({ householdId: accounts.householdId })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  const account = rows[0];
  if (!account) {
    return Response.json({ error: `unknown accountId '${accountId}'` }, { status: 400 });
  }

  const input: RawInput = {
    kind: 'bank',
    filename: file.name || 'bank-upload',
    bytes: new Uint8Array(await file.arrayBuffer()),
  };

  const result = await importSource(db, input, { householdId: account.householdId, accountId }, adapters);
  // New bank lines are only useful once matched: reconcile before answering.
  const reconciliation = await reconcileAfterWrite(db, account.householdId);
  return Response.json({ ...result, reconciliation });
}
