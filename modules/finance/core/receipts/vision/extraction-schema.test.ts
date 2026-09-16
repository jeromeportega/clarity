import { describe, expect, it } from 'vitest';

import { ExtractedReceiptSchema, validateExtraction } from './extraction-schema';
import { EXTRACTION_TOOL_INPUT_SCHEMA } from './system-prompt';
import type { ExtractedReceipt } from './vision-provider';

const sample: ExtractedReceipt = {
  readable: true,
  store: 'COSTCO WHOLESALE #1021',
  purchasedAt: '2026-05-30',
  total: 5013,
  tax: 396,
  fees: [{ kind: 'crv', label: 'CRV', amount: 10 }],
  paymentHint: { method: 'VISA', last4: '4242' },
  lineItems: [{ sku: '1234567', rawDescription: 'KS ORG EVOO 2L', quantity: 1, unitPrice: 1899, linePrice: 1899, discount: 0 }],
};

describe('ExtractedReceiptSchema — the model output is a trust boundary', () => {
  it('accepts a well-formed extraction unchanged', () => {
    expect(validateExtraction(sample)).toEqual({ success: true, value: sample });
  });

  it('rejects money that is not integer cents (a float total, a string tax)', () => {
    expect(validateExtraction({ ...sample, total: 50.13 }).success).toBe(false);
    expect(validateExtraction({ ...sample, tax: '396' }).success).toBe(false);
    expect(validateExtraction({ ...sample, lineItems: [{ ...sample.lineItems[0], linePrice: 18.99 }] }).success).toBe(false);
  });

  it('rejects a negative discount and an unknown fee kind', () => {
    expect(validateExtraction({ ...sample, lineItems: [{ ...sample.lineItems[0], discount: -1 }] }).success).toBe(false);
    expect(validateExtraction({ ...sample, fees: [{ kind: 'tip', label: 'x', amount: 1 }] }).success).toBe(false);
  });

  it('rejects a missing required field and a wrong type for readable', () => {
    const { store: _dropped, ...withoutStore } = sample;
    expect(validateExtraction(withoutStore).success).toBe(false);
    expect(validateExtraction({ ...sample, readable: 'yes' }).success).toBe(false);
  });

  it('tolerates omitted arrays (empty, never fabricated) and drops unknown keys', () => {
    const { fees: _f, lineItems: _l, ...sparse } = sample;
    const r = validateExtraction({ ...sparse, surprise: 1 });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.value.fees).toEqual([]);
      expect(r.value.lineItems).toEqual([]);
      expect('surprise' in r.value).toBe(false);
    }
  });

  it('agrees with the JSON Schema the model is shown: same top-level fields, same line-item fields', () => {
    const zodKeys = Object.keys(ExtractedReceiptSchema.shape).sort();
    expect(zodKeys).toEqual([...EXTRACTION_TOOL_INPUT_SCHEMA.required].sort());
    expect(zodKeys).toEqual(Object.keys(EXTRACTION_TOOL_INPUT_SCHEMA.properties).sort());

    const lineItem = ExtractedReceiptSchema.shape.lineItems.unwrap().element;
    expect(Object.keys(lineItem.shape).sort()).toEqual([...EXTRACTION_TOOL_INPUT_SCHEMA.properties.lineItems.items.required].sort());
    const fee = ExtractedReceiptSchema.shape.fees.unwrap().element;
    expect(Object.keys(fee.shape).sort()).toEqual([...EXTRACTION_TOOL_INPUT_SCHEMA.properties.fees.items.required].sort());
    expect(fee.shape.kind.options).toEqual([...EXTRACTION_TOOL_INPUT_SCHEMA.properties.fees.items.properties.kind.enum]);
  });
});
