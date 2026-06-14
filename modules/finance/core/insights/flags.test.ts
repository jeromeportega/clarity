import { describe, expect, it } from 'vitest';
import type { ClassifiedItem, LedgerEvent, MatchRecord, ReconciledLedger } from '../reconcile/model';
import type { ReconcileConfig } from '../reconcile/thresholds';
import { DEFAULT_CONFIG } from '../reconcile/thresholds';
import { rollupNetSpend } from '../rollups/rollup';
import { deriveInsights } from './flags';
import type { InsightFlag } from './model';

// ── Fixture builders ──────────────────────────────────────────────────────────

function makeItem(
  category: string,
  opts: Partial<Pick<ClassifiedItem, 'source' | 'rationale' | 'itemRef'>> = {},
): ClassifiedItem {
  return {
    itemRef: opts.itemRef ?? {},
    category,
    rationale: opts.rationale ?? `merchant: TEST_MERCHANT; keyword match → ${category}`,
    source: opts.source ?? 'merchant_fallback',
  };
}

function makeBankEvent(opts: {
  id: string;
  signedSpendCents: number;
  occurredOn: string;
  items?: ClassifiedItem[];
  categoryFallback?: string;
}): Extract<LedgerEvent, { fundedBy: 'bank' }> {
  return {
    id: opts.id,
    signedSpendCents: opts.signedSpendCents,
    occurredOn: opts.occurredOn,
    fundedBy: 'bank',
    sources: { transactionId: `tx-${opts.id}` },
    mergedItems: opts.items ?? [],
    ...(opts.categoryFallback ? { categoryFallback: opts.categoryFallback } : {}),
  };
}

function makeLedger(
  events: LedgerEvent[],
  matches: MatchRecord[] = [],
): ReconciledLedger {
  return {
    events,
    matches,
    reviewQueue: [],
    storeCreditDrawdowns: [],
    unmatched: { bankLines: [], orderItems: [], receipts: [] },
    netSpendCents: events.reduce((s, e) => s + e.signedSpendCents, 0),
  };
}

const CFG: ReconcileConfig = { ...DEFAULT_CONFIG, insightComparisonMonths: 3 };

// ── merchant_above_avg helpers ────────────────────────────────────────────────

/**
 * Build events for COSTCO spanning 4 months so the April observation has a
 * valid 3-month prior window (Jan/Feb/Mar) and sits above the average.
 *
 *   Jan: 10 000¢  Feb: 12 000¢  Mar: 8 000¢  → avg 10 000¢
 *   Apr: 20 000¢  → above average (+100 %)
 */
function costcoAboveAvgEvents(): LedgerEvent[] {
  const merchant = 'COSTCO';
  const rationale = `merchant: ${merchant}; keyword match → Groceries`;
  return [
    makeBankEvent({ id: 'c1', signedSpendCents: 10_000, occurredOn: '2024-01-15',
      items: [makeItem('Groceries', { rationale })] }),
    makeBankEvent({ id: 'c2', signedSpendCents: 12_000, occurredOn: '2024-02-10',
      items: [makeItem('Groceries', { rationale })] }),
    makeBankEvent({ id: 'c3', signedSpendCents:  8_000, occurredOn: '2024-03-12',
      items: [makeItem('Groceries', { rationale })] }),
    makeBankEvent({ id: 'c4', signedSpendCents: 20_000, occurredOn: '2024-04-08',
      items: [makeItem('Groceries', { rationale })] }),
  ];
}

/**
 * NETFLIX events: flat $15 each month — spending is in-line with the average,
 * so merchant_above_avg should NOT fire for NETFLIX.
 */
