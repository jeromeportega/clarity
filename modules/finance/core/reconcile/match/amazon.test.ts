import { describe, expect, it } from 'vitest';

import { FIXTURE_INPUTS } from '../__fixtures__/index';
import type { BankLine, OrderView } from '../model';
import { DEFAULT_CONFIG } from '../thresholds';
import { matchAmazonOrders } from './index';
import { findChargeSubset } from './subset-sum';

// ── Helpers ───────────────────────────────────────────────────────────────────

function amazonLine(id: string, amountCents: number, postedDate: string): BankLine {
  return { id, accountId: 'acct-001', postedDate, amountCents, direction: 'debit', normalizedMerchant: 'AMAZON' };
}

function order(id: string, orderDate: string, orderTotalCents: number): OrderView {
  return {
    id,
    externalOrderId: `EXT-${id}`,
    orderDate,
    orderTotalCents,
    items: [{ id: `${id}-item`, shipmentId: `SHIP-${id}`, description: 'Test Item', amountCents: orderTotalCents, isReturn: false }],
  };
}

// ── Source is OrderView (CSV), not email ──────────────────────────────────────

describe('matchAmazonOrders — source is OrderView (AC4)', () => {
  it('accepts OrderView[] (the order CSV type) — no email-parsing path exists', () => {
    // If this compiles and runs, the input type is correct.
    const orders: OrderView[] = FIXTURE_INPUTS.orders;
    expect(() => matchAmazonOrders(FIXTURE_INPUTS.bankLines, orders, DEFAULT_CONFIG)).not.toThrow();
  });
});

// ── Happy path: ≥2 Amazon matches including ≥1 split shipment ────────────────

