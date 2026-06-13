// =============================================================================
// The SKU disambiguation resolver seam (FR-9, FR-11, FR-12).
//
// `resolve` turns an abbreviated line description + optional SKU + store context
// into a canonical product name and a category drawn ONLY from H1's taxonomy,
// with SEPARATE confidence scores for the name and the category axis.
//
// The orchestration contract (see LlmSkuResolver) is dictionary-first:
//   1. Normalize (store, sku ?? description) and look the key up in the
//      SkuDictionary. A hit returns immediately with `source:'dictionary'` and
//      NO model call (FR-11) — this is the load-bearing repeat-resolve path.
//   2. On a miss, call the generic LLM resolver (the default path, FR-9). The
//      returned category is clamped to the query's taxonomy: if it is outside
//      `query.categories`, `categoryConfidence` is forced to 0 (ADR-008) — a
//      category is never invented.
//   3. If min(nameConfidence, categoryConfidence) >= confidenceThreshold, the
//      auto-resolution is appended back to the dictionary tagged `source:'auto'`
//      (FR-12); otherwise the write-back is skipped.
// =============================================================================

export interface Resolution {
  canonicalName: string;
  // Guaranteed a taxonomy member, OR categoryConfidence is 0 (ADR-008): when the
  // model returns an out-of-taxonomy category we keep its string but force the
  // category confidence to 0 rather than inventing a different category.
  category: string;
  nameConfidence: number; // [0,1]
  categoryConfidence: number; // [0,1]
  source: 'dictionary' | 'auto' | 'human';
}

export interface ResolutionQuery {
  store: string;
  sku: string | null;
  description: string;
  // The allowed taxonomy = await store.listCategories(); passed in by the
  // caller and read nowhere else. The resolver constrains `category` to this.
  categories: readonly string[];
}

export interface SkuResolver {
  resolve(query: ResolutionQuery): Promise<Resolution>;
}
