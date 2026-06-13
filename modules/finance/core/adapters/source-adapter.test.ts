import { describe, expect, it } from 'vitest';

import { emlAdapter } from './eml.adapter';
import { retailerApiAdapter } from './retailer-api.adapter';
import {
  NotImplementedError,
  type NormalizedBatch,
  type RawInput,
  type SourceAdapter,
} from './source-adapter';

function makeInput(kind: RawInput['kind']): RawInput {
  return { kind, filename: `sample.${kind}`, bytes: new Uint8Array([1, 2, 3]) };
}

describe('SourceAdapter contract', () => {
  it('a conforming object satisfies { kind, supports, normalize } and yields a NormalizedBatch', async () => {
    const adapter: SourceAdapter = {
      kind: 'bank',
      supports: (input) => input.kind === 'bank',
      normalize: () => ({ transactions: [], orders: [], receipts: [], errors: [] }),
    };

    expect(adapter.kind).toBe('bank');
    expect(adapter.supports(makeInput('bank'))).toBe(true);
    expect(adapter.supports(makeInput('amazon'))).toBe(false);

    const batch: NormalizedBatch = await adapter.normalize(makeInput('bank'));
    expect(Object.keys(batch).sort()).toEqual(['errors', 'orders', 'receipts', 'transactions']);
    expect(Array.isArray(batch.transactions)).toBe(true);
    expect(Array.isArray(batch.orders)).toBe(true);
    expect(Array.isArray(batch.receipts)).toBe(true);
    expect(Array.isArray(batch.errors)).toBe(true);
  });

  it('NotImplementedError is an Error tagged with the NotImplemented name', () => {
    const err = new NotImplementedError('nope');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('NotImplemented');
    expect(err.message).toBe('nope');
  });
});

describe('stub adapter slots (retailer-api, eml)', () => {
  it('retailerApiAdapter declines support and throws NotImplemented on normalize (FR-9)', () => {
    expect(retailerApiAdapter.kind).toBe('retailer-api');
    expect(retailerApiAdapter.supports(makeInput('retailer-api'))).toBe(false);
    expect(() => retailerApiAdapter.normalize(makeInput('retailer-api'))).toThrow(
      NotImplementedError,
    );
  });

  it('emlAdapter declines support and throws NotImplemented on normalize (FR-9)', () => {
    expect(emlAdapter.kind).toBe('eml');
    expect(emlAdapter.supports(makeInput('eml'))).toBe(false);
    expect(() => emlAdapter.normalize(makeInput('eml'))).toThrow(NotImplementedError);
  });
});
