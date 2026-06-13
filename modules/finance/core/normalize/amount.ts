/**
 * Parse a money value into signed integer cents.
 *
 * Handles the shapes that appear across bank / order exports:
 *   - plain numbers (`12.34` → `1234`)
 *   - currency-formatted strings (`"$1,234.56"` → `123456`)
 *   - accounting negatives in parentheses (`"(12.34)"` → `-1234`)
 *   - leading or trailing sign (`"-5"`, `"5-"`)
 *
 * Source-specific quirks (Excel serial dates, locale decimal commas, etc.) belong
 * in the owning adapter, not here. Throws on anything it cannot parse rather than
 * guessing — a malformed row must surface as an ImportError, never a silent 0.
 */
export function parseAmountToCents(raw: string | number): number {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) throw new Error(`not a finite amount: ${raw}`);
    return Math.round(raw * 100);
  }

  let s = raw.trim();
  if (s.length === 0) throw new Error('empty amount');

  let negative = false;

  // Accounting style: "(12.34)" means negative.
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  // Leading sign.
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1).trim();
  } else if (s.startsWith('+')) {
    s = s.slice(1).trim();
  }
  // Trailing sign (some exports put the minus after the number).
  if (s.endsWith('-')) {
    negative = !negative;
    s = s.slice(0, -1).trim();
  }

  // Strip currency symbols, thousands separators, and stray whitespace.
  s = s.replace(/[\s,$£€]/g, '');

  if (!/^\d+(\.\d+)?$|^\.\d+$|^\d+\.$/.test(s)) {
    throw new Error(`unparseable amount: ${JSON.stringify(raw)}`);
  }

  const value = Number(s);
  if (!Number.isFinite(value)) throw new Error(`unparseable amount: ${JSON.stringify(raw)}`);

  const cents = Math.round(value * 100);
  return negative ? -cents : cents;
}
