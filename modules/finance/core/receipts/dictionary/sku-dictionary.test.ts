import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_RECEIPT_CONFIG } from '../config';
import { LibSqlSkuDictionary } from './libsql-sku-dictionary';
import { applySkuDictionarySchema, schema } from './schema';
import type { DictionaryEntry, SkuDictionary } from './sku-dictionary';
import { StubSkuDictionary } from './stub-sku-dictionary';

const ENTRY_KEYS = [
  'store',
  'skuOrAbbrev',
  'canonicalName',
  'category',
  'nameConfidence',
  'categoryConfidence',
  'source',
  'updatedAt',
].sort();

// A fixed clock value the CALLER would stamp via deps.clock. Far from any real
// Date.now() (~1.7e12), so a test can distinguish "stored verbatim" from "the
// dictionary substituted Date.now()".
const FIXED_TS = 1_000_000;

const sampleEntry = (overrides: Partial<DictionaryEntry> = {}): DictionaryEntry => ({
  store: 'COSTCO',
  skuOrAbbrev: 'KS-EVOO',
  canonicalName: 'Kirkland Organic Olive Oil',
  category: 'groceries',
  nameConfidence: 0.95,
  categoryConfidence: 0.9,
  source: 'auto',
  updatedAt: FIXED_TS,
  ...overrides,
});

interface Harness {
  dict: SkuDictionary;
  cleanup: () => void;
}

const factories: ReadonlyArray<readonly [string, () => Promise<Harness>]> = [
  [
    'StubSkuDictionary',
    async () => ({ dict: new StubSkuDictionary(), cleanup: () => {} }),
  ],
  [
    'LibSqlSkuDictionary',
    async () => {
      const client = createClient({ url: ':memory:' });
      await applySkuDictionarySchema(client);
      const db = drizzle(client, { schema });
      return { dict: new LibSqlSkuDictionary(db), cleanup: () => client.close() };
    },
  ],
];

