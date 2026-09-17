import { requireWriter } from '../../../../lib/auth/writer';
import { reextractReceipt } from '../../../../../lib/reextract';
import { createDb, type FinanceDb } from '../../../../../../../modules/finance/db/client';

export const dynamic = 'force-dynamic';

let _db: FinanceDb | undefined;
function getDb(): FinanceDb {
  _db ??= createDb();
  return _db;
}

const MAX_ID_LEN = 128;

/**
 * POST /api/receipts/[receiptId]/reextract — read a stored receipt photo
 * again. For a receipt the model could not read (zero items), in the writer's
 * household, using the image the store holds under the receipt's own hash.
 *
 *   401 no writer · 400 bad id · 404 no such receipt here, or no stored image
 *   409 the receipt already has line items (decided in the queue instead)
 *   422 the stored image is not a type the model can read
 *   200 { status, receipt, items } — status 'ok' or 'needs_review'
 */
export async function POST(req: Request, { params }: { params: { receiptId: string } }): Promise<Response> {
  const writer = await requireWriter(req);
  if (writer instanceof Response) return writer;

  const receiptId = params.receiptId;
  if (typeof receiptId !== 'string' || receiptId.length === 0 || receiptId.length > MAX_ID_LEN) {
    return Response.json({ error: 'Bad Request' }, { status: 400 });
  }

  let outcome: Awaited<ReturnType<typeof reextractReceipt>>;
  try {
    outcome = await reextractReceipt(getDb(), writer.householdId, receiptId);
  } catch (err) {
    console.error('[receipts/reextract] failed', err);
    return Response.json({ error: 'Processing failed' }, { status: 500 });
  }

  if (!outcome.ok) {
    const status =
      outcome.code === 'has_items' ? 409 : outcome.code === 'unsupported_image' ? 422 : outcome.code === 'image_mismatch' ? 500 : 404;
    return Response.json({ error: outcome.code }, { status });
  }
  return Response.json({ status: outcome.result.status, receipt: outcome.result.receipt, items: outcome.result.items });
}
