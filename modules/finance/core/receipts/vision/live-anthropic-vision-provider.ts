import type Anthropic from '@anthropic-ai/sdk';
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

// Default to the current most-capable vision model; the caller may override.
const DEFAULT_MODEL = 'claude-opus-4-7';
const DEFAULT_MAX_TOKENS = 4096;

export interface LiveAnthropicVisionProviderOptions {
  // The Anthropic client is INJECTED — this module never constructs one, so the
  // core (and the default test gate) never depends on @anthropic-ai/sdk at
  // runtime or on an API key (NFR-1, G-3). The eval harness builds the client
  // and passes it in.
  client: Anthropic;
  model?: string;
  maxTokens?: number;
}

// The structured tool the model must call. Forcing `tool_choice` to this tool
// guarantees a typed object back instead of free-form prose.
const EXTRACTION_TOOL = {
  name: EXTRACTION_TOOL_NAME,
  description:
    'Record the structured contents of the receipt in the image. Call this exactly once.',
  input_schema: EXTRACTION_TOOL_INPUT_SCHEMA,
} as unknown as Anthropic.Tool;

export class LiveAnthropicVisionProvider implements VisionProvider {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(opts: LiveAnthropicVisionProviderOptions) {
    this.client = opts.client;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  async extract(input: ReceiptImageInput): Promise<ExtractedReceipt> {
    assertSupportedMimeType(input.mimeType);

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      // Static system prompt marked for prompt caching (FR-7). The cache
      // breakpoint sits on the block so the long instructions are billed once.
      system: [
        {
          type: 'text',
          text: RECEIPT_EXTRACTION_SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: [EXTRACTION_TOOL],
      tool_choice: { type: 'tool', name: EXTRACTION_TOOL_NAME },
      messages: [
        {
          role: 'user',
          content: [
            sourceBlock(input),
            { type: 'text', text: 'Extract this receipt by calling record_receipt.' },
          ],
        },
      ],
    });

    return parseResponse(response);
  }
}

// JPEG/PNG ride as an image block; PDF rides as a document block (operator
// guidance — the real demo receipts are Costco "Orders & Purchases" PDFs).
function sourceBlock(
  input: ReceiptImageInput,
): Anthropic.ImageBlockParam | Anthropic.DocumentBlockParam {
  const data = toBase64(input.bytes);
  if (input.mimeType === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  }
  return { type: 'image', source: { type: 'base64', media_type: input.mimeType, data } };
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

// A refusal (or any non-tool response) is the unreadable path (FR-6): keep the
// upload, fabricate nothing, emit zero line items.
function parseResponse(response: Anthropic.Message): ExtractedReceipt {
  if (response.stop_reason === 'refusal') return unreadableReceipt();

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock =>
      block.type === 'tool_use' && block.name === EXTRACTION_TOOL_NAME,
  );
  if (!toolUse) return unreadableReceipt();

  return normalizeExtracted(toolUse.input as Partial<ExtractedReceipt>);
}

// The model output is a trust boundary: coerce it into a well-formed
// `ExtractedReceipt` rather than assume every field is present. When the model
// reports the image is unreadable, force the canonical zero-item shape so no
// stray field leaks through.
function normalizeExtracted(raw: Partial<ExtractedReceipt>): ExtractedReceipt {
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
