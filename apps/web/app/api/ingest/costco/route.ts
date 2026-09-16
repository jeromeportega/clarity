import { amazonAdapter } from '../../../../../../modules/finance/core/adapters/amazon/amazon.adapter';
import { bankAdapter } from '../../../../../../modules/finance/core/adapters/bank/bank.adapter';
import { costcoAdapter } from '../../../../../../modules/finance/core/adapters/costco/costco.adapter';
import { emlAdapter } from '../../../../../../modules/finance/core/adapters/eml.adapter';
import { retailerApiAdapter } from '../../../../../../modules/finance/core/adapters/retailer-api.adapter';
import type { RawInput, SourceAdapter } from '../../../../../../modules/finance/core/adapters/source-adapter';
import { importSource } from '../../../../../../modules/finance/core/ingest/pipeline';
import { createDb } from '../../../../../../modules/finance/db/client';
import { requireWriter } from '../../../lib/auth/writer';
import { rejectOversizedBody } from '../../../lib/http/body-limit';
import { reconcileAfterWrite } from '../../../../lib/reconcile';
import { learnFromDigitalReceipts } from '../../../../../../modules/finance/core/receipts/dictionary/bootstrap';

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

type DictionaryOutcome = Awaited<ReturnType<typeof learnFromDigitalReceipts>> | { skipped: true } | { error: string };

async function learnAfterImport(db: ReturnType<typeof createDb>, householdId: string, insertedReceipts: number): Promise<DictionaryOutcome> {
  if (insertedReceipts === 0) return { skipped: true };
  try {
    return await learnFromDigitalReceipts(db, { householdId });
  } catch (err) {
    console.error('[ingest/costco] dictionary learning failed', err);
    return { error: 'dictionary learning failed; the import is saved — npm run dictionary:bootstrap to retry' };
  }
}

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
    kind: 'costco',
    filename: file.name || 'costco-receipts.json',
    bytes: new Uint8Array(await file.arrayBuffer()),
    mimeType: 'application/json',
  };

  const db = createDb();
  const result = await importSource(db, input, { householdId: writer.householdId }, adapters);
  // Every retailer-named line is a free answer for the photo path. The import
  // is committed by now, so a failure here is reported next to it, not thrown
  // away with it; a re-upload that landed nothing new has nothing to teach.
  const dictionary = await learnAfterImport(db, writer.householdId, result.inserted.receipts);
  // Imported rows are only useful once matched: reconcile before answering.
  const reconciliation = await reconcileAfterWrite(db, writer.householdId);
  return Response.json({ ...result, dictionary, reconciled: !('error' in reconciliation), reconciliation });
}
