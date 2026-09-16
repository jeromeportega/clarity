import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';

import { ModelSkuResolver, RECORD_RESOLUTION_TOOL_NAME } from './llm-resolver';
import type { ResolutionQuery } from './sku-resolver';

// The live resolver seam against the AI SDK's mock model: no network, no key.
const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 0, reasoning: undefined },
};

function modelReturning(content: unknown[]) {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: content as never,
      finishReason: { unified: 'tool-calls', raw: undefined },
      usage: USAGE,
      warnings: [],
    }),
  });
}

const query: ResolutionQuery = {
  store: 'COSTCO',
  sku: '1234567',
  description: 'KS ORG EVOO 2L',
  categories: ['groceries', 'household', 'other'],
};

const answer = { canonicalName: 'Kirkland Signature Organic Extra Virgin Olive Oil, 2 L', category: 'groceries', nameConfidence: 0.92, categoryConfidence: 0.97 };

describe('ModelSkuResolver (mock model, no network)', () => {
  it('forces the record_resolution tool with the allowed categories as the enum', async () => {
    const model = modelReturning([{ type: 'tool-call', toolCallId: 'c1', toolName: RECORD_RESOLUTION_TOOL_NAME, input: JSON.stringify(answer) }]);
    await new ModelSkuResolver({ model }).resolve(query);

    const call = model.doGenerateCalls[0]!;
    expect(call.toolChoice).toEqual({ type: 'tool', toolName: RECORD_RESOLUTION_TOOL_NAME });
    const [t] = call.tools as Array<{ name: string; inputSchema: { properties: { category: { enum: string[] } }; required: string[] } }>;
    expect(t.name).toBe(RECORD_RESOLUTION_TOOL_NAME);
    expect(t.inputSchema.properties.category.enum).toEqual(['groceries', 'household', 'other']);
    expect(t.inputSchema.required).toEqual(['canonicalName', 'category', 'nameConfidence', 'categoryConfidence']);
    expect(call.maxOutputTokens).toBe(256);
  });

  it('sends only store, code and printed description — no neighbouring items, no totals', async () => {
    const model = modelReturning([{ type: 'tool-call', toolCallId: 'c1', toolName: RECORD_RESOLUTION_TOOL_NAME, input: JSON.stringify(answer) }]);
    await new ModelSkuResolver({ model }).resolve(query);

    const user = model.doGenerateCalls[0]!.prompt.find((m) => m.role === 'user')!;
    const text = (user.content as Array<{ type: string; text?: string }>).map((p) => p.text ?? '').join('\n');
    expect(text).toContain('Store: COSTCO');
    expect(text).toContain('SKU/code: 1234567');
    expect(text).toContain('Printed line description: KS ORG EVOO 2L');
    expect(text).toContain('Allowed categories: groceries, household, other');
  });

  it('returns the tool input as an auto-sourced Resolution', async () => {
    const model = modelReturning([{ type: 'tool-call', toolCallId: 'c1', toolName: RECORD_RESOLUTION_TOOL_NAME, input: JSON.stringify(answer) }]);
    expect(await new ModelSkuResolver({ model }).resolve(query)).toEqual({ ...answer, source: 'auto' });
  });

  it('asks for the product identity without pack size, count, weight or volume', async () => {
    const model = modelReturning([{ type: 'tool-call', toolCallId: 'c1', toolName: RECORD_RESOLUTION_TOOL_NAME, input: JSON.stringify(answer) }]);
    await new ModelSkuResolver({ model }).resolve(query);
    const user = model.doGenerateCalls[0]!.prompt.find((m) => m.role === 'user')!;
    const text = (user.content as Array<{ type: string; text?: string }>).map((p) => p.text ?? '').join('\n');
    expect(text).toMatch(/WITHOUT pack size, count, weight or volume/);
  });

  it('throws when the tool call JSON does not parse (the orchestrator decides what to do)', async () => {
    const model = modelReturning([{ type: 'tool-call', toolCallId: 'c1', toolName: RECORD_RESOLUTION_TOOL_NAME, input: '{"canonicalName": "Oli' }]);
    await expect(new ModelSkuResolver({ model }).resolve(query)).rejects.toThrow(/record_resolution/);
  });

  it('throws when the call fails validation: a string confidence, an empty name', async () => {
    for (const bad of [{ ...answer, nameConfidence: '0.99' }, { ...answer, canonicalName: '   ' }]) {
      const model = modelReturning([{ type: 'tool-call', toolCallId: 'c1', toolName: RECORD_RESOLUTION_TOOL_NAME, input: JSON.stringify(bad) }]);
      await expect(new ModelSkuResolver({ model }).resolve(query), JSON.stringify(bad)).rejects.toThrow(/record_resolution/);
    }
  });

  it('does NOT reject a category outside the allowed list — clamping it is the orchestrator\'s job', async () => {
    const model = modelReturning([{ type: 'tool-call', toolCallId: 'c1', toolName: RECORD_RESOLUTION_TOOL_NAME, input: JSON.stringify({ ...answer, category: 'made-up' }) }]);
    expect((await new ModelSkuResolver({ model }).resolve(query)).category).toBe('made-up');
  });
});
