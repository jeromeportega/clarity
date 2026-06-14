/**
 * Absolute difference between two ISO YYYY-MM-DD date strings, in days.
 * Returns Infinity when either string is missing or unparseable, so the
 * caller's date-window filter safely rejects the record rather than silently
 * accepting it with NaN arithmetic.
 */
export function daysBetween(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!isFinite(ta) || !isFinite(tb)) return Infinity;
  return Math.abs(tb - ta) / 86_400_000;
}
