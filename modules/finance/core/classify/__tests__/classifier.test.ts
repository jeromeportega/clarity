import { describe, expect, it } from 'vitest';

import type { BankLine, LedgerEvent } from '../../reconcile/model';
import { DEFAULT_CONFIG } from '../../reconcile/thresholds';
import { FIXTURE_INPUTS } from '../../reconcile/__fixtures__/index';
import { H1_TAXONOMY } from '../taxonomy';
import { HeuristicClassifier, detectRecurring, merchantFallback } from '../classifier';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeBankEvent(
  id: string,
  merchant: string,
  signedSpendCents: number,
  occurredOn: string,
  category = 'Subscriptions',
): LedgerEvent {
  return {
    id,
    signedSpendCents,
    occurredOn,
    fundedBy: 'bank',
    sources: { transactionId: `txn-${id}` },
    mergedItems: [
      {
        itemRef: {},
        category,
        rationale: `merchant: ${merchant}; keyword match: "${merchant}" → ${category}`,
        source: 'item_heuristic',
      },
    ],
  };
}

// ── AC1: Every item classified + rationale ────────────────────────────────────

describe('HeuristicClassifier: every fixture item is classified with a rationale', () => {
  const classifier = new HeuristicClassifier();

  it('classifies every receipt item to a taxonomy category with a non-empty rationale', () => {
    for (const receipt of FIXTURE_INPUTS.receipts) {
      for (const item of receipt.items) {
        const result = classifier.classify(
          {
            merchant: receipt.merchant ?? '',
            description: item.description,
            amountCents: item.amountCents,
          },
          H1_TAXONOMY,
        );
        expect(H1_TAXONOMY).toContain(result.category);
        expect(result.rationale.length).toBeGreaterThan(0);
        expect(result.rationale).not.toContain('\n');
        expect(result.source).toBe('item_heuristic');
      }
    }
  });

  it('classifies every order item to a taxonomy category with a non-empty rationale', () => {
    for (const order of FIXTURE_INPUTS.orders) {
      for (const item of order.items) {
        const result = classifier.classify(
          {
            merchant: 'AMAZON',
            description: item.description,
            amountCents: item.amountCents,
          },
          H1_TAXONOMY,
        );
        expect(H1_TAXONOMY).toContain(result.category);
        expect(result.rationale.length).toBeGreaterThan(0);
        expect(result.rationale).not.toContain('\n');
        expect(result.source).toBe('item_heuristic');
      }
    }
  });

  it('zero items are left unclassified across the full fixture corpus', () => {
    const unclassified: string[] = [];

    for (const receipt of FIXTURE_INPUTS.receipts) {
      for (const item of receipt.items) {
        const result = classifier.classify(
          {
            merchant: receipt.merchant ?? '',
            description: item.description,
            amountCents: item.amountCents,
          },
          H1_TAXONOMY,
        );
        if (!H1_TAXONOMY.includes(result.category as never)) {
          unclassified.push(`receipt-item:${item.id}`);
        }
      }
    }

    for (const order of FIXTURE_INPUTS.orders) {
      for (const item of order.items) {
        const result = classifier.classify(
          {
            merchant: 'AMAZON',
            description: item.description,
            amountCents: item.amountCents,
          },
          H1_TAXONOMY,
        );
        if (!H1_TAXONOMY.includes(result.category as never)) {
          unclassified.push(`order-item:${item.id}`);
        }
      }
    }

    expect(unclassified, `Unclassified items: ${unclassified.join(', ')}`).toHaveLength(0);
  });
});

// ── AC1 specific item assertions ──────────────────────────────────────────────

describe('HeuristicClassifier: known fixture items map to expected categories', () => {
  const classifier = new HeuristicClassifier();

  it.each([
    ['WHOLE FOODS MARKET', 'Organic Groceries', 'Groceries'],
    ['NETFLIX', undefined, 'Subscriptions'],
    ['TARGET', 'Clothing', 'Clothing'],
    ['TARGET', 'Household Supplies', 'Shopping'],
    ['COSTCO', 'Household Supplies', 'Shopping'],
    ['AMAZON', 'Paperback Book', 'Books & Media'],
    ['AMAZON', 'Wireless Headphones', 'Electronics'],
    ['AMAZON', 'USB-C Cable', 'Electronics'],
    ['AMAZON', 'Kindle Case', 'Electronics'],
    ['AMAZON', 'Phone Case', 'Shopping'],
  ])('merchant=%s description=%s → %s', (merchant, description, expected) => {
    const result = classifier.classify(
      { merchant, description, amountCents: 1000 },
      H1_TAXONOMY,
    );
    expect(result.category).toBe(expected);
  });
});

// ── Category clamped to taxonomy ──────────────────────────────────────────────

