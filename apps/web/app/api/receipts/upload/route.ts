import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { requireMutationToken } from '../../../lib/auth/token';
import { rejectOversizedBody } from '../../../lib/http/body-limit';
import { buildReceiptPipelineDeps } from '../../../../lib/receipt-pipeline';
import { DEMO_HOUSEHOLD_ID } from '../../../../../../modules/finance/core/scope';
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

const MIME_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'application/pdf': '.pdf',
};

/**
 * POST /api/receipts/upload — multipart/form-data { file: File }.
 *
 * Mutation route: guarded by x-reconcile-token via the shared
 * `requireMutationToken` gate. Rejects oversized bodies by Content-Length
 * before buffering, then validates MIME and the per-file size cap before the
 * file's bytes are copied into memory or the pipeline runs. Asset stored with
 * a UUID filename — the client filename is never used as a path.
 */
// Slack over the file cap for multipart boundaries/headers.
const MAX_BODY_BYTES = DEFAULT_MAX_UPLOAD_BYTES + 64 * 1024;

export async function POST(request: Request): Promise<Response> {
  // Mutation token gate — must reject before any upload or pipeline work.
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

  let outcome: Awaited<ReturnType<typeof handleReceiptUpload>>;
  try {
    // Real persistence: receipt, line items and learned SKUs land in the DB.
    outcome = await handleReceiptUpload(bytes, mimeType, buildReceiptPipelineDeps(getDb(), DEMO_HOUSEHOLD_ID));
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

  // Persist the raw asset using a server-generated UUID filename.
  // Uses /tmp which is writable in both local dev and serverless runtimes.
  // The client-supplied file.name is intentionally never used as a path.
  const ext = MIME_EXT[mimeType] ?? '.bin';
  const safeFilename = `${randomUUID()}${ext}`;
  const dataDir = join('/tmp', 'receipts');
  try {
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, safeFilename), bytes);
  } catch {
    return Response.json({ error: 'Storage failed' }, { status: 500 });
  }

  return Response.json(outcome.result);
}