describe.each(factories)('SkuDictionary contract — %s', (_name, make) => {
  let dict: SkuDictionary;
  let cleanup: () => void;

  beforeEach(async () => {
    ({ dict, cleanup } = await make());
  });
  afterEach(() => cleanup());

  it('cold start: lookup on an empty dictionary returns null without throwing', async () => {
    await expect(dict.lookup('COSTCO', 'KS-EVOO')).resolves.toBeNull();
  });

  it('append + instant repeat-resolve: lookup returns the full entry after upsert', async () => {
    const entry = sampleEntry();
    await dict.upsert(entry);

    const found = await dict.lookup('COSTCO', 'KS-EVOO');
    expect(found).not.toBeNull();
    expect(Object.keys(found!).sort()).toEqual(ENTRY_KEYS);
    // Separate name/category confidences, canonical name, and source all return.
    expect(found).toEqual(entry);
  });

  it('lookup is exact on the NORMALIZED key (store variants hit the same row)', async () => {
    await dict.upsert(sampleEntry({ store: "  Trader  Joe's " }));

    // Differently spaced/cased store strings normalize to the same key.
    const a = await dict.lookup("  Trader  Joe's ", 'KS-EVOO');
    const b = await dict.lookup("TRADER JOE'S", 'KS-EVOO');
    expect(a).not.toBeNull();
    expect(a).toEqual(b);
    // The stored entry carries the normalized store, not the raw input.
    expect(a!.store).toBe("TRADER JOE'S");
  });

  it('auto into an empty key writes successfully, tagged source=auto', async () => {
    await dict.upsert(sampleEntry({ source: 'auto' }));
    const found = await dict.lookup('COSTCO', 'KS-EVOO');
    expect(found!.source).toBe('auto');
  });

  it('human-wins: a human upsert overwrites an existing auto row', async () => {
    await dict.upsert(
      sampleEntry({ source: 'auto', canonicalName: 'Olive Oil (auto guess)' }),
    );

    await dict.upsert(
      sampleEntry({
        source: 'human',
        canonicalName: 'Kirkland Organic Extra Virgin Olive Oil',
        category: 'household',
        nameConfidence: 1,
        categoryConfidence: 1,
        updatedAt: FIXED_TS + 1,
      }),
    );

    const found = await dict.lookup('COSTCO', 'KS-EVOO');
    expect(found!.source).toBe('human');
    expect(found!.canonicalName).toBe('Kirkland Organic Extra Virgin Olive Oil');
    expect(found!.category).toBe('household');
    expect(found!.updatedAt).toBe(FIXED_TS + 1);
  });

  it('human-wins: an auto upsert NEVER clobbers an existing human row', async () => {
    const human = sampleEntry({
      source: 'human',
      canonicalName: 'Human Verified Name',
      nameConfidence: 1,
      categoryConfidence: 1,
    });
    await dict.upsert(human);

    // Incoming auto for the same key must be a no-op.
    await dict.upsert(
      sampleEntry({ source: 'auto', canonicalName: 'Auto Override Attempt' }),
    );

    const found = await dict.lookup('COSTCO', 'KS-EVOO');
    expect(found).toEqual(human); // human row preserved, untouched
  });

  it('auto NEVER overwrites an existing auto row (auto writes only into an empty key)', async () => {
    const first = sampleEntry({ source: 'auto', canonicalName: 'First Auto' });
    await dict.upsert(first);

    await dict.upsert(
      sampleEntry({ source: 'auto', canonicalName: 'Second Auto', updatedAt: FIXED_TS + 5 }),
    );

    const found = await dict.lookup('COSTCO', 'KS-EVOO');
    expect(found).toEqual(first); // original auto row preserved
  });

  it('a human upsert overwrites a prior human row (latest human wins)', async () => {
    await dict.upsert(sampleEntry({ source: 'human', canonicalName: 'Old Human' }));
    await dict.upsert(
      sampleEntry({ source: 'human', canonicalName: 'New Human', updatedAt: FIXED_TS + 9 }),
    );

    const found = await dict.lookup('COSTCO', 'KS-EVOO');
    expect(found!.canonicalName).toBe('New Human');
    expect(found!.updatedAt).toBe(FIXED_TS + 9);
  });

  it('deterministic updated_at: stores the caller-supplied value verbatim, never Date.now()', async () => {
    const before = Date.now();
    await dict.upsert(sampleEntry({ updatedAt: FIXED_TS }));
    const found = await dict.lookup('COSTCO', 'KS-EVOO');
    // The supplied 1e6 round-trips exactly; the dictionary did not substitute a
    // wall-clock value (which would be >= `before`, ~1.7e12).
    expect(found!.updatedAt).toBe(FIXED_TS);
    expect(found!.updatedAt).toBeLessThan(before);
  });

  it('keys distinctly per (store, sku) — different SKUs are independent rows', async () => {
    await dict.upsert(sampleEntry({ skuOrAbbrev: 'KS-EVOO', canonicalName: 'Olive Oil' }));
    await dict.upsert(sampleEntry({ skuOrAbbrev: 'KS-COFFEE', canonicalName: 'Coffee' }));

    expect((await dict.lookup('COSTCO', 'KS-EVOO'))!.canonicalName).toBe('Olive Oil');
    expect((await dict.lookup('COSTCO', 'KS-COFFEE'))!.canonicalName).toBe('Coffee');
  });
});

describe('SkuDictionary — stub and libSQL are behaviorally interchangeable', () => {
  it('produce identical observable entries for the same upsert -> lookup', async () => {
    const stub = new StubSkuDictionary();

    const client = createClient({ url: ':memory:' });
    await applySkuDictionarySchema(client);
    const libsql = new LibSqlSkuDictionary(drizzle(client, { schema }));

    const entry = sampleEntry({ store: '  costco ', skuOrAbbrev: ' ks-evoo ' });
    await stub.upsert(entry);
    await libsql.upsert(entry);

    const fromStub = await stub.lookup('COSTCO', 'KS-EVOO');
    const fromLibsql = await libsql.lookup('COSTCO', 'KS-EVOO');
    expect(fromStub).toEqual(fromLibsql);

    client.close();
  });
});

// The >= confidenceThreshold gate is the RESOLVER's job (story-002-004), not the
// dictionary's. Here we only confirm the default knob is plumbed and is 0.80.
describe('confidence threshold default (plumbing only)', () => {
  it('ReceiptConfig.confidenceThreshold defaults to 0.80', () => {
    expect(DEFAULT_RECEIPT_CONFIG.confidenceThreshold).toBe(0.8);
  });
});
