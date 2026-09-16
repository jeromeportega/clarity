// Key normalization for the SKU dictionary. Producer (this module's dictionary)
// and consumer (the resolver, story-002-004) MUST normalize identically so a
// lookup hits the same row a prior upsert wrote. Normalization is idempotent:
// normalizing an already-normalized string is a no-op, so callers and the
// dictionary may both normalize without divergence.

// Typographic apostrophes vision tends to emit, folded onto the ASCII one the
// adapters write — "SAM’S CLUB" and "SAM'S CLUB" are one retailer.
const APOSTROPHES = /[‘’‛ʼ]/g;

// Trim, collapse internal runs of whitespace to a single space, then uppercase.
function normalizeKey(value: string): string {
  return value.replace(APOSTROPHES, "'").trim().replace(/\s+/g, ' ').toUpperCase();
}

// Words a retailer prints after its name that carry no identity: the same
// warehouse is "COSTCO WHSE" on a digital receipt, "COSTCO WHOLESALE" as the
// photo's header reads, and "COSTCO WHSE #1234" on a bank line. Every one of
// those must land on the same dictionary row.
const RETAILER_NOISE = new Set(['WHSE', 'WHOLESALE', 'INC', 'LLC', 'CORP']);

/** A token that is only punctuation (an orphaned `-` once its neighbours are gone). */
const PUNCTUATION_ONLY = /^[^A-Z0-9]+$/;

/**
 * Store name → one key per retailer: upper / trim / whitespace-collapse, then
 * drop store numbers and generic corporate suffixes.
 *
 * Store numbers are `#1234` anywhere, or a bare digit run at the END of the
 * name — never a leading or inner number, which is part of the name
 * (`99 RANCH MARKET`, `7 ELEVEN`, `365 BY WHOLE FOODS MARKET`). So
 * `"  Trader  Joe's "` → `"TRADER JOE'S"`; `"COSTCO WHSE #1234"`,
 * `"Costco Wholesale 0482"` and `"COSTCO"` → `"COSTCO"`. A name that is
 * nothing but noise keeps its plain normalization rather than collapsing to
 * an empty key.
 */
export function normalizeStore(store: string): string {
  const plain = normalizeKey(store);
  const tokens = plain.split(' ').filter((t) => !/^#\d+$/.test(t) && !RETAILER_NOISE.has(t));
  while (tokens.length > 1 && /^\d+$/.test(tokens[tokens.length - 1]!)) tokens.pop();
  const kept = tokens.filter((t) => !PUNCTUATION_ONLY.test(t));
  return kept.length > 0 ? kept.join(' ') : plain;
}

/**
 * SKU or abbreviation key. The caller picks the raw key as `sku ?? description`
 * ("key = SKU when present else abbreviation"); this normalizes whatever string
 * it is given the same way as the store, and additionally treats the `*`
 * emphasis markers Costco prints around some descriptions as separators
 * (`***BOUNTY***` → `BOUNTY`) so a digital line and the photo of it agree.
 */
export function normalizeSkuOrAbbrev(skuOrAbbrev: string): string {
  return normalizeKey(skuOrAbbrev.replace(/\*/g, ' '));
}
