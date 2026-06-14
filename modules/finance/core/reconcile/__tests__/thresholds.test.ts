import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../thresholds';

describe('DEFAULT_CONFIG — exact documented defaults (FR-14)', () => {
  it('tipAdjustmentToleranceCents = 1500', () => {
    expect(DEFAULT_CONFIG.tipAdjustmentToleranceCents).toBe(1500);
  });

  it('merchantSimilarityCutoff = 0.72', () => {
    expect(DEFAULT_CONFIG.merchantSimilarityCutoff).toBe(0.72);
  });

  it('receiptDateWindowDays = 3', () => {
    expect(DEFAULT_CONFIG.receiptDateWindowDays).toBe(3);
  });

  it('orderDateWindowDays = 7', () => {
    expect(DEFAULT_CONFIG.orderDateWindowDays).toBe(7);
  });

  it('subsetMaxCandidates = 12', () => {
    expect(DEFAULT_CONFIG.subsetMaxCandidates).toBe(12);
  });

  it('confidenceThreshold = 0.70', () => {
    expect(DEFAULT_CONFIG.confidenceThreshold).toBe(0.70);
  });

  it('recurringAmountToleranceCents = 200', () => {
    expect(DEFAULT_CONFIG.recurringAmountToleranceCents).toBe(200);
  });

  it('recurringCadenceToleranceDays = 3', () => {
    expect(DEFAULT_CONFIG.recurringCadenceToleranceDays).toBe(3);
  });

  it('insightComparisonMonths = 3', () => {
    expect(DEFAULT_CONFIG.insightComparisonMonths).toBe(3);
  });

  it('all nine required keys are present', () => {
    const keys = [
      'tipAdjustmentToleranceCents',
      'merchantSimilarityCutoff',
      'receiptDateWindowDays',
      'orderDateWindowDays',
      'subsetMaxCandidates',
      'confidenceThreshold',
      'recurringAmountToleranceCents',
      'recurringCadenceToleranceDays',
      'insightComparisonMonths',
    ] as const;
    for (const key of keys) {
      expect(DEFAULT_CONFIG).toHaveProperty(key);
    }
  });
});
