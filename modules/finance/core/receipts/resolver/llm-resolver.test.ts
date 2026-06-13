import { beforeEach, describe, expect, it } from 'vitest';
import type { DictionaryEntry } from '../dictionary/sku-dictionary';
import { StubSkuDictionary } from '../dictionary/stub-sku-dictionary';
import { StubReceiptStore } from '../store/stub-receipt-store';
import { LlmSkuResolver } from './llm-resolver';
import { RecordedSkuResolver } from './recorded-resolver';
import type { Resolution, ResolutionQuery, SkuResolver } from './sku-resolver';

// A recorded/spy LLM seam: returns a pre-determined Resolution (no network) and
// records every query so a test can assert the seam was — or was NOT — invoked.
class SpySkuResolver implements SkuResolver {
  public readonly calls: ResolutionQuery[] = [];
  constructor(private readonly output: Resolution) {}
  async resolve(query: ResolutionQuery): Promise<Resolution> {
    this.calls.push(query);
    return { ...this.output };
  }
}

const FIXED_TS = 1_000_000;

const llmOutput = (overrides: Partial<Resolution> = {}): Resolution => ({
  canonicalName: 'Kirkland Organic Extra Virgin Olive Oil',
  category: 'groceries',
  nameConfidence: 0.95,
  categoryConfidence: 0.9,
  source: 'auto',
  ...overrides,
});

