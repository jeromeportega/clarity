/**
 * Sørensen–Dice bigram similarity coefficient.
 *
 * Compares two strings by the fraction of shared character bigrams.
 * Returns a value in [0, 1] — 1 means identical after normalisation.
 *
 * Used by the H3 matching engine for merchant-name comparison (FR-1).
 * Single canonical implementation shared across all callers (two callers:
 * receipt↔bank and Amazon↔bank matchers).
 */

function bigrams(s: string): string[] {
  const result: string[] = [];
  for (let i = 0; i < s.length - 1; i++) {
    result.push(s.slice(i, i + 2));
  }
  return result;
}

export function similarityRatio(a: string, b: string): number {
  const s1 = a.toUpperCase().trim();
  const s2 = b.toUpperCase().trim();
  if (s1 === s2) return 1;
  if (s1.length < 2 || s2.length < 2) return 0;

  const bg1 = bigrams(s1);
  const bg2 = bigrams(s2);

  // Count bigram frequencies in s1, then intersect with s2 (with multiplicity).
  const freq = new Map<string, number>();
  for (const bg of bg1) freq.set(bg, (freq.get(bg) ?? 0) + 1);

  let intersection = 0;
  for (const bg of bg2) {
    const count = freq.get(bg) ?? 0;
    if (count > 0) {
      intersection++;
      freq.set(bg, count - 1);
    }
  }

  return (2 * intersection) / (bg1.length + bg2.length);
}
