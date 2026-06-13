// =============================================================================
// The persistent learning SKU dictionary (FR-10, FR-11, FR-12).
//
// Keyed on (store, SKU-or-abbreviation), it caches a resolution so a repeat
// item resolves instantly with no LLM call. Both key parts are normalized via
// `./normalize` so a lookup hits whatever a prior upsert wrote.
//
// `upsert` enforces ONE invariant — human-wins precedence (see the upsert law
// in `./schema`): a `source='human'` row always overwrites; a `source='auto'`
// row writes only when no row exists and never clobbers an existing row. The
// confidence gate (>= confidenceThreshold) is the resolver's job (story-002-004)
// BEFORE it calls upsert — the dictionary does not gate on confidence.
//
// `updatedAt` is supplied by the caller (from its injected clock dep), never
// stamped with `Date.now()` here, so tests are deterministic.
// =============================================================================

export interface DictionaryEntry {
  store: string; // normalized via normalizeStore
  skuOrAbbrev: string; // normalized via normalizeSkuOrAbbrev
  canonicalName: string;
  category: string; // a taxonomy member (the resolver guarantees this)
  nameConfidence: number;
  categoryConfidence: number;
  source: 'auto' | 'human';
  updatedAt: number; // epoch ms, supplied by the caller's clock dep
}

export interface SkuDictionary {
  lookup(store: string, skuOrAbbrev: string): Promise<DictionaryEntry | null>;
  // Enforces human-wins precedence ONLY (see the upsert law in ./schema).
  upsert(entry: DictionaryEntry): Promise<void>;
}