function netflixInlineEvents(): LedgerEvent[] {
  const merchant = 'NETFLIX';
  const rationale = `merchant: ${merchant}; keyword match → Subscriptions`;
  return [
    makeBankEvent({ id: 'n1', signedSpendCents: 1_500, occurredOn: '2024-01-22',
      items: [makeItem('Subscriptions', { rationale })] }),
    makeBankEvent({ id: 'n2', signedSpendCents: 1_500, occurredOn: '2024-02-22',
      items: [makeItem('Subscriptions', { rationale })] }),
    makeBankEvent({ id: 'n3', signedSpendCents: 1_500, occurredOn: '2024-03-22',
      items: [makeItem('Subscriptions', { rationale })] }),
    makeBankEvent({ id: 'n4', signedSpendCents: 1_500, occurredOn: '2024-04-22',
      items: [makeItem('Subscriptions', { rationale })] }),
  ];
}

// ── category_tracking_over helpers ────────────────────────────────────────────

/**
 * Groceries: March = 20 000¢, April = 30 000¢ → tracking over last month.
 * Uses a different merchant name so it doesn't collide with COSTCO above.
 */
function groceryTrackingEvents(): LedgerEvent[] {
  const rationale = 'merchant: WHOLE FOODS; keyword match → Groceries';
  return [
    makeBankEvent({ id: 'g1', signedSpendCents: 20_000, occurredOn: '2024-03-10',
      items: [makeItem('Groceries', { rationale })] }),
    makeBankEvent({ id: 'g2', signedSpendCents: 30_000, occurredOn: '2024-04-10',
      items: [makeItem('Groceries', { rationale })] }),
  ];
}

// ── new_recurring_charge helpers ─────────────────────────────────────────────

/**
 * SPOTIFY: recurring events first detected in Feb (within 3-month window of Apr).
 * Earliest month = 2024-02 ≥ windowStart 2024-02 → new recurring.
 */
function spotifyNewRecurringEvents(): LedgerEvent[] {
  const merchant = 'SPOTIFY';
  const rationale = `merchant: ${merchant}; recurring $9.99/mo (cadence: ~30d) → Subscriptions`;
  return [
    makeBankEvent({ id: 's1', signedSpendCents: 999, occurredOn: '2024-02-05',
      items: [makeItem('Subscriptions', { source: 'recurring', rationale })] }),
    makeBankEvent({ id: 's2', signedSpendCents: 999, occurredOn: '2024-03-05',
      items: [makeItem('Subscriptions', { source: 'recurring', rationale })] }),
    makeBankEvent({ id: 's3', signedSpendCents: 999, occurredOn: '2024-04-05',
      items: [makeItem('Subscriptions', { source: 'recurring', rationale })] }),
  ];
}

// ── Tests: ≥2 flags with number + basis (FR-13) ───────────────────────────────

describe('deriveInsights — ≥2 flags with number + basis (FR-13)', () => {
  const events = [
    ...costcoAboveAvgEvents(),
    ...netflixInlineEvents(),
    ...groceryTrackingEvents(),
  ];
  const ledger = makeLedger(events);
  const rollup = rollupNetSpend(ledger);

  it('returns ≥2 InsightFlags on the 3-month fixture', () => {
    const flags = deriveInsights(rollup, ledger, CFG);
    expect(flags.length).toBeGreaterThanOrEqual(2);
  });

  it('every flag has a populated number block', () => {
    const flags = deriveInsights(rollup, ledger, CFG);
    for (const flag of flags) {
      expect(flag.amounts.observedCents).toBeGreaterThan(0);
    }
  });

  it('every flag has a non-empty basis string', () => {
    const flags = deriveInsights(rollup, ledger, CFG);
    for (const flag of flags) {
      expect(typeof flag.basis).toBe('string');
      expect(flag.basis.length).toBeGreaterThan(0);
    }
  });
});

// ── Tests: merchant_above_avg ─────────────────────────────────────────────────

