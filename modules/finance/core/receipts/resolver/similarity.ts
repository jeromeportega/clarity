import type { Resolution } from './sku-resolver';

// =============================================================================
// String similarity for the eval harness's correctness check (G-1).
//
// `similarityRatio` is a Sørensen–Dice coefficient over character bigrams of the
// normalized strings: 2·|shared bigrams| / (|bigrams(a)| + |bigrams(b)|), in
// [0,1]. It tolerates word-order and minor wording differences ("Organic Olive
// Oil" vs "Olive Oil, Organic") far better than exact match, which is what we
// want when grading a model-produced canonical name against a human reference.
// =============================================================================

// Lowercase, trim, and collapse internal whitespace so casing and spacing do not
// register as differences.
function normalize(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

// Multiset of adjacent character bigrams of `s`.
function bigrams(s: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const gram = s.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

export function similarityRatio(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);

  // Identical (after normalization) is a perfect match — also covers the
  // degenerate empty/one-character cases that have no bigrams to compare.
  if (na === nb) return 1;
  if (na.length < 2 || nb.length < 2) return 0;

  const aGrams = bigrams(na);
  const bGrams = bigrams(nb);

  let shared = 0;
  for (const [gram, countA] of aGrams) {
    const countB = bGrams.get(gram);
    if (countB !== undefined) shared += Math.min(countA, countB);
  }

  const total = na.length - 1 + (nb.length - 1);
  return (2 * shared) / total;
}

// The eval harness's definition of a correct resolution: the canonical name is
// similar enough (>= ratio) AND the category matches exactly. Category is a
// closed taxonomy, so it must be an exact hit — no fuzzy credit. When the
// reference carries no category at all (`null` — e.g. a retailer export that
// names products but does not classify them) the name alone decides.
export function isCorrectlyResolved(
  actual: Resolution,
  expected: { name: string; category: string | null },
  ratio: number,
): boolean {
  if (similarityRatio(actual.canonicalName, expected.name) < ratio) return false;
  return expected.category === null || actual.category === expected.category;
}
