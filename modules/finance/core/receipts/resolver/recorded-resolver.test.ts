import { describe, expect, it } from 'vitest';
import { RecordedSkuResolver, resolverFixtureKey } from './recorded-resolver';
import type { ResolutionQuery } from './sku-resolver';

// Uses the checked-in fixtures under ../fixtures/resolver. Fully offline.
const CATEGORIES = ['groceries', 'household', 'electronics'] as const;

const query = (overrides: Partial<ResolutionQuery> = {}): ResolutionQuery => ({
  store: 'Costco',
  sku: 'KS-EVOO',
  description: 'KS EVOO 2L',
  categories: CATEGORIES,
  ...overrides,
});

describe('resolverFixtureKey (epic contract §9)', () => {
  it('joins normalized store and sku/abbrev with a double underscore', () => {
    expect(resolverFixtureKey('  Costco ', 'ks-evoo')).toBe('COSTCO__KS-EVOO');
  });
});

describe('RecordedSkuResolver', () => {
  it('replays the recorded Resolution for a known (store, sku) key', async () => {
    const resolver = new RecordedSkuResolver();
    const out = await resolver.resolve(query());
    expect(out).toEqual({
      canonicalName: 'Kirkland Organic Extra Virgin Olive Oil',
      category: 'groceries',
      nameConfidence: 0.95,
      categoryConfidence: 0.9,
      source: 'auto',
    });
  });

  it('finds the same fixture regardless of store casing/whitespace (key parity)', async () => {
    const resolver = new RecordedSkuResolver();
    const a = await resolver.resolve(query({ store: '  costco ' }));
    const b = await resolver.resolve(query({ store: 'COSTCO' }));
    expect(a).toEqual(b);
  });

  it('keys on the description when no SKU is printed (sku null)', async () => {
    const resolver = new RecordedSkuResolver();
    const out = await resolver.resolve(
      query({ store: 'Walmart', sku: null, description: 'gv-milk' }),
    );
    expect(out.canonicalName).toBe('Great Value 2% Reduced Fat Milk, 1 Gallon');
    // Recorded with deliberately distinct name vs category confidence.
    expect(out.nameConfidence).toBe(0.88);
    expect(out.categoryConfidence).toBe(0.72);
  });

  it('throws a descriptive error when the fixture is missing', async () => {
    const resolver = new RecordedSkuResolver();
    await expect(
      resolver.resolve(query({ store: 'Nowhere', sku: 'UNRECORDED' })),
    ).rejects.toThrow(/no fixture for key "NOWHERE__UNRECORDED"/);
  });
});
