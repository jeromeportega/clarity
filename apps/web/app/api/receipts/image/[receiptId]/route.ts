import { and, eq } from 'drizzle-orm';

import { resolveReadScope } from '../../../../../lib/public-mode';
import { getImageStore } from '../../../../../lib/image-store';
import { receiptImageKey } from '../../../../../../../modules/finance/core/receipts/store/image-store';
import { createDb, type FinanceDb } from '../../../../../../../modules/finance/db/client';
import { receipts } from '../../../../../../../modules/finance/db/schema';

// Every API route serves live household data; never prerender.
export const dynamic = 'force-dynamic';

let _db: FinanceDb | undefined;
function getDb(): FinanceDb {
  _db ??= createDb();
  return _db;
}

/**
 * GET /api/receipts/image/[receiptId] — the photographed receipt behind a
 * row, as the evidence view links it.
 *
 * Read-scoped like every other read: the receipt must belong to the caller's
 * household (403 without a scope, 404 for any other household's id — the id
 * reveals nothing). A receipt with no stored image — a digital import, or an
 * upload made before durable storage existed — is 404 too. The bytes are
 * served with their stored content type and never cached by a shared cache.
 */
export async function GET(
  _request: Request,
  context: { params: { receiptId: string } | Promise<{ receiptId: string }> },
): Promise<Response> {
  const scope = await resolveReadScope();
  if (!scope) return new Response('Forbidden', { status: 403 });

  const { receiptId } = context.params instanceof Promise ? await context.params : context.params;
  if (!receiptId) return new Response('Bad Request', { status: 400 });

  const rows = await getDb()
    .select({ householdId: receipts.householdId, imageHash: receipts.imageHash })
    .from(receipts)
    .where(and(eq(receipts.id, receiptId), eq(receipts.householdId, scope.householdId)))
    .limit(1);
  const receipt = rows[0];
  if (!receipt || !receipt.imageHash) return new Response('Not Found', { status: 404 });

  const image = await getImageStore().get(receiptImageKey(receipt.householdId, receipt.imageHash));
  if (!image) return new Response('No image is stored for this receipt', { status: 404 });

  // A Response body wants an ArrayBuffer; hand it exactly the image's bytes.
  const body = image.bytes.buffer.slice(image.bytes.byteOffset, image.bytes.byteOffset + image.bytes.byteLength) as ArrayBuffer;
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': image.mimeType,
      'content-length': String(image.bytes.byteLength),
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
