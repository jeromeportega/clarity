const MS_PER_DAY = 86_400_000;

/**
 * An ISO YYYY-MM-DD date as a day number (days since the epoch), or null when
 * missing or unparseable. Parse once per record, compare numerically per pair —
 * the matchers score every candidate pair, so parsing dates inside the pair
 * loop is what made a large household quadratic in wall-clock terms.
 */
export function epochDay(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return isFinite(t) ? t / MS_PER_DAY : null;
}

/**
 * Absolute difference between two ISO YYYY-MM-DD date strings, in days.
 * Returns Infinity when either string is missing or unparseable, so the
 * caller's date-window filter safely rejects the record rather than silently
 * accepting it with NaN arithmetic.
 */
export function daysBetween(a: string, b: string): number {
  const da = epochDay(a);
  const db = epochDay(b);
  if (da === null || db === null) return Infinity;
  return Math.abs(db - da);
}

/** First index in an ascending array whose value is >= `target`. */
export function lowerBound(sorted: readonly number[], target: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index in an ascending array whose value is > `target`. */
export function upperBound(sorted: readonly number[], target: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
