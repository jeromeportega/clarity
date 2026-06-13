import { describe, expect, it } from 'vitest';

import { cleanBankMerchant } from './merchant';

/**
 * Bank-specific merchant cleanup runs BEFORE the shared normalizer so it can see
 * (and strip) the markers that flag store/branch numbers and reference tails —
 * the shared pass would otherwise flatten `#`/`*` to spaces and keep the digits.
 */
describe('cleanBankMerchant', () => {
  it('strips a trailing store/branch number', () => {
    expect(cleanBankMerchant('COSTCO WHSE #0420')).toBe('COSTCO WHSE');
  });

  it('strips a reference tail introduced by *', () => {
    expect(cleanBankMerchant('AMZN Mktp US*RT4K9')).toBe('AMZN MKTP US');
  });

  it('strips noise then uppercases and collapses whitespace', () => {
    expect(cleanBankMerchant("  Trader Joe's #123  ")).toBe('TRADER JOE S');
  });

  it('leaves a clean merchant untouched (besides uppercasing)', () => {
    expect(cleanBankMerchant('WHOLEFOODS')).toBe('WHOLEFOODS');
    expect(cleanBankMerchant('Whole Foods')).toBe('WHOLE FOODS');
  });
});
