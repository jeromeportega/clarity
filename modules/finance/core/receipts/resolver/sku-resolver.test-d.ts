import { expectTypeOf } from 'vitest';
import type { Resolution, ResolutionQuery, SkuResolver } from './sku-resolver';

// =============================================================================
// Type-level contract: the resolver seam matches epic contract §2/§4 exactly.
// Adding/removing/renaming a field stops these from matching.
// =============================================================================

expectTypeOf<keyof Resolution>().toEqualTypeOf<
  | 'canonicalName'
  | 'category'
  | 'nameConfidence'
  | 'categoryConfidence'
  | 'source'
>();

// A Resolution carries the three-member source union (a stored DictionaryEntry
// is narrower — only 'auto' | 'human').
expectTypeOf<Resolution['source']>().toEqualTypeOf<'dictionary' | 'auto' | 'human'>();
expectTypeOf<Resolution['nameConfidence']>().toEqualTypeOf<number>();
expectTypeOf<Resolution['categoryConfidence']>().toEqualTypeOf<number>();

expectTypeOf<keyof ResolutionQuery>().toEqualTypeOf<
  'store' | 'sku' | 'description' | 'categories'
>();
expectTypeOf<ResolutionQuery['sku']>().toEqualTypeOf<string | null>();
expectTypeOf<ResolutionQuery['categories']>().toEqualTypeOf<readonly string[]>();

// Seam signature.
expectTypeOf<SkuResolver['resolve']>().toEqualTypeOf<
  (query: ResolutionQuery) => Promise<Resolution>
>();

const base: Resolution = {
  canonicalName: 'Kirkland Organic Olive Oil',
  category: 'groceries',
  nameConfidence: 0.95,
  categoryConfidence: 0.9,
  source: 'auto',
};
void base;

// @ts-expect-error a single combined confidence is not the seam; the two axes are separate.
const drift: Resolution = { ...base, confidence: 0.5 };
void drift;
