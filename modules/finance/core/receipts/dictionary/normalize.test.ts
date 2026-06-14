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
});

describe('normalizeSkuOrAbbrev', () => {
  it('uppercases, trims, and collapses internal whitespace', () => {
    expect(normalizeSkuOrAbbrev('  ks   org  evoo ')).toBe('KS ORG EVOO');
  });

  it('is idempotent', () => {
    const once = normalizeSkuOrAbbrev('  ks   org  evoo ');
    expect(normalizeSkuOrAbbrev(once)).toBe(once);
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
