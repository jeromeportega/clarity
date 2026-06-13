import { describe, expect, it } from 'vitest';
import { DEFAULT_RECEIPT_CONFIG } from './config';

describe('DEFAULT_RECEIPT_CONFIG', () => {
  it('carries the contracted default knobs', () => {
    expect(DEFAULT_RECEIPT_CONFIG).toEqual({
      confidenceThreshold: 0.8,
      arithmeticToleranceCents: 2,
      similarityRatio: 0.85,
    });
  });
});