describe('deriveInsights — merchant_above_avg', () => {
  it('fires when current-month spend exceeds the 3-month average', () => {
    // COSTCO Apr (20 000) > avg(Jan 10 000, Feb 12 000, Mar 8 000) = 10 000
    const events = costcoAboveAvgEvents();
    const ledger = makeLedger(events);
    const rollup = rollupNetSpend(ledger);

    const flags = deriveInsights(rollup, ledger, CFG);
    const flag = flags.find(
      (f) => f.code === 'merchant_above_avg' && f.basis.includes('COSTCO'),
    );
    expect(flag).toBeDefined();
    expect(flag!.amounts.observedCents).toBe(20_000);
    expect(flag!.amounts.comparisonCents).toBe(10_000);
    expect(flag!.amounts.deltaPct).toBe(100);
    expect(flag!.basis).toMatch(/3-month avg for COSTCO/);
    expect(flag!.inconclusive).toBeUndefined();
  });

  it('does NOT fire when spend is in-line with the average', () => {
    // NETFLIX $15/month every month — flat spend, no flag
    const events = netflixInlineEvents();
    const ledger = makeLedger(events);
    const rollup = rollupNetSpend(ledger);

    const flags = deriveInsights(rollup, ledger, CFG);
    const netflixFlag = flags.find(
      (f) => f.code === 'merchant_above_avg' && f.basis.includes('NETFLIX'),
    );
    expect(netflixFlag).toBeUndefined();
  });

  it('correctly computes deltaPct for above-average spend', () => {
    // COSTCO: avg = 10 000, observed = 20 000 → deltaPct = 100
    const events = costcoAboveAvgEvents();
    const ledger = makeLedger(events);
    const rollup = rollupNetSpend(ledger);

    const flags = deriveInsights(rollup, ledger, CFG);
    const flag = flags.find(
      (f) => f.code === 'merchant_above_avg' && f.basis.includes('COSTCO'),
    )!;
    expect(flag.amounts.deltaPct).toBe(
      Math.round(((20_000 - 10_000) / 10_000) * 100),
    );
  });
});

// ── Tests: category_tracking_over ────────────────────────────────────────────

describe('deriveInsights — category_tracking_over', () => {
  it('fires when current month category spend exceeds the prior month', () => {
    // Groceries: Mar 20 000 → Apr 30 000 (+50 %)
    const events = groceryTrackingEvents();
    const ledger = makeLedger(events);
    const rollup = rollupNetSpend(ledger);

    const flags = deriveInsights(rollup, ledger, CFG);
    const flag = flags.find(
      (f) => f.code === 'category_tracking_over' && f.basis.includes('Groceries'),
    );
    expect(flag).toBeDefined();
    expect(flag!.amounts.observedCents).toBe(30_000);
    expect(flag!.amounts.comparisonCents).toBe(20_000);
    expect(flag!.amounts.deltaPct).toBe(50);
    expect(flag!.basis).toMatch(/prior month \(2024-03\) for Groceries/);
    expect(flag!.inconclusive).toBeUndefined();
  });

  it('does NOT fire when current spend does not exceed the prior month', () => {
    // Groceries declining: Mar 30 000 → Apr 20 000
    const rationale = 'merchant: WHOLE FOODS; keyword match → Groceries';
    const events = [
      makeBankEvent({ id: 'g1', signedSpendCents: 30_000, occurredOn: '2024-03-10',
        items: [makeItem('Groceries', { rationale })] }),
      makeBankEvent({ id: 'g2', signedSpendCents: 20_000, occurredOn: '2024-04-10',
        items: [makeItem('Groceries', { rationale })] }),
    ];
    const ledger = makeLedger(events);
    const rollup = rollupNetSpend(ledger);

    const flags = deriveInsights(rollup, ledger, CFG);
    const flag = flags.find(
      (f) => f.code === 'category_tracking_over' && !f.inconclusive,
    );
    expect(flag).toBeUndefined();
  });

  it('includes basis citing the comparison month', () => {
    const events = groceryTrackingEvents();
    const ledger = makeLedger(events);
    const rollup = rollupNetSpend(ledger);

    const flags = deriveInsights(rollup, ledger, CFG);
    const flag = flags.find((f) => f.code === 'category_tracking_over' && !f.inconclusive)!;
    expect(flag.basis).toContain('2024-03');
    expect(flag.basis).toContain('Groceries');
  });

  it('sparse branch: prior month is net-refund (negative) emits inconclusive, no inverted deltaPct', () => {
    // Dining: Mar net-refund = -5 000¢, Apr spend = 8 000¢
    // Without the guard, currentSpend > priorSpend fires and deltaPct divides by -5000,
    // yielding an inverted percentage. Guard must emit inconclusive instead.
    const rationale = 'merchant: LOCAL BISTRO; keyword match → Dining';
    const events = [
      makeBankEvent({ id: 'd1', signedSpendCents: -5_000, occurredOn: '2024-03-15',
        items: [makeItem('Dining', { rationale })] }),
      makeBankEvent({ id: 'd2', signedSpendCents: 8_000, occurredOn: '2024-04-15',
        items: [makeItem('Dining', { rationale })] }),
    ];
    const ledger = makeLedger(events);
    const rollup = rollupNetSpend(ledger);

    const flags = deriveInsights(rollup, ledger, CFG);
    const flag = flags.find(
      (f) => f.code === 'category_tracking_over' && f.inconclusive === true,
    );
    expect(flag).toBeDefined();
    expect(flag!.basis).toBe('insufficient_history');
    expect(flag!.amounts.observedCents).toBe(8_000);
    expect(flag!.amounts.comparisonCents).toBeUndefined();
    expect(flag!.amounts.deltaPct).toBeUndefined();
  });
});

