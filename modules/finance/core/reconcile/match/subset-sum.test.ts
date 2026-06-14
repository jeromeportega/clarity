import { describe, expect, it } from 'vitest';

import type { BankLine } from '../model';
import { DEFAULT_CONFIG } from '../thresholds';
import { findChargeSubset } from './subset-sum';

function line(id: string, amountCents: number, postedDate = '2024-01-01'): BankLine {
  return { id, accountId: 'test', postedDate, amountCents, direction: 'debit', normalizedMerchant: 'AMAZON' };
}

describe('findChargeSubset', () => {
  it('returns null for empty candidates', () => {
    expect(findChargeSubset([], 1000, DEFAULT_CONFIG)).toBeNull();
  });

  it('returns null when candidates exceed subsetMaxCandidates', () => {
    const lines = Array.from({ length: DEFAULT_CONFIG.subsetMaxCandidates + 1 }, (_, i) =>
      line(`l${i}`, -100),
    );
    expect(findChargeSubset(lines, 100, DEFAULT_CONFIG)).toBeNull();
  });

  it('returns null when no subset sums to target', () => {
    const lines = [line('l1', -300), line('l2', -500)];
    expect(findChargeSubset(lines, 1000, DEFAULT_CONFIG)).toBeNull();
  });

  it('finds a 2-element subset that sums to the target', () => {
    const l1 = line('l1', -899, '2024-03-11');
    const l2 = line('l2', -600, '2024-03-13');
    const result = findChargeSubset([l1, l2], 1499, DEFAULT_CONFIG);
    expect(result).not.toBeNull();
    expect(result!.map((l) => l.id).sort()).toEqual(['l1', 'l2']);
  });

  it('finds a 2-element subset from a larger pool and ignores irrelevant candidates', () => {
    const l1 = line('l1', -1000);
    const l2 = line('l2', -500);
    const l3 = line('l3', -250);
    // 1000 + 500 = 1500 (exact match); l3 is not needed
    const result = findChargeSubset([l1, l2, l3], 1500, DEFAULT_CONFIG);
    expect(result).not.toBeNull();
    expect(result!.map((l) => l.id).sort()).toEqual(['l1', 'l2']);
  });

  it('accepts exactly subsetMaxCandidates without returning null', () => {
    const exact = DEFAULT_CONFIG.subsetMaxCandidates; // 12
    const lines = Array.from({ length: exact }, (_, i) => line(`l${i}`, -100));
    // First two lines sum to 200 — should be found.
    const result = findChargeSubset(lines, 200, DEFAULT_CONFIG);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(2);
  });

  it('returns null (not a partial match) when no exact sum exists', () => {
    const lines = [line('l1', -300), line('l2', -400), line('l3', -600)];
    // 300+400=700, 300+600=900, 400+600=1000 — but target is 1001, so no exact solution exists.
    expect(findChargeSubset(lines, 1001, DEFAULT_CONFIG)).toBeNull();
  });

  it('handles a single-element candidate that equals the target', () => {
    // findChargeSubset allows a 1-element result when only one charge covers the total.
    const l1 = line('l1', -1499);
    const result = findChargeSubset([l1], 1499, DEFAULT_CONFIG);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
    expect(result![0].id).toBe('l1');
  });
});