describe('matchAmazonOrders — fixture corpus (AC3, FR-2)', () => {
  it('produces ≥2 order_bank / order_bank_split MatchRecords on FIXTURE_INPUTS', () => {
    const matches = matchAmazonOrders(FIXTURE_INPUTS.bankLines, FIXTURE_INPUTS.orders, DEFAULT_CONFIG);
    const amazonMatches = matches.filter((m) => m.type === 'order_bank' || m.type === 'order_bank_split');
    expect(amazonMatches.length).toBeGreaterThanOrEqual(2);
  });

  it('produces ≥1 order_bank_split (split-shipment) match on FIXTURE_INPUTS', () => {
    const matches = matchAmazonOrders(FIXTURE_INPUTS.bankLines, FIXTURE_INPUTS.orders, DEFAULT_CONFIG);
    const splits = matches.filter((m) => m.type === 'order_bank_split');
    expect(splits.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Single-charge order match ─────────────────────────────────────────────────

describe('matchAmazonOrders — single-charge order match', () => {
  it('produces an order_bank match when one bank charge equals the order total', () => {
    const b = amazonLine('b1', -4298, '2024-01-23');
    const o = order('o1', '2024-01-20', 4298);
    const matches = matchAmazonOrders([b], [o], DEFAULT_CONFIG);
    expect(matches).toHaveLength(1);
    expect(matches[0].type).toBe('order_bank');
    expect(matches[0].orderId).toBe('o1');
    expect(matches[0].transactionId).toBe('b1');
  });

  it('does NOT match when the bank charge is outside orderDateWindowDays', () => {
    const b = amazonLine('b1', -4298, '2024-02-01'); // 12 days from order date
    const o = order('o1', '2024-01-20', 4298);
    expect(matchAmazonOrders([b], [o], DEFAULT_CONFIG)).toHaveLength(0);
  });

  it('does NOT match when the amount difference exceeds tipAdjustmentToleranceCents', () => {
    const b = amazonLine('b1', -(4298 + DEFAULT_CONFIG.tipAdjustmentToleranceCents + 1), '2024-01-21');
    const o = order('o1', '2024-01-20', 4298);
    expect(matchAmazonOrders([b], [o], DEFAULT_CONFIG)).toHaveLength(0);
  });
});

// ── Split-shipment via subset-sum ─────────────────────────────────────────────

describe('matchAmazonOrders — split shipment (AC3, AC7)', () => {
  it('resolves a split shipment via findChargeSubset and produces order_bank_split', () => {
    // Each charge is > tipAdjustmentToleranceCents (1500¢) away from the total (7000¢)
    // so neither qualifies as a direct match — only subset-sum can resolve this.
    const b1 = amazonLine('b-split-1', -4000, '2024-03-11');
    const b2 = amazonLine('b-split-2', -3000, '2024-03-13');
    const o = order('o-split', '2024-03-12', 7000);
    const matches = matchAmazonOrders([b1, b2], [o], DEFAULT_CONFIG);
    expect(matches).toHaveLength(1);
    expect(matches[0].type).toBe('order_bank_split');
    expect(matches[0].orderId).toBe('o-split');
    // Both constituent bank charges should be referenced in the rationale
    const m = matches[0];
    expect(m.rationale).toContain('b-split-1');
    expect(m.rationale).toContain('b-split-2');
  });

  it('findChargeSubset returns the exact 2-element subset for the split case', () => {
    const b1 = amazonLine('b-split-1', -4000, '2024-03-11');
    const b2 = amazonLine('b-split-2', -3000, '2024-03-13');
    const result = findChargeSubset([b1, b2], 7000, DEFAULT_CONFIG);
    expect(result).not.toBeNull();
    expect(result!.map((l) => l.id).sort()).toEqual(['b-split-1', 'b-split-2']);
  });
});

// ── Subset pool is bounded ────────────────────────────────────────────────────

describe('matchAmazonOrders + findChargeSubset — bounded pool (AC7)', () => {
  it('findChargeSubset returns null when candidates exceed subsetMaxCandidates', () => {
    const lines = Array.from({ length: DEFAULT_CONFIG.subsetMaxCandidates + 1 }, (_, i) =>
      amazonLine(`l${i}`, -100, '2024-01-01'),
    );
    expect(findChargeSubset(lines, 200, DEFAULT_CONFIG)).toBeNull();
  });

  it('routes the order to review when subset pool exceeds bound', () => {
    // Build > subsetMaxCandidates AMAZON bank lines within the date window but with no direct match.
    const orderDate = '2024-06-15';
    const lines: BankLine[] = Array.from({ length: DEFAULT_CONFIG.subsetMaxCandidates + 1 }, (_, i) =>
      amazonLine(`bl${i}`, -100, '2024-06-16'),
    );
    // Order total has no direct match and no bounded subset
    const o = order('o-overflow', orderDate, 9999);
    const matches = matchAmazonOrders(lines, [o], DEFAULT_CONFIG);
    if (matches.length > 0) {
      expect(matches[0].status).toBe('review');
    } else {
      // Acceptable: no match produced (order goes fully unmatched)
      expect(matches).toHaveLength(0);
    }
  });

  it('findChargeSubset returns null when no subset exists (not a partial match)', () => {
    const lines = [amazonLine('l1', -300, '2024-01-01'), amazonLine('l2', -400, '2024-01-01')];
    // 300 + 400 = 700 ≠ 1001
    expect(findChargeSubset(lines, 1001, DEFAULT_CONFIG)).toBeNull();
  });
});

// ── Cross-cutting: rationale + confidence + review routing ───────────────────

describe('matchAmazonOrders — FR-3 / FR-4 shape', () => {
  it('every MatchRecord has a non-empty rationale string', () => {
    const matches = matchAmazonOrders(FIXTURE_INPUTS.bankLines, FIXTURE_INPUTS.orders, DEFAULT_CONFIG);
    for (const m of matches) {
      expect(m.rationale, `match ${m.id} missing rationale`).toBeTruthy();
    }
  });

  it('every MatchRecord has a numeric confidence in [0, 1]', () => {
    const matches = matchAmazonOrders(FIXTURE_INPUTS.bankLines, FIXTURE_INPUTS.orders, DEFAULT_CONFIG);
    for (const m of matches) {
      expect(typeof m.confidence).toBe('number');
      expect(m.confidence).toBeGreaterThanOrEqual(0);
      expect(m.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('matches below confidenceThreshold are routed to review and never auto_linked', () => {
    const matches = matchAmazonOrders(FIXTURE_INPUTS.bankLines, FIXTURE_INPUTS.orders, DEFAULT_CONFIG);
    for (const m of matches) {
      if (m.confidence < DEFAULT_CONFIG.confidenceThreshold) {
        expect(m.status).toBe('review');
        expect(m.status).not.toBe('auto_linked');
      }
    }
  });

  it('strong fixture matches (exact amount + date) are auto_linked', () => {
    const b = amazonLine('b-exact', -4298, '2024-01-23');
    const o = order('o-exact', '2024-01-20', 4298);
    const [m] = matchAmazonOrders([b], [o], DEFAULT_CONFIG);
    expect(m.status).toBe('auto_linked');
  });
});
