import { amazonAdapter } from '../../../../../../modules/finance/core/adapters/amazon/amazon.adapter';
import { bankAdapter } from '../../../../../../modules/finance/core/adapters/bank/bank.adapter';
import { emlAdapter } from '../../../../../../modules/finance/core/adapters/eml.adapter';
import { retailerApiAdapter } from '../../../../../../modules/finance/core/adapters/retailer-api.adapter';
import type { RawInput, SourceAdapter } from '../../../../../../modules/finance/core/adapters/source-adapter';
import { importSource } from '../../../../../../modules/finance/core/ingest/pipeline';
import { createDb } from '../../../../../../modules/finance/db/client';
import { requireWriter } from '../../../lib/auth/writer';
import { rejectOversizedBody } from '../../../lib/http/body-limit';
import { reconcileAfterWrite } from '../../../../lib/reconcile';

/**
 * POST /api/ingest/orders — multipart/form-data { file: File }.
 *
 * Mutation route: guarded by x-reconcile-token like every other write, with a
 * Content-Length cap before the body is buffered.
 *
 * Thin by design: parse the upload, hand the bytes to `importSource`, shape the
 * response. Orders belong to the single demo household (the SAME constant the
 * queue, true-spend and upload paths use — `core/scope`); the bank route
 * resolves its household from an account instead. ALL ingest logic lives in
 * `importSource`.
 */
const adapters: SourceAdapter[] = [bankAdapter, amazonAdapter, retailerApiAdapter, emlAdapter];

// Amazon order-history exports are small; this only bounds memory before parsing.
const MAX_BODY_BYTES = 25 * 1024 * 1024;

export async function POST(request: Request): Promise<Response> {
  const writer = await requireWriter(request);
  if (writer instanceof Response) return writer;

  const tooBig = rejectOversizedBody(request, MAX_BODY_BYTES);
  if (tooBig) return tooBig;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: 'Invalid multipart request' }, { status: 400 });
  }
  const file = form.get('file');

  if (!(file instanceof File)) {
    return Response.json({ error: 'file is required' }, { status: 400 });
  }

  const input: RawInput = {
    kind: 'amazon',
    filename: file.name || 'orders-upload',
    bytes: new Uint8Array(await file.arrayBuffer()),
  };

  const db = createDb();
  const result = await importSource(db, input, { householdId: writer.householdId }, adapters);
  // Imported rows are only useful once matched: reconcile before answering.
  const reconciliation = await reconcileAfterWrite(db, writer.householdId);
  return Response.json({ ...result, reconciled: !('error' in reconciliation), reconciliation });
}
