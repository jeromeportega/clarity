import { generateText, jsonSchema, tool, ToolChoiceViolationError, type JSONSchema7, type LanguageModel } from 'ai';

import { validateExtraction } from './extraction-schema';
import {
  EXTRACTION_TOOL_INPUT_SCHEMA,
  EXTRACTION_TOOL_NAME,
  RECEIPT_EXTRACTION_SYSTEM_PROMPT,
} from './system-prompt';
import {
  assertSupportedMimeType,
  type ExtractedLineItem,
  type ExtractedReceipt,
  type ReceiptImageInput,
  unreadableReceipt,
  type VisionProvider,
} from './vision-provider';

const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

export interface LiveVisionProviderOptions {
  /**
   * The model is INJECTED — an AI Gateway id such as `anthropic/claude-opus-5`
   * or any AI SDK language model. This module never chooses a model, reads a
   * key, or builds a provider, so the core (and the default test gate) has no
   * credential and no network anywhere (NFR-1, G-3). The composition root and
   * the eval harness decide; tests pass a mock model.
   */
  model: LanguageModel;
  maxOutputTokens?: number;
}

/**
 * The structured tool the model must call. Forcing `toolChoice` to this tool
 * guarantees a typed object back instead of free-form prose. The JSON Schema
 * is what the model is shown (the request-shape tests pin its `required`
 * list); `validateExtraction` is what the reply is checked against — the SDK
 * only validates when a validator is given, so without it a float where
 * integer cents belong would flow straight into the money path.
 */
const EXTRACTION_TOOLS = {
  [EXTRACTION_TOOL_NAME]: tool({
    description: 'Record the structured contents of the receipt in the image. Call this exactly once.',
    inputSchema: jsonSchema<ExtractedReceipt>(EXTRACTION_TOOL_INPUT_SCHEMA as JSONSchema7, { validate: validateExtraction }),
  }),
};

export class LiveVisionProvider implements VisionProvider {
  private readonly model: LanguageModel;
  private readonly maxOutputTokens: number;

  constructor(opts: LiveVisionProviderOptions) {
    this.model = opts.model;
    this.maxOutputTokens = opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  }

  async extract(input: ReceiptImageInput): Promise<ExtractedReceipt> {
    assertSupportedMimeType(input.mimeType);

    const result = await generateText({
      model: this.model,
      maxOutputTokens: this.maxOutputTokens,
      // Static instructions with a prompt-cache breakpoint (FR-7): the long
      // extraction rules are billed once per cache window, not per receipt.
      instructions: {
        role: 'system',
        content: RECEIPT_EXTRACTION_SYSTEM_PROMPT,
        providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
      },
      tools: EXTRACTION_TOOLS,
      toolChoice: { type: 'tool', toolName: EXTRACTION_TOOL_NAME },
      messages: [
        {
          role: 'user',
          content: [
            // JPEG/PNG and PDF all ride as a file part; the media type tells
            // the provider which reader to use (the real demo receipts are
            // Costco "Orders & Purchases" PDFs).
            { type: 'file', mediaType: input.mimeType, data: input.bytes },
            { type: 'text', text: `Extract this receipt by calling ${EXTRACTION_TOOL_NAME}.` },
          ],
        },
      ],
    }).catch((err: unknown) => {
      // The SDK enforces the forced tool choice: a refusal, a content filter
      // or a prose-only answer surfaces as this error rather than a result.
      // That is the unreadable path (FR-6): keep the upload, fabricate nothing,
      // emit zero line items. Anything else (auth, network, quota) propagates.
      if (ToolChoiceViolationError.isInstance(err)) return null;
      throw err;
    });
    if (!result) return unreadableReceipt();

    // The SDK does not throw on a tool call whose JSON is malformed or fails
    // validation: it hands back the call marked `invalid` (typed as a dynamic
    // call) with the raw string as its input. Nothing in such a call is
    // trusted — unreadable, zero items.
    const call = result.toolCalls.find((c) => c.toolName === EXTRACTION_TOOL_NAME);
    if (!call || call.dynamic || call.invalid) return unreadableReceipt();
    return normalizeExtracted(call.input);
  }
}

// Validated already; this applies the one rule the schema cannot express:
// when the model reports the image is unreadable, force the canonical
// zero-item shape so no stray field leaks through.
function normalizeExtracted(raw: ExtractedReceipt): ExtractedReceipt {
  if (raw.readable !== true) return unreadableReceipt();

  return {
    readable: true,
    store: raw.store ?? null,
    purchasedAt: raw.purchasedAt ?? null,
    total: raw.total ?? null,
    tax: raw.tax ?? null,
    fees: Array.isArray(raw.fees) ? raw.fees : [],
    paymentHint: raw.paymentHint ?? null,
    lineItems: Array.isArray(raw.lineItems) ? raw.lineItems.map(normalizeLineItem) : [],
  };
}

function normalizeLineItem(item: Partial<ExtractedLineItem>): ExtractedLineItem {
  return {
    sku: item.sku ?? null,
    rawDescription: item.rawDescription ?? '',
    quantity: item.quantity ?? 1,
    unitPrice: item.unitPrice ?? null,
    linePrice: item.linePrice ?? 0,
    discount: item.discount ?? 0,
  };
}
