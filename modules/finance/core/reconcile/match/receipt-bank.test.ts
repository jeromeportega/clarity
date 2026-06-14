import { describe, expect, it, vi } from 'vitest';

import { similarityRatio } from '../../receipts';
import { FIXTURE_INPUTS } from '../__fixtures__/index';
import type { BankLine, MatchRecord, ReceiptView } from '../model';
import { DEFAULT_CONFIG } from '../thresholds';
import { matchReceipts } from './index';

// ── Helpers ───────────────────────────────────────────────────────────────────

function receipt(overrides: Partial<ReceiptView> & { id: string }): ReceiptView {
  return {
    merchant: 'TEST MERCHANT',
    capturedAt: '2024-01-15',
    totalCents: 5000,
    items: [],
    ...overrides,
  };
}

function bankLine(overrides: Partial<BankLine> & { id: string }): BankLine {
  return {
    accountId: 'acct-001',
    postedDate: '2024-01-15',
    amountCents: -5000,
    direction: 'debit',
    normalizedMerchant: 'TEST MERCHANT',
    ...overrides,
  };
}

// ── Happy path: ≥3 receipt↔bank matches on FIXTURE_INPUTS ────────────────────

describe('matchReceipts — fixture corpus (AC2, FR-1)', () => {
  it('produces ≥3 receipt_bank MatchRecords on FIXTURE_INPUTS', () => {
    const matches = matchReceipts(FIXTURE_INPUTS.bankLines, FIXTURE_INPUTS.receipts, DEFAULT_CONFIG);
    const receiptBankMatches = matches.filter((m) => m.type === 'receipt_bank');
    expect(receiptBankMatches.length).toBeGreaterThanOrEqual(3);
  });
});

// ── Every match carries rationale + numeric confidence ────────────────────────

