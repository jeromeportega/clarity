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

  it('only a TRAILING digit run is a store number — a leading or inner one is part of the name', () => {
    expect(normalizeStore('99 RANCH MARKET')).toBe('99 RANCH MARKET');
    expect(normalizeStore('7 ELEVEN')).toBe('7 ELEVEN');
    expect(normalizeStore('365 BY WHOLE FOODS MARKET')).toBe('365 BY WHOLE FOODS MARKET');
    expect(normalizeStore('99 CENTS ONLY')).toBe('99 CENTS ONLY');
    expect(normalizeStore('TARGET T-2101 0482')).toBe('TARGET T-2101');
    // Two different retailers never share a key.
    expect(normalizeStore('99 RANCH MARKET')).not.toBe(normalizeStore('RANCH MARKET'));
  });

  it('drops punctuation left orphaned by a removed word', () => {
    expect(normalizeStore('COSTCO WHOLESALE - ONLINE ORDER')).toBe('COSTCO ONLINE ORDER');
  });

  it('folds typographic apostrophes onto the ASCII one', () => {
    expect(normalizeStore('SAM’S CLUB')).toBe("SAM'S CLUB");
    expect(normalizeStore("Trader Joe‘s")).toBe("TRADER JOE'S");
    expect(normalizeSkuOrAbbrev('KIRKLAND’S')).toBe("KIRKLAND'S");
  });

  it('never collapses a name to an empty key', () => {
    expect(normalizeStore('WHOLESALE')).toBe('WHOLESALE');
    expect(normalizeStore('#1234')).toBe('#1234');
    expect(normalizeStore('1234')).toBe('1234');
    expect(normalizeStore('-')).toBe('-');
  });

  it('canonicalisation is idempotent, including through the all-noise fallback', () => {
    for (const raw of ['Costco Wholesale #1234', 'WHOLESALE', '#1234', '-', 'COSTCO WHOLESALE - ONLINE ORDER', '99 RANCH MARKET 12', 'WHSE 1234', 'COSTCO 1234 -', 'COSTCO WHSE 1234 -', 'SAFEWAY 1234 #']) {
      const once = normalizeStore(raw);
      expect(normalizeStore(once)).toBe(once);
    }
  });

  // Idempotence is load-bearing: the dictionary re-keys rows under the current
  // rule, and a rule that moves a row on a SECOND pass strands it at a key no
  // lookup computes. A fixed list of fixed points cannot catch that; every
  // token combination up to three long over the vocabulary the rule cares
  // about (names, noise words, store numbers, punctuation, apostrophes) must be
  // a fixed point after one pass.
  it('is idempotent over every token combination the rule can see', () => {
    const vocab = ['COSTCO', 'WHSE', 'Wholesale', '#1234', '1234', '0482', '-', '&', '99', 'RANCH', 'MARKET', 'INC', "JOE'S", 'SAM’S', 'K', '76'];
    const combos: string[] = [];
    for (const a of vocab) {
      combos.push(a);
      for (const b of vocab) {
        combos.push(`${a} ${b}`);
        for (const c of vocab) combos.push(`${a} ${b} ${c}`);
      }
    }
    const failures: string[] = [];
    for (const raw of combos) {
      const once = normalizeStore(raw);
      if (normalizeStore(once) !== once) failures.push(`${JSON.stringify(raw)} → ${JSON.stringify(once)} → ${JSON.stringify(normalizeStore(once))}`);
      const key = normalizeSkuOrAbbrev(raw);
      if (normalizeSkuOrAbbrev(key) !== key) failures.push(`sku ${JSON.stringify(raw)}`);
    }
    expect(combos.length).toBeGreaterThan(4000);
    expect(failures).toEqual([]);
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

  it('treats Costco’s * emphasis markers as separators so a digital line and its photo agree', () => {
    expect(normalizeSkuOrAbbrev('***BOUNTY***')).toBe('BOUNTY');
    expect(normalizeSkuOrAbbrev('***BOUNTY*** 669SF TALL PACK')).toBe('BOUNTY 669SF TALL PACK');
    expect(normalizeSkuOrAbbrev('KS*ORG')).toBe('KS ORG');
    expect(normalizeSkuOrAbbrev('KS-EVOO')).toBe('KS-EVOO');
    expect(normalizeSkuOrAbbrev('1919326')).toBe('1919326');
    expect(normalizeSkuOrAbbrev('***')).toBe('');
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
