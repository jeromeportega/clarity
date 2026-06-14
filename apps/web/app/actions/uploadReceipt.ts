'use server';

import Anthropic from '@anthropic-ai/sdk';

import { DEMO_HOUSEHOLD_ID } from '../../../../modules/finance/core/scope';
import { StubSkuDictionary } from '../../../../modules/finance/core/receipts/dictionary/stub-sku-dictionary';
import {
  AnthropicSkuResolver,
  LlmSkuResolver,
} from '../../../../modules/finance/core/receipts/resolver/llm-resolver';
import { RecordedSkuResolver } from '../../../../modules/finance/core/receipts/resolver/recorded-resolver';
import { StubReceiptStore } from '../../../../modules/finance/core/receipts/store/stub-receipt-store';
import { LiveAnthropicVisionProvider } from '../../../../modules/finance/core/receipts/vision/live-anthropic-vision-provider';
import { RecordedVisionProvider } from '../../../../modules/finance/core/receipts/vision/recorded-vision-provider';
import type { ReceiptPipelineDeps } from '../../../../modules/finance/core/receipts/process-receipt';
import {
  DEFAULT_MAX_UPLOAD_BYTES,
  handleReceiptUpload,
  isAcceptedUploadMime,
  type UploadedReceiptResult,
} from '../../../../modules/finance/core/receipts/upload';

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

export type UploadActionResult =
  | { ok: true; result: UploadedReceiptResult }
  | { ok: false; error: string; status: 401 | 400 | 413 | 415 | 500 };

/**
 * Server Action for the receipt upload UI. The token never leaves the server —
 * the client sends the file only; authorization is validated server-side by
 * checking RECONCILE_MUTATION_TOKEN in the server environment.
 */
export async function uploadReceiptAction(formData: FormData): Promise<UploadActionResult> {
  if (!process.env.RECONCILE_MUTATION_TOKEN) {
    return { ok: false, error: 'Unauthorized', status: 401 };
  }

  const file = formData.get('file');
  if (!(file instanceof File)) {
    return { ok: false, error: 'file field is required', status: 400 };
  }

  const mimeType = file.type || 'application/octet-stream';

  if (!isAcceptedUploadMime(mimeType)) {
    return { ok: false, error: `Unsupported media type: ${mimeType}`, status: 415 };
  }
  if (file.size > DEFAULT_MAX_UPLOAD_BYTES) {
    return { ok: false, error: 'File too large', status: 413 };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  let outcome: Awaited<ReturnType<typeof handleReceiptUpload>>;
  try {
    outcome = await handleReceiptUpload(bytes, mimeType, buildDeps());
  } catch {
    return { ok: false, error: 'Processing failed', status: 500 };
  }

  if (!outcome.ok) {
    if (outcome.error.code === 'MIME_REJECTED') {
      return { ok: false, error: `Unsupported media type: ${outcome.error.mimeType}`, status: 415 };
    }
    return { ok: false, error: 'File too large', status: 413 };
  }

  return { ok: true, result: outcome.result };
}