// ── Tests: new_recurring_charge ───────────────────────────────────────────────

describe('deriveInsights — new_recurring_charge', () => {
  it('fires for a recurring merchant first seen within the comparison window', () => {
    // SPOTIFY first seen Feb 2024; window for Apr 2024 with 3-month cfg = Feb-Apr
    const events = spotifyNewRecurringEvents();
    const ledger = makeLedger(events);
    const rollup = rollupNetSpend(ledger);

    const flags = deriveInsights(rollup, ledger, CFG);
    const flag = flags.find((f) => f.code === 'new_recurring_charge');
    expect(flag).toBeDefined();
    expect(flag!.amounts.observedCents).toBe(999);
    expect(flag!.basis).toMatch(/2024-02/);
    expect(flag!.inconclusive).toBeUndefined();
  });

  it('does NOT fire for a recurring merchant first seen before the window', () => {
    // AMAZON recurring since Jan 2023 — well before the 3-month window for Apr 2024
    const merchant = 'AMAZON';
    const rationale = `merchant: ${merchant}; recurring $12.99/mo (cadence: ~30d) → Subscriptions`;
    const events = [
      makeBankEvent({ id: 'a1', signedSpendCents: 1_299, occurredOn: '2023-01-15',
        items: [makeItem('Subscriptions', { source: 'recurring', rationale })] }),
      makeBankEvent({ id: 'a2', signedSpendCents: 1_299, occurredOn: '2024-03-15',
        items: [makeItem('Subscriptions', { source: 'recurring', rationale })] }),
      makeBankEvent({ id: 'a3', signedSpendCents: 1_299, occurredOn: '2024-04-15',
        items: [makeItem('Subscriptions', { source: 'recurring', rationale })] }),
    ];
    const ledger = makeLedger(events);
    const rollup = rollupNetSpend(ledger);

    const flags = deriveInsights(rollup, ledger, CFG);
    const flag = flags.find((f) => f.code === 'new_recurring_charge');
    expect(flag).toBeUndefined();
  });
});

// ── Tests: in-app only (AC2) ─────────────────────────────────────────────────

