import { describe, expect, it } from 'vitest';

import { excelSerialToIsoDate } from './excel-serial-date';

/**
 * The 1900 leap-year bug (FR-18): Excel's 1900 date system counts a non-existent
 * `1900-02-29` at serial 60, shifting every later serial by one day. A correct
 * converter must never emit `1900-02-29` and must keep modern dates exact.
 */
describe('excelSerialToIsoDate — 1900 date system', () => {
  it('converts serial 1 to 1900-01-01', () => {
    expect(excelSerialToIsoDate(1)).toBe('1900-01-01');
  });

  it('resolves the boundary serials around the phantom leap day correctly', () => {
    expect(excelSerialToIsoDate(59)).toBe('1900-02-28');
    expect(excelSerialToIsoDate(61)).toBe('1900-03-01');
    expect(excelSerialToIsoDate(366)).toBe('1900-12-31');
  });

  it('guards the 1900 leap-year bug: serial 60 never becomes 1900-02-29', () => {
    // Serial 60 is Excel's fictional 1900-02-29. We refuse it (surfaces as an
    // ImportError upstream) rather than silently emitting a date that never was.
    expect(() => excelSerialToIsoDate(60)).toThrow();
    let produced: string | undefined;
    try {
      produced = excelSerialToIsoDate(60);
    } catch {
      produced = undefined;
    }
    expect(produced).not.toBe('1900-02-29');
  });

  it('converts modern dates exactly', () => {
    expect(excelSerialToIsoDate(45292)).toBe('2024-01-01');
    expect(excelSerialToIsoDate(45678)).toBe('2025-01-21');
  });

  it('drops the time fraction, keeping the calendar day', () => {
    expect(excelSerialToIsoDate(45292.75)).toBe('2024-01-01');
  });

  it('throws on non-positive, non-finite, or non-numeric serials', () => {
    expect(() => excelSerialToIsoDate(0)).toThrow();
    expect(() => excelSerialToIsoDate(-5)).toThrow();
    expect(() => excelSerialToIsoDate(Number.NaN)).toThrow();
    expect(() => excelSerialToIsoDate(Number.POSITIVE_INFINITY)).toThrow();
  });
});
