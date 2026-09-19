import { describe, expect, it } from 'vitest';

import { cleanBankMerchant } from '../adapters/bank/merchant';
import { compileLearnedStores, isWithinAskWindow, receiptCapableMerchant } from './receipt-capable';

const at = (raw: string, learned: string[] = []) => receiptCapableMerchant(cleanBankMerchant(raw), compileLearnedStores(learned));

describe('receiptCapableMerchant — which charges are worth a receipt', () => {
  it('recognises the chains as banks actually print them', () => {
    const cases: Array<[string, string]> = [
      ['COSTCO WHSE #0420', 'Costco'],
      ["SAM'S CLUB #6231", "Sam's Club"],
      ["BJ'S WHOLESALE CLUB #105", "BJ's"],
      ['WM SUPERCENTER #1234', 'Walmart'],
      ['WAL-MART #2050', 'Walmart'],
      ['TARGET 00021345', 'Target'],
      ['THE HOME DEPOT #4712', 'Home Depot'],
      ["LOWE'S #1102", "Lowe's"],
      ['LOWES FOODS #221', 'Lowes Foods'],
      ['TRADER JOE S #211', "Trader Joe's"],
      ['WHOLEFDS MKT 10245', 'Whole Foods'],
      ['WALGREENS #5566', 'Walgreens'],
      ['CVS/PHARMACY #08123', 'CVS'],
      ['H-E-B #0455', 'H-E-B'],
    ];
    for (const [raw, expected] of cases) expect(at(raw), raw).toBe(expected);
  });

  it('says no to ordinary charges, and does not match inside other words', () => {
    for (const raw of [
      'SHELL OIL 57442', 'PG&E WEB PAYMENT', 'UBER *TRIP', 'CHIPOTLE 1401', 'TARGETED ADS LLC', 'CVSTORE SUPPLY', 'NETFLIX.COM',
      // Plaid sandbox lines
      'United Airlines', 'Uber 063015 SF**POOL**', 'Tectra Inc', 'KFC', 'Madison Bicycle Shop', 'Starbucks', "McDonald's",
      'Touchstone Climbing', 'SparkFun', 'CREDIT CARD 3333 PAYMENT *//', 'INTRST PYMNT',
    ]) {
      expect(at(raw), raw).toBeNull();
    }
  });

  it('never asks about fuel, whoever sells it', () => {
    for (const raw of ['COSTCO GAS #0021', 'SAFEWAY FUEL #123', 'KROGER FUEL CTR 123', 'MEIJER GAS', 'HEB GAS', 'SHELL GAS 123']) {
      expect(at(raw), raw).toBeNull();
    }
  });

  it('a namesake that is not the store is not the store', () => {
    expect(at('BJS RESTAURANT & BREWHOUSE')).toBeNull();
    expect(at('CVS CAREMARK MAIL SVC')).toBeNull();
  });

  it('learns the stores this household uploads receipts from, as receipts and banks really print them', () => {
    const learned = ['Harris Teeter #123', 'Corner Market', "Joe's Hardware", 'HARRIS TEETER STORE 123 RALEIGH NC'];
    expect(at('HARRIS TEETER 0456', learned)).toBe('Harris Teeter');
    expect(at('HARRIS TEETER', learned)).toBe('Harris Teeter');
    expect(at('CORNER MARKET 123', learned)).toBe('Corner Market');
    expect(at("JOE'S HARDWARE", learned)).toBe("Joe's Hardware");
    expect(at('CORNERMARKET', learned)).toBeNull();
    expect(at('CORNER BISTRO', learned)).toBeNull();
    expect(receiptCapableMerchant('', compileLearnedStores(learned))).toBeNull();
  });

  it('a short or generic receipt header never becomes a catch-all', () => {
    const learned = ['Gas', 'Market', 'THE', 'A1', '123', '   ', 'Costco Gas'];
    expect(compileLearnedStores(learned).map((s) => s.key)).toEqual(['MARKET']);
    expect(at('SHELL GAS 123', learned)).toBeNull();
    expect(at('FARMERS MARKET', learned)).toBeNull(); // "MARKET" is not a prefix of "FARMERS MARKET"
    expect(at('A1 TOWING', learned)).toBeNull();
    expect(at('THE CORNER', learned)).toBeNull();
  });

  it('prefers the built-in name over a learned spelling of the same chain, and compiles each key once', () => {
    expect(at('COSTCO WHSE', ['Costco Wholesale', 'COSTCO #482'])).toBe('Costco');
    expect(compileLearnedStores(['Costco Wholesale', 'COSTCO #482'])).toHaveLength(1);
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
  it('a posting dated tomorrow (a bank or household ahead of UTC) counts; further out, or unparseable, does not', () => {
    expect(isWithinAskWindow('2026-09-20', now)).toBe(true);
    expect(isWithinAskWindow('2026-09-21', now)).toBe(false);
    expect(isWithinAskWindow('not-a-date', now)).toBe(false);
  });
  it('honours a caller-supplied window', () => {
    expect(isWithinAskWindow('2026-09-01', now, 7)).toBe(false);
    expect(isWithinAskWindow('2026-09-15', now, 7)).toBe(true);
  });
});
