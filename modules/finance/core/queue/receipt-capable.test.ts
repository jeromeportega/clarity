import { describe, expect, it } from 'vitest';

import { cleanBankMerchant } from '../adapters/bank/merchant';
import { isWithinAskWindow, receiptCapableMerchant } from './receipt-capable';

describe('receiptCapableMerchant — which charges are worth a receipt', () => {
  it('recognises the chains as banks actually print them', () => {
    const cases: Array<[string, string]> = [
      ['COSTCO WHSE #0420', 'Costco'],
      ["SAM'S CLUB #6231", "Sam's Club"],
      ['WM SUPERCENTER #1234', 'Walmart'],
      ['WAL-MART #2050', 'Walmart'],
      ['TARGET 00021345', 'Target'],
      ['THE HOME DEPOT #4712', 'Home Depot'],
      ["LOWE'S #1102", "Lowe's"],
      ['TRADER JOE S #211', "Trader Joe's"],
      ['WHOLEFDS MKT 10245', 'Whole Foods'],
      ['WALGREENS #5566', 'Walgreens'],
      ['CVS/PHARMACY #08123', 'CVS'],
      ['H-E-B #0455', 'H-E-B'],
    ];
    for (const [raw, expected] of cases) {
      expect(receiptCapableMerchant(cleanBankMerchant(raw)), raw).toBe(expected);
    }
  });

  it('says no to ordinary charges, and does not match inside other words', () => {
    for (const raw of ['SHELL OIL 57442', 'PG&E WEB PAYMENT', 'UBER *TRIP', 'CHIPOTLE 1401', 'TARGETED ADS LLC', 'CVSTORE SUPPLY', 'NETFLIX.COM']) {
      expect(receiptCapableMerchant(cleanBankMerchant(raw)), raw).toBeNull();
    }
  });

  it('learns the stores this household already uploads receipts from, as whole words', () => {
    const learned = ['Corner Market', 'A1', "Joe's Hardware"];
    expect(receiptCapableMerchant(cleanBankMerchant('CORNER MARKET 123'), learned)).toBe('Corner Market');
    expect(receiptCapableMerchant(cleanBankMerchant("JOE'S HARDWARE"), learned)).toBe("Joe's Hardware");
    expect(receiptCapableMerchant(cleanBankMerchant('CORNERMARKET'), learned)).toBeNull();
    expect(receiptCapableMerchant(cleanBankMerchant('A1 TOWING'), learned)).toBeNull(); // too short to be identity
    expect(receiptCapableMerchant('', learned)).toBeNull();
  });

  it('prefers the built-in name over a learned spelling of the same chain', () => {
    expect(receiptCapableMerchant('COSTCO WHSE', ['Costco Wholesale'])).toBe('Costco');
  });
});

describe('isWithinAskWindow', () => {
  const now = new Date('2026-09-19T15:00:00Z');
  it('asks about the last sixty days, not about history', () => {
    expect(isWithinAskWindow('2026-09-19', now)).toBe(true);
    expect(isWithinAskWindow('2026-07-21', now)).toBe(true); // day 60
    expect(isWithinAskWindow('2026-07-20', now)).toBe(false); // day 61
    expect(isWithinAskWindow('2025-02-10', now)).toBe(false);
  });
  it('a date in the future or an unparseable one is not asked about', () => {
    expect(isWithinAskWindow('2026-09-20', now)).toBe(false);
    expect(isWithinAskWindow('not-a-date', now)).toBe(false);
  });
  it('honours a caller-supplied window', () => {
    expect(isWithinAskWindow('2026-09-01', now, 7)).toBe(false);
    expect(isWithinAskWindow('2026-09-15', now, 7)).toBe(true);
  });
});
