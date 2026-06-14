import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import Anthropic from '@anthropic-ai/sdk';

import { DEMO_HOUSEHOLD_ID } from '../../../../../../modules/finance/core/scope';
import { StubSkuDictionary } from '../../../../../../modules/finance/core/receipts/dictionary/stub-sku-dictionary';
import { LlmSkuResolver } from '../../../../../../modules/finance/core/receipts/resolver/llm-resolver';
import { RecordedSkuResolver } from '../../../../../../modules/finance/core/receipts/resolver/recorded-resolver';
import { StubReceiptStore } from '../../../../../../modules/finance/core/receipts/store/stub-receipt-store';
import { LiveAnthropicVisionProvider } from '../../../../../../modules/finance/core/receipts/vision/live-anthropic-vision-provider';
import { RecordedVisionProvider } from '../../../../../../modules/finance/core/receipts/vision/recorded-vision-provider';
import type { ReceiptPipelineDeps } from '../../../../../../modules/finance/core/receipts/process-receipt';
import {
  handleReceiptUpload,
} from '../../../../../../modules/finance/core/receipts/upload';

// Wire the H2 dependency bundle. Uses the recorded (offline) seam when no
// ANTHROPIC_API_KEY is present (dev/test); live providers when the key is set.
// In tests, processReceipt is mocked at the module boundary so the deps object
// is constructed but never exercised.
function buildDeps(): ReceiptPipelineDeps {
  const dictionary = new StubSkuDictionary();
  const resolver = new LlmSkuResolver({ dictionary, llm: new RecordedSkuResolver() });
  const store = new StubReceiptStore();
  const vision = process.env.ANTHROPIC_API_KEY
    ? new LiveAnthropicVisionProvider({ client: new Anthropic() })
    : new RecordedVisionProvider();
  return {
    vision,
    resolver,
    dictionary,
    store,
    householdId: DEMO_HOUSEHOLD_ID,
    source: 'photo',
  };
}

/**
 * POST /api/receipts/upload — multipart/form-data { file: File }.
 *
 * Mutation route: guarded by x-reconcile-token (FR-13). Validates MIME and
 * size cap before invoking the H2 pipeline. Asset is stored with a UUID
 * filename — the client filename is never used as a path (Security T4).
 */
export async function POST(request: Request): Promise<Response> {
  // Mutation token gate — must reject before any upload or H2 work.
  const token = request.headers.get('x-reconcile-token');
  const expected = process.env.RECONCILE_MUTATION_TOKEN;
  if (!expected || token !== expected) {
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

  const bytes = new Uint8Array(await file.arrayBuffer());
  const mimeType = file.type || 'application/octet-stream';

  // Validate MIME + size BEFORE H2 invocation; also before storage so invalid
  // uploads leave no artifacts.
  const outcome = await handleReceiptUpload(bytes, mimeType, buildDeps());

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
  // The client-supplied file.name is intentionally never used as a path.
  const ext = mimeType === 'application/pdf' ? '.pdf' : mimeType === 'image/png' ? '.png' : '.jpg';
  const safeFilename = `${randomUUID()}${ext}`;
  const dataDir = join(process.cwd(), 'data', 'receipts');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, safeFilename), bytes);

  return Response.json(outcome.result);
}
