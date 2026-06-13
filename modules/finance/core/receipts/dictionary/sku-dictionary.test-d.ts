import { expectTypeOf } from 'vitest';
import type { DictionaryEntry, SkuDictionary } from './sku-dictionary';

// =============================================================================
// Type-level contract: DictionaryEntry exposes EXACTLY the columns of the
// sku_dictionary table, and the seam signatures match the epic contract §4.
// Adding/removing/renaming a field stops these from matching.
// =============================================================================

expectTypeOf<keyof DictionaryEntry>().toEqualTypeOf<
  | 'store'
  | 'skuOrAbbrev'
  | 'canonicalName'
  | 'category'
  | 'nameConfidence'
  | 'categoryConfidence'
  | 'source'
  | 'updatedAt'
>();

// `source` is the two-member union, never an open string.
expectTypeOf<DictionaryEntry['source']>().toEqualTypeOf<'auto' | 'human'>();
expectTypeOf<DictionaryEntry['updatedAt']>().toEqualTypeOf<number>();

// Seam signatures.
expectTypeOf<SkuDictionary['lookup']>().toEqualTypeOf<
  (store: string, skuOrAbbrev: string) => Promise<DictionaryEntry | null>
>();
expectTypeOf<SkuDictionary['upsert']>().toEqualTypeOf<
  (entry: DictionaryEntry) => Promise<void>
>();

const base: DictionaryEntry = {
  store: 'COSTCO',
  skuOrAbbrev: 'KS-EVOO',
  canonicalName: 'Kirkland Organic Olive Oil',
  category: 'groceries',
  nameConfidence: 0.95,
  categoryConfidence: 0.9,
  source: 'auto',
  updatedAt: 1,
};
void base;

// @ts-expect-error 'dictionary' is a Resolution source, not a stored entry source.
const badSource: DictionaryEntry = { ...base, source: 'dictionary' };
void badSource;

// @ts-expect-error confidence is not part of an entry's identity at the seam.
const drift: DictionaryEntry = { ...base, confidence: 0.5 };
void drift;
