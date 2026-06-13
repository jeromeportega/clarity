import { eq } from 'drizzle-orm';

import { amazonAdapter } from '../../../../../../modules/finance/core/adapters/amazon/amazon.adapter';
import { bankAdapter } from '../../../../../../modules/finance/core/adapters/bank/bank.adapter';
import { emlAdapter } from '../../../../../../modules/finance/core/adapters/eml.adapter';
import { retailerApiAdapter } from '../../../../../../modules/finance/core/adapters/retailer-api.adapter';
import type { RawInput, SourceAdapter } from '../../../../../../modules/finance/core/adapters/source-adapter';
import { importSource } from '../../../../../../modules/finance/core/ingest/pipeline';
import { createDb } from '../../../../../../modules/finance/db/client';
import { accounts } from '../../../../../../modules/finance/db/schema';

/**
 * POST /api/ingest/bank — multipart/form-data { file: File, accountId: string }.
 *
 * Thin by design (the entry-point seam): this handler only parses the request,
 * resolves the household from the account, and shapes the response. ALL ingest
 * logic — adapter selection, normalization, idempotency, persistence — lives in
 * `importSource`. This file is one of the two composition roots that import all
 * four adapters.
 */
const adapters: SourceAdapter[] = [bankAdapter, amazonAdapter, retailerApiAdapter, emlAdapter];

export async function POST(request: Request): Promise<Response> {
  const form = await request.formData();
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
  return Response.json(result);
}
