import { requireWriter } from '../../../lib/auth/writer';
import { rejectOversizedBody } from '../../../lib/http/body-limit';
import { getImageStore } from '../../../../lib/image-store';
import { buildReceiptPipelineDeps } from '../../../../lib/receipt-pipeline';
import { reconcileAfterWrite } from '../../../../lib/reconcile';
import { imageHash } from '../../../../../../modules/finance/core/receipts/image-hash';
import { receiptImageKey } from '../../../../../../modules/finance/core/receipts/store/image-store';
import {
  DEFAULT_MAX_UPLOAD_BYTES,
  handleReceiptUpload,
  isAcceptedUploadMime,
} from '../../../../../../modules/finance/core/receipts/upload';
import { createDb, type FinanceDb } from '../../../../../../modules/finance/db/client';

// Module-level singleton — avoids opening a new connection per request.
let _db: FinanceDb | undefined;
function getDb(): FinanceDb {
  _db ??= createDb();
  return _db;
}

/**
 * POST /api/receipts/upload — multipart/form-data { file: File }.
 *
 * Mutation route: the writer (a session, or the script token) decides the
 * household. Rejects oversized bodies by Content-Length before buffering,
 * then validates MIME and the per-file size cap before the file's bytes are
 * copied into memory or the pipeline runs. The image is stored under a key
 * derived from the household and the image hash — the client filename is
 * never a path — before anything touches the database.
 */
// Slack over the file cap for multipart boundaries/headers.
const MAX_BODY_BYTES = DEFAULT_MAX_UPLOAD_BYTES + 64 * 1024;

export async function POST(request: Request): Promise<Response> {
  // Writer gate — must reject before any upload or pipeline work.
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
    return Response.json({ error: 'file field is required' }, { status: 400 });
  }

  const mimeType = file.type || 'application/octet-stream';

  // Validate MIME and size BEFORE reading bytes into memory — prevents large
  // allocations for invalid uploads.
  if (!isAcceptedUploadMime(mimeType)) {
    return Response.json(
      { error: `Unsupported media type: ${mimeType}` },
      { status: 415 },
    );
  }
  if (file.size > DEFAULT_MAX_UPLOAD_BYTES) {
    return Response.json({ error: 'File too large' }, { status: 413 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  // Keep the image BEFORE anything is committed to the database, so a
  // storage failure is a clean 500 with no half-recorded receipt. The key is
  // the household plus the image hash — the same hash the pipeline uses for
  // idempotency — so the receipt row and its image find each other without a
  // link column, and a re-upload of the same photo rewrites the same key.
  try {
    await getImageStore().put(receiptImageKey(writer.householdId, imageHash(bytes)), bytes, mimeType);
  } catch (err) {
    console.error('[receipts/upload] image storage failed', err);
    return Response.json({ error: 'Storage failed' }, { status: 500 });
  }

  let outcome: Awaited<ReturnType<typeof handleReceiptUpload>>;
  try {
    // Real persistence: receipt, line items and learned SKUs land in the DB.
    outcome = await handleReceiptUpload(bytes, mimeType, buildReceiptPipelineDeps(getDb(), writer.householdId));
  } catch {
    return Response.json({ error: 'Processing failed' }, { status: 500 });
  }

  if (!outcome.ok) {
    if (outcome.error.code === 'MIME_REJECTED') {
      return Response.json(
        { error: `Unsupported media type: ${outcome.error.mimeType}` },
        { status: 415 },
      );
    }
    return Response.json({ error: 'File too large' }, { status: 413 });
  }

  // A photographed receipt is only useful once it is matched to the bank line
  // that paid for it: reconcile before answering (a duplicate upload changed
  // nothing, so it skips the run).
  const reconciliation = outcome.result.idempotent ? undefined : await reconcileAfterWrite(getDb(), writer.householdId);
  return Response.json({ ...outcome.result, reconciliation });
}
