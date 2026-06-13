import { amazonAdapter } from '../../../../../../modules/finance/core/adapters/amazon/amazon.adapter';
import { bankAdapter } from '../../../../../../modules/finance/core/adapters/bank/bank.adapter';
import { emlAdapter } from '../../../../../../modules/finance/core/adapters/eml.adapter';
import { retailerApiAdapter } from '../../../../../../modules/finance/core/adapters/retailer-api.adapter';
import type { RawInput, SourceAdapter } from '../../../../../../modules/finance/core/adapters/source-adapter';
import { importSource } from '../../../../../../modules/finance/core/ingest/pipeline';
import { createDb } from '../../../../../../modules/finance/db/client';
import { DEMO_HOUSEHOLD_ID } from '../../../../../../modules/finance/scripts/seed';

/**
 * POST /api/ingest/orders — multipart/form-data { file: File }.
 *
 * Thin by design: parse the upload, hand the bytes to `importSource`, shape the
 * response. Orders belong to the single seeded demo household (NFR-5); the bank
 * route resolves its household from an account instead. ALL ingest logic lives in
 * `importSource`.
 */
const adapters: SourceAdapter[] = [bankAdapter, amazonAdapter, retailerApiAdapter, emlAdapter];

export async function POST(request: Request): Promise<Response> {
  const form = await request.formData();
  const file = form.get('file');

  if (!(file instanceof File)) {
    return Response.json({ error: 'file is required' }, { status: 400 });
  }

  const input: RawInput = {
    kind: 'amazon',
    filename: file.name || 'orders-upload',
    bytes: new Uint8Array(await file.arrayBuffer()),
  };

  const result = await importSource(createDb(), input, { householdId: DEMO_HOUSEHOLD_ID }, adapters);
  return Response.json(result);
}