describe('HeuristicClassifier: category is always clamped to the provided taxonomy', () => {
  const classifier = new HeuristicClassifier();

  it('unknown merchant/description falls back to "Other" (always in taxonomy)', () => {
    const result = classifier.classify(
      { merchant: 'XYZZY WIDGETS INC', description: 'miscellaneous item', amountCents: 999 },
      H1_TAXONOMY,
    );
    expect(H1_TAXONOMY).toContain(result.category);
    expect(result.category).toBe('Other');
  });

  it('returns a taxonomy member even when the supplied taxonomy is a small custom subset', () => {
    const customTaxonomy = ['Food', 'Other'] as const;
    // WHOLE FOODS would normally be "Groceries", but it's not in the custom taxonomy
    const result = classifier.classify(
      { merchant: 'WHOLE FOODS MARKET', description: 'Organic Groceries', amountCents: 4999 },
      customTaxonomy,
    );
    expect(customTaxonomy).toContain(result.category);
  });

  it('always stays within taxonomy regardless of description', () => {
    const result = classifier.classify(
      { merchant: 'SOME MERCHANT', description: 'Quantum Entanglement Device', amountCents: 99999 },
      H1_TAXONOMY,
    );
    expect(H1_TAXONOMY).toContain(result.category);
  });
});

// ── AC2: Recurring detection ──────────────────────────────────────────────────

describe('detectRecurring: detects fixed-amount monthly charges', () => {
  it('clusters two events with the same merchant + amount on a monthly cadence', () => {
    const events: LedgerEvent[] = [
      makeBankEvent('evt-1', 'NETFLIX', 1299, '2024-01-22'),
      makeBankEvent('evt-2', 'NETFLIX', 1299, '2024-02-22'),
    ];
    const result = detectRecurring(events, DEFAULT_CONFIG);

    expect(result.size).toBe(2);
    expect(result.has('evt-1')).toBe(true);
    expect(result.has('evt-2')).toBe(true);

    for (const item of result.values()) {
      expect(H1_TAXONOMY).toContain(item.category);
      expect(item.category).toBe('Subscriptions');
      expect(item.source).toBe('recurring');
      // Rationale must cite merchant + amount + cadence
      expect(item.rationale).toContain('NETFLIX');
      expect(item.rationale).toContain('12.99');
      expect(item.rationale).toMatch(/cadence: ~\d+d/);
    }
  });

  it('handles cadence drift within tolerance (±recurringCadenceToleranceDays)', () => {
    // 29 days apart — within ±3 of 30
    const events: LedgerEvent[] = [
      makeBankEvent('evt-a', 'XFINITY', 7499, '2024-01-05', 'Utilities'),
      makeBankEvent('evt-b', 'XFINITY', 7499, '2024-02-03', 'Utilities'),
    ];
    const result = detectRecurring(events, DEFAULT_CONFIG);

    expect(result.size).toBe(2);
    const item = result.get('evt-a')!;
    expect(item.category).toBe('Utilities');
    expect(item.source).toBe('recurring');
    expect(item.rationale).toContain('XFINITY');
    expect(item.rationale).toContain('74.99');
  });

  it('labels Housing events as Housing (mortgage path)', () => {
    const events: LedgerEvent[] = [
      makeBankEvent('evt-m1', 'FIRST NATIONAL BANK', 150000, '2024-01-01', 'Housing'),
      makeBankEvent('evt-m2', 'FIRST NATIONAL BANK', 150000, '2024-02-01', 'Housing'),
    ];
    const result = detectRecurring(events, DEFAULT_CONFIG);

    expect(result.size).toBe(2);
    expect(result.get('evt-m1')!.category).toBe('Housing');
    expect(result.get('evt-m2')!.category).toBe('Housing');
  });

  it('ignores groups of only one event (not recurring)', () => {
    const events: LedgerEvent[] = [
      makeBankEvent('solo', 'AMAZON', 5000, '2024-01-15'),
    ];
    const result = detectRecurring(events, DEFAULT_CONFIG);
    expect(result.size).toBe(0);
  });

  it('handles empty input without error', () => {
    expect(() => detectRecurring([], DEFAULT_CONFIG)).not.toThrow();
    expect(detectRecurring([], DEFAULT_CONFIG).size).toBe(0);
  });
});