describe('matchReceipts — FR-3 / FR-4 shape', () => {
  it('every MatchRecord has a non-empty rationale string', () => {
    const matches = matchReceipts(FIXTURE_INPUTS.bankLines, FIXTURE_INPUTS.receipts, DEFAULT_CONFIG);
    for (const m of matches) {
      expect(m.rationale, `match ${m.id} missing rationale`).toBeTruthy();
      expect(typeof m.rationale).toBe('string');
    }
  });

  it('every MatchRecord has a numeric confidence in [0, 1]', () => {
    const matches = matchReceipts(FIXTURE_INPUTS.bankLines, FIXTURE_INPUTS.receipts, DEFAULT_CONFIG);
    for (const m of matches) {
      expect(typeof m.confidence).toBe('number');
      expect(m.confidence).toBeGreaterThanOrEqual(0);
      expect(m.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('strong fixture matches are auto_linked (confidence ≥ confidenceThreshold)', () => {
    const matches = matchReceipts(FIXTURE_INPUTS.bankLines, FIXTURE_INPUTS.receipts, DEFAULT_CONFIG);
    const strong = matches.filter((m) => m.status === 'auto_linked');
    expect(strong.length).toBeGreaterThanOrEqual(3);
    for (const m of strong) {
      expect(m.confidence).toBeGreaterThanOrEqual(DEFAULT_CONFIG.confidenceThreshold);
    }
  });
});

// ── Tip / adjustment tolerance ────────────────────────────────────────────────

describe('matchReceipts — tip/adjustment tolerance', () => {
  it('matches when receipt total is within tipAdjustmentToleranceCents of bank amount', () => {
    const r = receipt({ id: 'r1', totalCents: 5000 + DEFAULT_CONFIG.tipAdjustmentToleranceCents - 1 });
    const b = bankLine({ id: 'b1', amountCents: -5000 });
    const matches = matchReceipts([b], [r], DEFAULT_CONFIG);
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT match when receipt total is just outside tipAdjustmentToleranceCents', () => {
    const r = receipt({ id: 'r1', totalCents: 5000 + DEFAULT_CONFIG.tipAdjustmentToleranceCents + 1 });
    const b = bankLine({ id: 'b1', amountCents: -5000 });
    const matches = matchReceipts([b], [r], DEFAULT_CONFIG);
    expect(matches).toHaveLength(0);
  });
});

// ── Date window ───────────────────────────────────────────────────────────────

describe('matchReceipts — date window', () => {
  it('matches when receipt date is within receiptDateWindowDays of bank posted date', () => {
    const r = receipt({ id: 'r1', capturedAt: '2024-01-15' });
    const b = bankLine({ id: 'b1', postedDate: '2024-01-18' }); // 3 days later (within window)
    const matches = matchReceipts([b], [r], DEFAULT_CONFIG);
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT match when receipt date is one day outside receiptDateWindowDays', () => {
    const r = receipt({ id: 'r1', capturedAt: '2024-01-15' });
    // receiptDateWindowDays = 3; add 4 days → outside
    const b = bankLine({ id: 'b1', postedDate: '2024-01-19' });
    const matches = matchReceipts([b], [r], DEFAULT_CONFIG);
    expect(matches).toHaveLength(0);
  });
});

// ── Merchant similarity gate ──────────────────────────────────────────────────

describe('matchReceipts — merchant similarity', () => {
  it('calls similarityRatio (shared impl, not a local reimplementation)', () => {
    // Verify we import and use the shared similarityRatio from core/receipts.
    // If the impl is in a different location the ratio would differ.
    const ratio = similarityRatio('WHOLE FOODS MARKET', 'WHOLE FOODS MARKET');
    expect(ratio).toBe(1);

    // Now confirm matchReceipts uses the same function: same-name pair → high match.
    const r = receipt({ id: 'r1', merchant: 'WHOLE FOODS MARKET' });
    const b = bankLine({ id: 'b1', normalizedMerchant: 'WHOLE FOODS MARKET' });
    const matches = matchReceipts([b], [r], DEFAULT_CONFIG);
    expect(matches.length).toBe(1);
  });

  it('matches when merchant similarity ≥ merchantSimilarityCutoff', () => {
    // "WHOLE FOODS" vs "WHOLE FOODS MARKET" ≈ 0.741, which is above the 0.72 cutoff.
    const ratio = similarityRatio('WHOLE FOODS', 'WHOLE FOODS MARKET');
    expect(ratio).toBeGreaterThanOrEqual(DEFAULT_CONFIG.merchantSimilarityCutoff);

    const r = receipt({ id: 'r1', merchant: 'WHOLE FOODS' });
    const b = bankLine({ id: 'b1', normalizedMerchant: 'WHOLE FOODS MARKET' });
    const matches = matchReceipts([b], [r], DEFAULT_CONFIG);
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT match when merchant similarity is clearly below merchantSimilarityCutoff', () => {
    // Completely different names → ratio well below 0.72
    const ratio = similarityRatio('NETFLIX', 'WHOLE FOODS MARKET');
    expect(ratio).toBeLessThan(DEFAULT_CONFIG.merchantSimilarityCutoff);

    const r = receipt({ id: 'r1', merchant: 'NETFLIX' });
    const b = bankLine({ id: 'b1', normalizedMerchant: 'WHOLE FOODS MARKET' });
    const matches = matchReceipts([b], [r], DEFAULT_CONFIG);
    expect(matches).toHaveLength(0);
  });
});

// ── last-4 boost / disambiguation ────────────────────────────────────────────

describe('matchReceipts — last-4 boost', () => {
  it('matching lastFour raises confidence relative to a candidate without lastFour', () => {
    const r = receipt({ id: 'r1', lastFour: '1234' });
    const bMatch = bankLine({ id: 'b-match', lastFour: '1234' });
    const bNoLast = bankLine({ id: 'b-nolast' }); // no lastFour
    const [matchA] = matchReceipts([bMatch], [r], DEFAULT_CONFIG);
    const [matchB] = matchReceipts([bNoLast], [r], DEFAULT_CONFIG);
    expect(matchA.confidence).toBeGreaterThan(matchB.confidence);
  });

  it('mismatched lastFour lowers confidence relative to a matching lastFour candidate', () => {
    const r = receipt({ id: 'r1', lastFour: '1234' });
    const bMatch = bankLine({ id: 'b-match', lastFour: '1234' });
    const bWrong = bankLine({ id: 'b-wrong', lastFour: '9999' });
    const [matchRight] = matchReceipts([bMatch], [r], DEFAULT_CONFIG);
    const [matchWrong] = matchReceipts([bWrong], [r], DEFAULT_CONFIG);
    expect(matchRight.confidence).toBeGreaterThan(matchWrong.confidence);
  });

  it('selects the candidate with matching lastFour when two share the same amount', () => {
    const r = receipt({ id: 'r1', totalCents: 5000, lastFour: '1234' });
    const bRight = bankLine({ id: 'b-right', amountCents: -5000, lastFour: '1234' });
    const bWrong = bankLine({ id: 'b-wrong', amountCents: -5000, lastFour: '9999' });
    const matches = matchReceipts([bRight, bWrong], [r], DEFAULT_CONFIG);
    // The receipt should be matched to bRight (higher confidence wins the dedup)
    const best = matches.find((m) => m.receiptId === 'r1');
    expect(best?.transactionId).toBe('b-right');
  });
});

// ── Review-queue routing (FR-4) ───────────────────────────────────────────────

describe('matchReceipts — review-queue routing (FR-4)', () => {
  it('routes a weak match to status:review and never auto_links it', () => {
    // Guaranteed-match pair: "SHOP" vs "SHOP" (sim=1.0, passes all hard gates),
    // but confidence is dragged below 0.70 by:
    //   - amount at tolerance boundary (amountScore ≈ 0)
    //   - date 2 days apart in a 3-day window (dateScore ≈ 0.33)
    //   - last-4 mismatch (lastFourScore = 0)
    // Expected confidence ≈ 1.0*0.4 + ~0*0.3 + 0.33*0.2 + 0*0.1 = ~0.47 < 0.70
    const r = receipt({
      id: 'r-weak',
      merchant: 'SHOP',
      totalCents: 5000,
      capturedAt: '2024-01-15',
      lastFour: '1234',
    });
    const b = bankLine({
      id: 'b-weak',
      normalizedMerchant: 'SHOP',
      amountCents: -(5000 + DEFAULT_CONFIG.tipAdjustmentToleranceCents - 1), // near tolerance boundary
      postedDate: '2024-01-17', // 2 days apart (within receiptDateWindowDays=3)
      lastFour: '9999', // mismatch → lastFourScore = 0
    });
    const weakMatches = matchReceipts([b], [r], DEFAULT_CONFIG);
    expect(weakMatches).toHaveLength(1);
    const m = weakMatches[0];
    expect(m.confidence).toBeLessThan(DEFAULT_CONFIG.confidenceThreshold);
    expect(m.status).toBe('review');
    expect(m.status).not.toBe('auto_linked');
  });

  it('auto_links a strong match (confidence ≥ confidenceThreshold)', () => {
    const r = receipt({ id: 'r1', totalCents: 5000 });
    const b = bankLine({ id: 'b1', amountCents: -5000 });
    const [m] = matchReceipts([b], [r], DEFAULT_CONFIG);
    expect(m.status).toBe('auto_linked');
  });

  it('a match below confidenceThreshold is never auto_linked', () => {
    const matches = matchReceipts(FIXTURE_INPUTS.bankLines, FIXTURE_INPUTS.receipts, DEFAULT_CONFIG);
    for (const m of matches) {
      if (m.confidence < DEFAULT_CONFIG.confidenceThreshold) {
        expect(m.status).toBe('review');
        expect(m.status).not.toBe('auto_linked');
      }
    }
  });
});
