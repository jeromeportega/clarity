/**
 * Normalize a raw merchant string into a stable, comparable form: uppercase,
 * punctuation flattened to spaces, runs of whitespace collapsed, trimmed.
 *
 * This is the generic pass shared by every adapter. Source-specific cleanup
 * (stripping a bank's trailing store/reference numbers, Amazon seller suffixes,
 * etc.) belongs in the owning adapter, not here.
 */
export function normalizeMerchant(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
