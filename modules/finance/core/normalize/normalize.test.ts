import { describe, expect, it } from 'vitest';

import { normalizeMerchant, parseAmountToCents, toIsoDate } from './index';

describe('parseAmountToCents', () => {
  it('parses plain numbers and currency-formatted strings to cents', () => {
    expect(parseAmountToCents(12.34)).toBe(1234);
    expect(parseAmountToCents('12.34')).toBe(1234);
    expect(parseAmountToCents('$1,234.56')).toBe(123456);
    expect(parseAmountToCents('0')).toBe(0);
    expect(parseAmountToCents('0.05')).toBe(5);
    expect(parseAmountToCents('.5')).toBe(50);
  });

  it('treats parentheses and leading/trailing minus as negative', () => {
    expect(parseAmountToCents('(12.34)')).toBe(-1234);
    expect(parseAmountToCents('-12.34')).toBe(-1234);
    expect(parseAmountToCents('12.34-')).toBe(-1234);
    expect(parseAmountToCents('-$1,000.00')).toBe(-100000);
  });

  it('rounds to the nearest cent', () => {
    expect(parseAmountToCents('1.999')).toBe(200);
  });

  it('throws on unparseable input rather than guessing', () => {
    expect(() => parseAmountToCents('abc')).toThrow();
    expect(() => parseAmountToCents('')).toThrow();
    expect(() => parseAmountToCents('1.2.3')).toThrow();
    expect(() => parseAmountToCents(Number.NaN)).toThrow();
  });
});

describe('toIsoDate', () => {
  it('passes ISO through and zero-pads, ignoring any trailing time', () => {
    expect(toIsoDate('2026-01-05')).toBe('2026-01-05');
    expect(toIsoDate('2026-1-5')).toBe('2026-01-05');
    expect(toIsoDate('2026-01-05T13:00:00Z')).toBe('2026-01-05');
  });

  it('parses US slash/dash and YYYY/MM/DD', () => {
    expect(toIsoDate('01/05/2026')).toBe('2026-01-05');
    expect(toIsoDate('1/5/2026')).toBe('2026-01-05');
    expect(toIsoDate('1-5-2026')).toBe('2026-01-05');
    expect(toIsoDate('2026/01/05')).toBe('2026-01-05');
  });

  it('parses month-name forms', () => {
    expect(toIsoDate('Jan 5, 2026')).toBe('2026-01-05');
    expect(toIsoDate('January 5 2026')).toBe('2026-01-05');
    expect(toIsoDate('5 Jan 2026')).toBe('2026-01-05');
  });

  it('throws on empty, unparseable, or out-of-range input', () => {
    expect(() => toIsoDate('')).toThrow();
    expect(() => toIsoDate('not a date')).toThrow();
    expect(() => toIsoDate('2026-13-05')).toThrow();
    expect(() => toIsoDate('13/40/2026')).toThrow();
  });
});

describe('normalizeMerchant', () => {
  it('uppercases, flattens punctuation to spaces, and collapses whitespace', () => {
    expect(normalizeMerchant('  Amazon.com*1A2B3   ')).toBe('AMAZON COM 1A2B3');
    expect(normalizeMerchant("Trader Joe's #123")).toBe('TRADER JOE S 123');
    expect(normalizeMerchant('WHOLEFOODS')).toBe('WHOLEFOODS');
  });
});
