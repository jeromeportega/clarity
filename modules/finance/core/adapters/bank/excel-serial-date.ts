/**
 * Convert an Excel **1900-system** serial date to ISO `YYYY-MM-DD`.
 *
 * Excel famously treats 1900 as a leap year and so counts a non-existent
 * `1900-02-29` at serial 60, shifting every serial from 61 onward one day late
 * (FR-18). The correction:
 *   - serials 1..59 map straight through (serial 1 = 1900-01-01);
 *   - serial 60 is the phantom day — we refuse it (the caller turns the throw
 *     into a structured ImportError) rather than emit a date that never existed;
 *   - serials >= 61 are shifted back one day to undo the phantom.
 *
 * Bank-specific by design — the shared `normalize/date.ts` deliberately knows
 * nothing about spreadsheet serials. Computed from epoch arithmetic in UTC, never
 * `new Date(string)`, so there is no timezone drift. Any time-of-day fraction is
 * dropped to the calendar day.
 */

const PHANTOM_LEAP_SERIAL = 60;

// 1899-12-31 UTC. With the phantom day removed, effective-day 1 lands on 1900-01-01.
const EPOCH_MS = Date.UTC(1899, 11, 31);
const MS_PER_DAY = 86_400_000;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function excelSerialToIsoDate(serial: number): string {
  if (typeof serial !== 'number' || !Number.isFinite(serial) || serial < 1) {
    throw new Error(`not a valid Excel serial date: ${serial}`);
  }

  const day = Math.floor(serial);
  if (day === PHANTOM_LEAP_SERIAL) {
    throw new Error('Excel serial 60 is the fictional 1900-02-29 (1900 leap-year bug)');
  }

  const effectiveDays = day > PHANTOM_LEAP_SERIAL ? day - 1 : day;
  const date = new Date(EPOCH_MS + effectiveDays * MS_PER_DAY);
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${pad2(date.getUTCMonth() + 1)}-${pad2(
    date.getUTCDate(),
  )}`;
}