describe('detectRecurring: negative cases — non-stable amounts are NOT clustered', () => {
  it('does not cluster events where amount drifts beyond recurringAmountToleranceCents', () => {
    // DEFAULT_CONFIG.recurringAmountToleranceCents = 200
    // Amounts differ by 300 cents ($3.00) — outside the $2.00 tolerance
    const events: LedgerEvent[] = [
      makeBankEvent('drift-1', 'ACME STREAMING', 1299, '2024-01-15'),
      makeBankEvent('drift-2', 'ACME STREAMING', 1599, '2024-02-15'),
    ];
    const result = detectRecurring(events, DEFAULT_CONFIG);
    expect(result.size).toBe(0);
  });

  it('does not cluster events from different merchants even with same amount and cadence', () => {
    const events: LedgerEvent[] = [
      makeBankEvent('a', 'NETFLIX', 1299, '2024-01-22'),
      makeBankEvent('b', 'SPOTIFY', 1299, '2024-02-22'),
    ];
    const result = detectRecurring(events, DEFAULT_CONFIG);
    expect(result.size).toBe(0);
  });

  it('does not cluster events outside the cadence tolerance (>30 ± recurringCadenceToleranceDays)', () => {
    // 45 days apart — outside ±3 of 30
    const events: LedgerEvent[] = [
      makeBankEvent('c1', 'ACME', 999, '2024-01-01'),
      makeBankEvent('c2', 'ACME', 999, '2024-02-15'),
    ];
    const result = detectRecurring(events, DEFAULT_CONFIG);
    expect(result.size).toBe(0);
  });
});

// ── AC3: Merchant fallback for bank lines with no item data ───────────────────

describe('merchantFallback: classifies bank lines without item data', () => {
  it('returns a ClassifiedItem in the taxonomy with a non-empty rationale', () => {
    const line: BankLine = {
      id: 'bank-unmatched-001',
      accountId: 'acct-001',
      postedDate: '2024-03-15',
      amountCents: -3200,
      direction: 'debit',
      normalizedMerchant: 'COSTCO',
    };
    const result = merchantFallback(line, H1_TAXONOMY);

    expect(H1_TAXONOMY).toContain(result.category);
    expect(result.rationale.length).toBeGreaterThan(0);
    expect(result.rationale).not.toContain('\n');
    expect(result.source).toBe('merchant_fallback');
  });

  it.each([
    ['WHOLE FOODS MARKET', 'Groceries'],
    ['NETFLIX', 'Subscriptions'],
    ['TARGET', 'Shopping'],
    ['COSTCO', 'Shopping'],
  ])('fallback for %s → %s', (normalizedMerchant, expected) => {
    const line: BankLine = {
      id: 'test-line',
      accountId: 'acct-001',
      postedDate: '2024-01-01',
      amountCents: -1000,
      direction: 'debit',
      normalizedMerchant,
    };
    const result = merchantFallback(line, H1_TAXONOMY);
    expect(result.category).toBe(expected);
  });

  it('unknown merchant falls back to "Other" which is always in taxonomy', () => {
    const line: BankLine = {
      id: 'unknown-line',
      accountId: 'acct-001',
      postedDate: '2024-01-01',
      amountCents: -500,
      direction: 'debit',
      normalizedMerchant: 'UNRECOGNIZED MERCHANT XYZ',
    };
    const result = merchantFallback(line, H1_TAXONOMY);
    expect(H1_TAXONOMY).toContain(result.category);
    expect(result.category).toBe('Other');
  });

  it('rationale cites the merchant name', () => {
    const line: BankLine = {
      id: 'fb-line',
      accountId: 'acct-001',
      postedDate: '2024-01-01',
      amountCents: -1299,
      direction: 'debit',
      normalizedMerchant: 'NETFLIX',
    };
    const result = merchantFallback(line, H1_TAXONOMY);
    expect(result.rationale).toContain('NETFLIX');
  });
});

// ── AC4: Deterministic & offline ──────────────────────────────────────────────

describe('gated path: deterministic and offline', () => {
  it('HeuristicClassifier can be constructed without any SDK client or network config', () => {
    expect(() => new HeuristicClassifier()).not.toThrow();
  });

  it('classify is a pure function — same inputs always produce the same outputs', () => {
    const classifier = new HeuristicClassifier();
    const q = { merchant: 'NETFLIX', description: undefined, amountCents: 1299 };
    const r1 = classifier.classify(q, H1_TAXONOMY);
    const r2 = classifier.classify(q, H1_TAXONOMY);
    expect(r1).toEqual(r2);
  });

  it('detectRecurring is a pure function', () => {
    const events: LedgerEvent[] = [
      makeBankEvent('p1', 'NETFLIX', 1299, '2024-01-22'),
      makeBankEvent('p2', 'NETFLIX', 1299, '2024-02-22'),
    ];
    const r1 = detectRecurring(events, DEFAULT_CONFIG);
    const r2 = detectRecurring(events, DEFAULT_CONFIG);
    expect([...r1.entries()]).toEqual([...r2.entries()]);
  });

  it('merchantFallback is a pure function', () => {
    const line: BankLine = {
      id: 'l1',
      accountId: 'acct',
      postedDate: '2024-01-01',
      amountCents: -999,
      direction: 'debit',
      normalizedMerchant: 'TARGET',
    };
    expect(merchantFallback(line, H1_TAXONOMY)).toEqual(
      merchantFallback(line, H1_TAXONOMY),
    );
  });
});
