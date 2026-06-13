import { describe, expect, it } from 'vitest';

import { detectHeader } from './header-detect';

describe('detectHeader', () => {
  it('finds the header when preamble rows sit above it', () => {
    const matrix = [
      ['Account ending 7061'],
      ['Statement period 01/01/2026 - 01/31/2026'],
      [],
      ['Posted Date', 'Reference Number', 'Payee', 'Address', 'Amount'],
      ['01/15/2026', 'REF001', 'COSTCO WHSE #0420', '123 MAIN ST', '-54.99'],
    ];
    const detected = detectHeader(matrix);
    expect(detected).not.toBeNull();
    expect(detected?.headerRowIndex).toBe(3);
    expect(detected?.columns).toMatchObject({
      date: 0,
      reference: 1,
      payee: 2,
      address: 3,
      amount: 4,
    });
  });

  it('detects a header on the first row', () => {
    const matrix = [
      ['Date', 'Description', 'Amount'],
      ['2026-01-15', 'COSTCO', '-54.99'],
    ];
    const detected = detectHeader(matrix);
    expect(detected?.headerRowIndex).toBe(0);
    expect(detected?.columns).toMatchObject({ date: 0, payee: 1, amount: 2 });
  });

  it('matches header labels case-insensitively and ignores punctuation/whitespace', () => {
    const matrix = [['  POSTED DATE ', 'PAYEE', 'Amount ($)'], ['x', 'y', 'z']];
    const detected = detectHeader(matrix);
    expect(detected?.headerRowIndex).toBe(0);
    expect(detected?.columns).toMatchObject({ date: 0, payee: 1, amount: 2 });
  });

  it('returns null when no row carries the required date/amount/payee columns', () => {
    const matrix = [
      ['Account ending 7061'],
      ['Some', 'unrelated', 'columns'],
      ['1', '2', '3'],
    ];
    expect(detectHeader(matrix)).toBeNull();
  });
});
