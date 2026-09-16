// Key normalization for the SKU dictionary. Producer (this module's dictionary)
// and consumer (the resolver, story-002-004) MUST normalize identically so a
// lookup hits the same row a prior upsert wrote. Normalization is idempotent:
// normalizing an already-normalized string is a no-op, so callers and the
// dictionary may both normalize without divergence.

// Trim, collapse internal runs of whitespace to a single space, then uppercase.
function normalizeKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toUpperCase();
}

// Words a retailer prints after its name that carry no identity: the same
// warehouse is "COSTCO WHSE" on a digital receipt, "COSTCO WHOLESALE" as the
// photo's header reads, and "COSTCO WHSE #1234" on a bank line. Every one of
// those must land on the same dictionary row.
const RETAILER_NOISE = new Set(['WHSE', 'WHOLESALE', 'INC', 'LLC', 'CORP']);

/**
 * Store name → one key per retailer: upper / trim / whitespace-collapse, then
 * drop store numbers (`#1234`, bare digit runs) and generic corporate suffixes.
 * `"  Trader  Joe's "` → `"TRADER JOE'S"`; `"COSTCO WHSE #1234"`, `"Costco
 * Wholesale"` and `"COSTCO"` → `"COSTCO"`. A name that is nothing but noise
 * keeps its plain normalization rather than collapsing to an empty key.
 */
export function normalizeStore(store: string): string {
  const plain = normalizeKey(store);
  const kept = plain
    .split(' ')
    .filter((token) => !/^#?\d+$/.test(token) && !RETAILER_NOISE.has(token));
  return kept.length > 0 ? kept.join(' ') : plain;
}

/**
 * SKU or abbreviation key. The caller picks the raw key as `sku ?? description`
 * ("key = SKU when present else abbreviation"); this normalizes whatever string
 * it is given the same way as the store, and additionally drops the `*`
 * emphasis markers Costco prints around some line descriptions
 * (`***BOUNTY***` → `BOUNTY`) so a digital line and the photo of it agree.
 */
export function normalizeSkuOrAbbrev(skuOrAbbrev: string): string {
  return normalizeKey(skuOrAbbrev.replace(/\*/g, ' '));
}
