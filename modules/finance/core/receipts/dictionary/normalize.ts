// Key normalization for the SKU dictionary. Producer (this module's dictionary)
// and consumer (the resolver, story-002-004) MUST normalize identically so a
// lookup hits the same row a prior upsert wrote. Normalization is idempotent:
// normalizing an already-normalized string is a no-op, so callers and the
// dictionary may both normalize without divergence.

// Trim, collapse internal runs of whitespace to a single space, then uppercase.
function normalizeKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toUpperCase();
}

// Store name: upper / trim / whitespace-collapse. e.g. "  Trader  Joe's " ->
// "TRADER JOE'S".
export function normalizeStore(store: string): string {
  return normalizeKey(store);
}

// SKU or abbreviation key. The caller picks the raw key as `sku ?? description`
// ("key = SKU when present else abbreviation"); this function only normalizes
// whatever string it is given, the same way as the store.
export function normalizeSkuOrAbbrev(skuOrAbbrev: string): string {
  return normalizeKey(skuOrAbbrev);
}
