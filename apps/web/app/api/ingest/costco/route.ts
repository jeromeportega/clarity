import { amazonAdapter } from '../../../../../../modules/finance/core/adapters/amazon/amazon.adapter';
import { bankAdapter } from '../../../../../../modules/finance/core/adapters/bank/bank.adapter';
import { costcoAdapter } from '../../../../../../modules/finance/core/adapters/costco/costco.adapter';
import { emlAdapter } from '../../../../../../modules/finance/core/adapters/eml.adapter';
import { retailerApiAdapter } from '../../../../../../modules/finance/core/adapters/retailer-api.adapter';
import type { RawInput, SourceAdapter } from '../../../../../../modules/finance/core/adapters/source-adapter';
import { importSource } from '../../../../../../modules/finance/core/ingest/pipeline';
import { createDb } from '../../../../../../modules/finance/db/client';
import { DEMO_HOUSEHOLD_ID } from '../../../../../../modules/finance/core/scope';
import { requireMutationToken } from '../../../lib/auth/token';
import { rejectOversizedBody } from '../../../lib/http/body-limit';
import { reconcileAfterWrite } from '../../../../lib/reconcile';

/**
 * POST /api/ingest/costco — multipart/form-data { file: File } where the file is
 * a saved Costco digital-receipt export (`WarehouseReceiptDetail` JSON).
 *
 * Mutation route: guarded by x-reconcile-token like every other write, with a
 * Content-Length cap before the body is buffered.
 *
 * Thin by design: parse the upload, hand the bytes to `importSource`, shape the
 * response. Receipts belong to the single demo household (`core/scope`). ALL
 * ingest logic lives in `importSource`.
 */
const adapters: SourceAdapter[] = [bankAdapter, amazonAdapter, costcoAdapter, retailerApiAdapter, emlAdapter];

// A multi-year export is a few hundred KB; this only bounds memory before parsing.
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

  if (!(file instanceof File)) {
    return Response.json({ error: 'file is required' }, { status: 400 });
  }

  const input: RawInput = {
    kind: 'costco',
    filename: file.name || 'costco-receipts.json',
    bytes: new Uint8Array(await file.arrayBuffer()),
    mimeType: 'application/json',
  };

  const db = createDb();
  const result = await importSource(db, input, { householdId: DEMO_HOUSEHOLD_ID }, adapters);
  // Imported rows are only useful once matched: reconcile before answering.
  const reconciliation = await reconcileAfterWrite(db, DEMO_HOUSEHOLD_ID);
  return Response.json({ ...result, reconciliation });
}