describe('deriveInsights — in-app only (AC2)', () => {
  it('returns data only; no outbound side effects', () => {
    // deriveInsights is a pure function: it returns InsightFlag[] and has no
    // imports referencing email, SMS, push, or network.  This test asserts the
    // shape of its return value and that it does not throw.
    const events = [...costcoAboveAvgEvents(), ...groceryTrackingEvents()];
    const ledger = makeLedger(events);
    const rollup = rollupNetSpend(ledger);

    let result: InsightFlag[] | undefined;
    expect(() => {
      result = deriveInsights(rollup, ledger, CFG);
    }).not.toThrow();

    expect(Array.isArray(result)).toBe(true);
    // Each returned object is a plain data bag — no functions or class instances.
    for (const flag of result!) {
      expect(typeof flag).toBe('object');
      expect(typeof flag.code).toBe('string');
      expect(typeof flag.basis).toBe('string');
      expect(typeof flag.amounts).toBe('object');
    }
  });

  it('returns an empty array for an empty ledger (no crash)', () => {
    const result = deriveInsights([], makeLedger([]), CFG);
    expect(result).toEqual([]);
  });
});

// ── Tests: sparse-history policy (AC3, NFR-6, ADR-010) ───────────────────────

describe('deriveInsights — sparse-history policy', () => {
  it('populated branch: merchant with ≥3 prior months emits real comparison numbers', () => {
    // COSTCO has Jan/Feb/Mar as prior months → populated, not inconclusive
    const events = costcoAboveAvgEvents();
    const ledger = makeLedger(events);
    const rollup = rollupNetSpend(ledger);

    const flags = deriveInsights(rollup, ledger, CFG);
    const flag = flags.find(
      (f) => f.code === 'merchant_above_avg' && f.basis.includes('COSTCO'),
    )!;

    expect(flag.inconclusive).toBeUndefined();
    expect(flag.amounts.comparisonCents).toBeDefined();
    expect(flag.amounts.deltaPct).toBeDefined();
  });

  it('sparse branch: merchant with <3 prior months emits inconclusive with basis insufficient_history', () => {
    // WHOLE FOODS only in Feb and Apr → only 1 prior month in the 3-month window
    const rationale = 'merchant: WHOLE FOODS; keyword match → Groceries';
    const events = [
      makeBankEvent({ id: 'wf1', signedSpendCents: 5_000, occurredOn: '2024-02-15',
        items: [makeItem('Groceries', { rationale })] }),
      makeBankEvent({ id: 'wf2', signedSpendCents: 8_000, occurredOn: '2024-04-15',
        items: [makeItem('Groceries', { rationale })] }),
    ];
    const ledger = makeLedger(events);
    const rollup = rollupNetSpend(ledger);

    const flags = deriveInsights(rollup, ledger, CFG);
    const flag = flags.find(
      (f) => f.code === 'merchant_above_avg' && f.inconclusive === true,
    );
    expect(flag).toBeDefined();
    expect(flag!.basis).toBe('insufficient_history');
    // No fabricated average
    expect(flag!.amounts.comparisonCents).toBeUndefined();
    expect(flag!.amounts.deltaPct).toBeUndefined();
    expect(flag!.amounts.observedCents).toBe(8_000);
  });

  it('populated branch: category with prior-month data emits real comparison (not inconclusive)', () => {
    const events = groceryTrackingEvents();
    const ledger = makeLedger(events);
    const rollup = rollupNetSpend(ledger);

    const flags = deriveInsights(rollup, ledger, CFG);
    const flag = flags.find(
      (f) => f.code === 'category_tracking_over' && !f.inconclusive,
    )!;

    expect(flag).toBeDefined();
    expect(flag.inconclusive).toBeUndefined();
    expect(flag.amounts.comparisonCents).toBeDefined();
  });

  it('sparse branch: category with no prior-month data emits inconclusive with basis insufficient_history', () => {
    // Category appears only in the current month → no prior-month data
    const rationale = 'merchant: RANDOM STORE; keyword match → Electronics';
    const events = [
      makeBankEvent({ id: 'e1', signedSpendCents: 50_000, occurredOn: '2024-04-20',
        items: [makeItem('Electronics', { rationale })] }),
    ];
    const ledger = makeLedger(events);
    const rollup = rollupNetSpend(ledger);

    const flags = deriveInsights(rollup, ledger, CFG);
    const flag = flags.find(
      (f) => f.code === 'category_tracking_over' && f.inconclusive === true,
    );
    expect(flag).toBeDefined();
    expect(flag!.basis).toBe('insufficient_history');
    expect(flag!.amounts.comparisonCents).toBeUndefined();
    expect(flag!.amounts.deltaPct).toBeUndefined();
    expect(flag!.amounts.observedCents).toBe(50_000);
  });

  it('sparse branch emits no fabricated average for merchant_above_avg', () => {
    // Only 2 months of merchant history when window requires 3
    const rationale = 'merchant: TARGET; keyword match → Clothing';
    const events = [
      makeBankEvent({ id: 't1', signedSpendCents: 7_000, occurredOn: '2024-03-08',
        items: [makeItem('Clothing', { rationale })] }),
      makeBankEvent({ id: 't2', signedSpendCents: 9_000, occurredOn: '2024-04-08',
        items: [makeItem('Clothing', { rationale })] }),
    ];
    const ledger = makeLedger(events);
    const rollup = rollupNetSpend(ledger);

    const flags = deriveInsights(rollup, ledger, CFG);
    const flag = flags.find(
      (f) => f.code === 'merchant_above_avg' && f.inconclusive === true,
    )!;

    expect(flag).toBeDefined();
    // Must not contain a fabricated comparison value
    expect(flag.amounts.comparisonCents).toBeUndefined();
    expect(flag.amounts.deltaPct).toBeUndefined();
  });

  it('brand-new merchant (0 prior months) does NOT emit an inconclusive flag', () => {
    // A merchant appearing only in the current month with no prior history should be
    // skipped rather than flooding callers with low-signal inconclusive noise.
    const rationale = 'merchant: NEW STORE; keyword match → Misc';
    const events = [
      makeBankEvent({ id: 'ns1', signedSpendCents: 5_000, occurredOn: '2024-04-10',
        items: [makeItem('Misc', { rationale })] }),
    ];
    const ledger = makeLedger(events);
    const rollup = rollupNetSpend(ledger);

    const flags = deriveInsights(rollup, ledger, CFG);
    // No merchant_above_avg inconclusive flag should be emitted for a brand-new merchant.
    const inconclusiveFlag = flags.find(
      (f) => f.code === 'merchant_above_avg' && f.inconclusive === true,
    );
    expect(inconclusiveFlag).toBeUndefined();
  });
});