describe('LlmSkuResolver — dictionary-first orchestration (epic contract §8)', () => {
  let dictionary: StubSkuDictionary;
  let categories: readonly string[];

  beforeEach(async () => {
    dictionary = new StubSkuDictionary();
    categories = await new StubReceiptStore().listCategories();
  });

  const query = (overrides: Partial<ResolutionQuery> = {}): ResolutionQuery => ({
    store: 'Costco',
    sku: 'KS-EVOO',
    description: 'KS EVOO 2L',
    categories,
    ...overrides,
  });

  const makeResolver = (llm: SkuResolver, opts: { confidenceThreshold?: number } = {}) =>
    new LlmSkuResolver({
      dictionary,
      llm,
      confidenceThreshold: opts.confidenceThreshold,
      clock: () => FIXED_TS,
    });

  it('dictionary hit short-circuits: returns source:"dictionary" and NEVER calls the LLM seam (FR-11, G-4)', async () => {
    // Seed the dictionary for the NORMALIZED key the resolver will compute.
    const seeded: DictionaryEntry = {
      store: 'COSTCO',
      skuOrAbbrev: 'KS-EVOO',
      canonicalName: 'Kirkland Organic Olive Oil',
      category: 'groceries',
      nameConfidence: 0.91,
      categoryConfidence: 0.93,
      source: 'human',
      updatedAt: FIXED_TS,
    };
    await dictionary.upsert(seeded);

    const spy = new SpySkuResolver(llmOutput());
    const resolution = await makeResolver(spy).resolve(query());

    expect(spy.calls).toHaveLength(0); // the load-bearing no-LLM-on-repeat behavior
    expect(resolution).toEqual({
      canonicalName: 'Kirkland Organic Olive Oil',
      category: 'groceries',
      nameConfidence: 0.91,
      categoryConfidence: 0.93,
      source: 'dictionary',
    });
  });

  it('miss falls back to the generic LLM resolver (default path, FR-9)', async () => {
    const spy = new SpySkuResolver(llmOutput());
    const resolution = await makeResolver(spy).resolve(query());

    expect(spy.calls).toHaveLength(1);
    expect(resolution.source).toBe('auto');
    expect(resolution.canonicalName).toBe('Kirkland Organic Extra Virgin Olive Oil');
    expect(resolution.category).toBe('groceries');
    expect(resolution.nameConfidence).toBe(0.95);
    expect(resolution.categoryConfidence).toBe(0.9);
  });

  it('category is constrained to the taxonomy: a member, or categoryConfidence forced to 0', async () => {
    const spy = new SpySkuResolver(llmOutput({ category: 'groceries' }));
    const resolution = await makeResolver(spy).resolve(query());
    expect(
      categories.includes(resolution.category) || resolution.categoryConfidence === 0,
    ).toBe(true);
    expect(categories.includes(resolution.category)).toBe(true);
  });

  it('out-of-taxonomy clamp (ADR-008): categoryConfidence forced to 0, no category invented, not cached', async () => {
    const spy = new SpySkuResolver(
      llmOutput({ category: 'snacks', nameConfidence: 0.99, categoryConfidence: 0.99 }),
    );
    const resolution = await makeResolver(spy).resolve(query());

    expect(resolution.categoryConfidence).toBe(0); // forced
    expect(resolution.category).toBe('snacks'); // model's string kept, not replaced/invented
    expect(categories).not.toContain('snacks');
    // min(name, category) = 0 < threshold, so an out-of-taxonomy guess is never written back.
    expect(await dictionary.lookup('COSTCO', 'KS-EVOO')).toBeNull();
  });

  it('emits SEPARATE name and category confidences, both in [0,1] (FR-9)', async () => {
    const spy = new SpySkuResolver(llmOutput({ nameConfidence: 0.88, categoryConfidence: 0.61 }));
    const resolution = await makeResolver(spy).resolve(query());

    expect(resolution.nameConfidence).not.toBe(resolution.categoryConfidence);
    expect(resolution.nameConfidence).toBe(0.88);
    expect(resolution.categoryConfidence).toBe(0.61);
    for (const c of [resolution.nameConfidence, resolution.categoryConfidence]) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
    }
  });

  describe('auto write-back gate (FR-12)', () => {
    it('writes back tagged source:"auto" when min(confidence) is exactly the threshold (0.80)', async () => {
      const spy = new SpySkuResolver(llmOutput({ nameConfidence: 0.8, categoryConfidence: 0.8 }));
      await makeResolver(spy).resolve(query());

      const stored = await dictionary.lookup('COSTCO', 'KS-EVOO');
      expect(stored).not.toBeNull();
      expect(stored!.source).toBe('auto');
      expect(stored!.nameConfidence).toBe(0.8);
      expect(stored!.categoryConfidence).toBe(0.8);
      expect(stored!.updatedAt).toBe(FIXED_TS); // injected clock, not Date.now()
    });

    it('does NOT write back when min(confidence) is just below the threshold (0.79)', async () => {
      const spy = new SpySkuResolver(llmOutput({ nameConfidence: 0.79, categoryConfidence: 0.95 }));
      await makeResolver(spy).resolve(query());

      expect(await dictionary.lookup('COSTCO', 'KS-EVOO')).toBeNull();
    });
  });

  it('configurable threshold shifts the write-back boundary (FR-14)', async () => {
    // 0.85/0.85 is above the 0.80 default but below a 0.90 override.
    const out = llmOutput({ nameConfidence: 0.85, categoryConfidence: 0.85 });

    const strictDict = new StubSkuDictionary();
    const strict = new LlmSkuResolver({
      dictionary: strictDict,
      llm: new SpySkuResolver(out),
      confidenceThreshold: 0.9,
      clock: () => FIXED_TS,
    });
    await strict.resolve(query());
    expect(await strictDict.lookup('COSTCO', 'KS-EVOO')).toBeNull(); // below 0.90 → not written

    // Same output under the default 0.80 threshold DOES get cached.
    await makeResolver(new SpySkuResolver(out)).resolve(query());
    expect(await dictionary.lookup('COSTCO', 'KS-EVOO')).not.toBeNull();
  });

  it('normalization round-trip: miss → write-back → repeat is a HIT with no second LLM call', async () => {
    const spy = new SpySkuResolver(llmOutput({ nameConfidence: 0.9, categoryConfidence: 0.9 }));
    const resolver = makeResolver(spy);

    const first = await resolver.resolve(query());
    expect(first.source).toBe('auto');
    expect(spy.calls).toHaveLength(1);

    // Re-resolve the SAME logical key with different casing/spacing. Resolver and
    // dictionary normalize identically, so this is a cache hit — no second call.
    const second = await resolver.resolve(
      query({ store: '  costco ', sku: ' ks-evoo ' }),
    );
    expect(second.source).toBe('dictionary');
    expect(second.canonicalName).toBe(first.canonicalName);
    expect(spy.calls).toHaveLength(1);
  });

  it('drives the full path with a recorded fixture seam (offline, no key)', async () => {
    const resolver = makeResolver(new RecordedSkuResolver());
    const resolution = await resolver.resolve(query());

    expect(resolution.source).toBe('auto');
    expect(resolution.canonicalName).toBe('Kirkland Organic Extra Virgin Olive Oil');
    // Fixture confidences (0.95 / 0.90) clear 0.80, so the resolution is cached.
    const stored = await dictionary.lookup('COSTCO', 'KS-EVOO');
    expect(stored!.source).toBe('auto');
  });
});
