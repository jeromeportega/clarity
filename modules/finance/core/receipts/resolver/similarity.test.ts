import { describe, expect, it } from 'vitest';
import type { Resolution } from './sku-resolver';
import { isCorrectlyResolved, similarityRatio } from './similarity';

describe('similarityRatio (Sørensen–Dice bigram, G-1)', () => {
  it('identical strings score 1', () => {
    expect(similarityRatio('Organic Olive Oil', 'Organic Olive Oil')).toBe(1);
  });

  it('is case- and whitespace-insensitive after normalization', () => {
    expect(similarityRatio('Olive Oil', '  olive   OIL ')).toBe(1);
  });

  it('completely dissimilar strings score near 0', () => {
    expect(similarityRatio('Olive Oil', 'Tube Socks')).toBeLessThan(0.2);
  });

  it('partial overlap lands strictly between 0 and 1', () => {
    const r = similarityRatio('Organic Olive Oil', 'Olive Oil, Organic');
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThanOrEqual(1);
  });

  it('is symmetric', () => {
    const a = 'Kirkland Olive Oil';
    const b = 'Organic Olive Oil';
    expect(similarityRatio(a, b)).toBe(similarityRatio(b, a));
  });

  it('handles empty and single-character edge cases (no bigrams)', () => {
    expect(similarityRatio('', '')).toBe(1);
    expect(similarityRatio('a', 'a')).toBe(1);
    expect(similarityRatio('a', 'b')).toBe(0);
    expect(similarityRatio('', 'abc')).toBe(0);
  });
});

describe('isCorrectlyResolved (G-1)', () => {
  const actual = (overrides: Partial<Resolution> = {}): Resolution => ({
    canonicalName: 'Kirkland Organic Extra Virgin Olive Oil',
    category: 'groceries',
    nameConfidence: 0.9,
    categoryConfidence: 0.9,
    source: 'auto',
    ...overrides,
  });

  it('true when the name is similar enough AND the category matches exactly', () => {
    expect(
      isCorrectlyResolved(
        actual(),
        { name: 'Kirkland Organic Extra Virgin Olive Oil', category: 'groceries' },
        0.85,
      ),
    ).toBe(true);
  });

  it('false when the category differs even if the name matches perfectly', () => {
    expect(
      isCorrectlyResolved(
        actual(),
        { name: 'Kirkland Organic Extra Virgin Olive Oil', category: 'household' },
        0.85,
      ),
    ).toBe(false);
  });

  it('false when the name is below the ratio even if the category matches', () => {
    expect(
      isCorrectlyResolved(actual(), { name: 'Tube Socks Six Pack', category: 'groceries' }, 0.85),
    ).toBe(false);
  });
});
