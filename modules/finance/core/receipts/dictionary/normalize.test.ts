import { describe, expect, it } from 'vitest';
import { normalizeSkuOrAbbrev, normalizeStore } from './normalize';

describe('normalizeStore', () => {
  it('uppercases, trims, and collapses internal whitespace', () => {
    expect(normalizeStore("  Trader  Joe's ")).toBe("TRADER JOE'S");
  });

  it('maps differently-spaced/cased variants to the same key', () => {
    expect(normalizeStore("  Trader  Joe's ")).toBe(normalizeStore("TRADER JOE'S"));
    expect(normalizeStore('costco')).toBe(normalizeStore('  COSTCO  '));
  });

  it('collapses tabs and newlines, not just spaces', () => {
    expect(normalizeStore('whole\tfoods\nmarket')).toBe('WHOLE FOODS MARKET');
  });

  it('is idempotent (normalizing an already-normalized key is a no-op)', () => {
    const once = normalizeStore("  Trader  Joe's ");
    expect(normalizeStore(once)).toBe(once);
  });

  // One retailer, one key: a digital receipt says WHSE, the photo header says
  // WHOLESALE, a bank line appends the store number. All three must hit the
  // same dictionary row or nothing learned from one path helps the other.
  it('canonicalises a retailer across the ways its name is printed', () => {
    expect(normalizeStore('COSTCO WHSE')).toBe('COSTCO');
    expect(normalizeStore('Costco Wholesale')).toBe('COSTCO');
    expect(normalizeStore('COSTCO WHSE #1234')).toBe('COSTCO');
    expect(normalizeStore('COSTCO WHOLESALE 0482')).toBe('COSTCO');
    expect(normalizeStore('COSTCO')).toBe('COSTCO');
  });

  it('leaves identity-bearing words alone', () => {
    expect(normalizeStore('COSTCO GAS')).toBe('COSTCO GAS');
    expect(normalizeStore('WHOLE FOODS MARKET')).toBe('WHOLE FOODS MARKET');
    expect(normalizeStore("SAM'S CLUB")).toBe("SAM'S CLUB");
    expect(normalizeStore('7-ELEVEN')).toBe('7-ELEVEN');
  });

  it('never collapses a name to an empty key', () => {
    expect(normalizeStore('WHOLESALE')).toBe('WHOLESALE');
    expect(normalizeStore('#1234')).toBe('#1234');
  });

  it('canonicalisation is idempotent', () => {
    const once = normalizeStore('Costco Wholesale #1234');
    expect(normalizeStore(once)).toBe(once);
  });
});

describe('normalizeSkuOrAbbrev', () => {
  it('uppercases, trims, and collapses internal whitespace', () => {
    expect(normalizeSkuOrAbbrev('  ks   org  evoo ')).toBe('KS ORG EVOO');
  });

  it('is idempotent', () => {
    const once = normalizeSkuOrAbbrev('  ks   org  evoo ');
    expect(normalizeSkuOrAbbrev(once)).toBe(once);
  });

  it('drops Costco’s * emphasis markers so a digital line and its photo agree', () => {
    expect(normalizeSkuOrAbbrev('***BOUNTY***')).toBe('BOUNTY');
    expect(normalizeSkuOrAbbrev('***BOUNTY*** 669SF TALL PACK')).toBe('BOUNTY 669SF TALL PACK');
    expect(normalizeSkuOrAbbrev('KS-EVOO')).toBe('KS-EVOO');
    expect(normalizeSkuOrAbbrev('1919326')).toBe('1919326');
  });

  // The caller derives the raw key as `sku ?? description` ("key = SKU when
  // present else abbreviation"), then normalizes it. This asserts that
  // convention end-to-end so a SKU'd item and a null-SKU item key distinctly.
  it('keys on the SKU when present, else on the abbreviation/description', () => {
    const withSku: string | null = 'KS-EVOO';
    const nullSku: string | null = null;
    const description = 'kirkland organic evoo';

    expect(normalizeSkuOrAbbrev(withSku ?? description)).toBe('KS-EVOO');
    expect(normalizeSkuOrAbbrev(nullSku ?? description)).toBe('KIRKLAND ORGANIC EVOO');
  });
});
