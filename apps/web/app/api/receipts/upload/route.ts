import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import Anthropic from '@anthropic-ai/sdk';

import { DEMO_HOUSEHOLD_ID } from '../../../../../../modules/finance/core/scope';
import { StubSkuDictionary } from '../../../../../../modules/finance/core/receipts/dictionary/stub-sku-dictionary';
import {
  AnthropicSkuResolver,
  LlmSkuResolver,
} from '../../../../../../modules/finance/core/receipts/resolver/llm-resolver';
import { RecordedSkuResolver } from '../../../../../../modules/finance/core/receipts/resolver/recorded-resolver';
import { StubReceiptStore } from '../../../../../../modules/finance/core/receipts/store/stub-receipt-store';
import { LiveAnthropicVisionProvider } from '../../../../../../modules/finance/core/receipts/vision/live-anthropic-vision-provider';
import { RecordedVisionProvider } from '../../../../../../modules/finance/core/receipts/vision/recorded-vision-provider';
import type { ReceiptPipelineDeps } from '../../../../../../modules/finance/core/receipts/process-receipt';
import {
  DEFAULT_MAX_UPLOAD_BYTES,
  handleReceiptUpload,
  isAcceptedUploadMime,
} from '../../../../../../modules/finance/core/receipts/upload';

// Wire the H2 dependency bundle. Uses recorded (offline) seams when no
// ANTHROPIC_API_KEY is present (dev/test); live providers when the key is set.
function buildDeps(): ReceiptPipelineDeps {
  const dictionary = new StubSkuDictionary();
  const store = new StubReceiptStore();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const client = apiKey ? new Anthropic({ apiKey }) : null;
  const vision = client
    ? new LiveAnthropicVisionProvider({ client })
    : new RecordedVisionProvider();
  const llmResolver = client ? new AnthropicSkuResolver({ client }) : new RecordedSkuResolver();
  const resolver = new LlmSkuResolver({ dictionary, llm: llmResolver });
  return {
    vision,
    resolver,
    dictionary,
    store,
    householdId: DEMO_HOUSEHOLD_ID,
    source: 'photo',
  };
}

// Timing-safe token comparison — prevents response-time attacks on the shared
// secret (Buffer lengths must match first; timingSafeEqual requires equal lengths).
function isTokenValid(token: string | null, expected: string): boolean {
  if (!token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const MIME_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'application/pdf': '.pdf',
};

/**
 * POST /api/receipts/upload — multipart/form-data { file: File }.
 *
 * Mutation route: guarded by x-reconcile-token (FR-13). Validates MIME and
 * size cap BEFORE reading bytes into memory or invoking H2. Asset stored with
 * a UUID filename — the client filename is never used as a path (Security T4).
 */
export async function POST(request: Request): Promise<Response> {
  // Mutation token gate — must reject before any upload or H2 work.
  const token = request.headers.get('x-reconcile-token');
  const expected = process.env.RECONCILE_MUTATION_TOKEN;
  if (!expected || !isTokenValid(token, expected)) {
    return new Response('Unauthorized', { status: 401 });
  }

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
    outcome = await handleReceiptUpload(bytes, mimeType, buildDeps());
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