// ── Tests: insightComparisonMonths configuration ──────────────────────────────

describe('deriveInsights — insightComparisonMonths configuration', () => {
  it('respects a custom insightComparisonMonths=1 (prior 1 month is enough)', () => {
    // With window=1, a merchant needing only 1 prior month is populated
    const cfg1: ReconcileConfig = { ...DEFAULT_CONFIG, insightComparisonMonths: 1 };
    const rationale = 'merchant: TARGET; keyword match → Clothing';
    const events = [
      makeBankEvent({ id: 't1', signedSpendCents: 7_000, occurredOn: '2024-03-08',
        items: [makeItem('Clothing', { rationale })] }),
      makeBankEvent({ id: 't2', signedSpendCents: 14_000, occurredOn: '2024-04-08',
        items: [makeItem('Clothing', { rationale })] }),
    ];
    const ledger = makeLedger(events);
    const rollup = rollupNetSpend(ledger);

    const flags = deriveInsights(rollup, ledger, cfg1);
    const flag = flags.find(
      (f) => f.code === 'merchant_above_avg' && !f.inconclusive,
    );
    expect(flag).toBeDefined();
    expect(flag!.amounts.comparisonCents).toBe(7_000);
    expect(flag!.amounts.deltaPct).toBe(100);
  });
});
