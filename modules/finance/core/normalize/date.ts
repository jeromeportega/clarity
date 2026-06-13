/**
 * Normalize a common date string to ISO `YYYY-MM-DD`.
 *
 * Recognizes the formats that appear across bank / order exports:
 *   - already-ISO (`2026-01-05`, optionally with a trailing time)
 *   - `YYYY/MM/DD`
 *   - US `M/D/YYYY` and `M-D-YYYY`
 *   - month-name forms (`Jan 5, 2026`, `January 5 2026`, `5 Jan 2026`)
 *
 * Parsing is done from string parts — never via `new Date(str)` — so there is no
 * timezone drift. Source-specific encodings (e.g. Excel serial numbers) belong in
 * the owning adapter. Throws on anything it cannot parse.
 */

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function iso(year: number, month: number, day: number, raw: string): string {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`unparseable date: ${JSON.stringify(raw)}`);
  }
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    throw new Error(`unparseable date: ${JSON.stringify(raw)}`);
  }
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

export function toIsoDate(raw: string): string {
  const s = raw.trim();
  if (s.length === 0) throw new Error('empty date');

  // ISO `YYYY-MM-DD` (optionally followed by time/zone).
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]), raw);

  // `YYYY/MM/DD`.
  m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(s);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]), raw);

  // US `M/D/YYYY` or `M-D-YYYY`.
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
  if (m) return iso(Number(m[3]), Number(m[1]), Number(m[2]), raw);

  // Month-name: `Jan 5, 2026` / `January 5 2026`.
  m = /^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m?.[1]) {
    const month = MONTHS[m[1].toLowerCase()];
    if (month !== undefined) return iso(Number(m[3]), month, Number(m[2]), raw);
  }

  // Month-name: `5 Jan 2026` / `5 January 2026`.
  m = /^(\d{1,2})\s+([A-Za-z]+)\.?,?\s+(\d{4})$/.exec(s);
  if (m?.[2]) {
    const month = MONTHS[m[2].toLowerCase()];
    if (month !== undefined) return iso(Number(m[3]), month, Number(m[1]), raw);
  }

  throw new Error(`unparseable date: ${JSON.stringify(raw)}`);
}
