import { describe, expect, it } from 'vitest';
import type { ClassifiedItem, LedgerEvent, MatchRecord, ReconciledLedger } from '../reconcile/model';
import type { Correction } from './model';
import { applyCorrections, rollupNetSpend } from './rollup';

// ── Fixture builders ──────────────────────────────────────────────────────────

function makeItem(
  category: string,
  itemRef: ClassifiedItem['itemRef'] = {},
): ClassifiedItem {
  return { itemRef, category, rationale: 'test', source: 'item_heuristic' };
}

function makeBankEvent(opts: {
  id: string;
  signedSpendCents: number;
  occurredOn: string;
  txId?: string;
  category?: string;
  itemRef?: ClassifiedItem['itemRef'];
  categoryFallback?: string;
}): Extract<LedgerEvent, { fundedBy: 'bank' }> {
  const mergedItems = opts.category
    ? [makeItem(opts.category, opts.itemRef ?? { receiptItemId: `ri-${opts.id}` })]
    : [];
  return {
    id: opts.id,
    signedSpendCents: opts.signedSpendCents,
    occurredOn: opts.occurredOn,
    fundedBy: 'bank',
    sources: { transactionId: opts.txId ?? `tx-${opts.id}` },
    mergedItems,
    ...(opts.categoryFallback ? { categoryFallback: opts.categoryFallback } : {}),
  };
}

function makeMatch(opts: {
  id: string;
  txId: string;
  status?: 'auto_linked' | 'review';
}): MatchRecord {
  return {
    id: opts.id,
    type: 'receipt_bank',
    transactionId: opts.txId,
    confidence: 0.9,
    rationale: 'test match',
    status: opts.status ?? 'auto_linked',
  };
}

function makeLedger(
  events: LedgerEvent[],
  matches: MatchRecord[] = [],
  reviewQueue: MatchRecord[] = [],
): ReconciledLedger {
  return {
    events,
    matches,
    reviewQueue,
    storeCreditDrawdowns: [],
    unmatched: { bankLines: [], orderItems: [], receipts: [] },
    netSpendCents: events.reduce((s, e) => s + e.signedSpendCents, 0),
  };
}

// ── rollupNetSpend ────────────────────────────────────────────────────────────

describe('rollupNetSpend — basic grouping', () => {
  it('returns empty array for an empty ledger', () => {
    expect(rollupNetSpend(makeLedger([]))).toEqual([]);
  });

  it('creates one cell for a single event', () => {
    const ledger = makeLedger([
      makeBankEvent({ id: 'e1', signedSpendCents: 3000, occurredOn: '2024-03-10', category: 'Groceries' }),
    ]);
    const rollup = rollupNetSpend(ledger);
    expect(rollup).toHaveLength(1);
    expect(rollup[0]).toMatchObject({ category: 'Groceries', month: '2024-03', netSpendCents: 3000 });
    expect(rollup[0].eventIds).toEqual(['e1']);
  });

  it('separates events in different months into distinct cells', () => {
    const ledger = makeLedger([
      makeBankEvent({ id: 'e1', signedSpendCents: 3000, occurredOn: '2024-03-10', category: 'Groceries' }),
      makeBankEvent({ id: 'e2', signedSpendCents: 1000, occurredOn: '2024-04-05', category: 'Groceries' }),
    ]);
    const rollup = rollupNetSpend(ledger);
    expect(rollup).toHaveLength(2);
    const marchCell = rollup.find((c) => c.month === '2024-03');
    const aprilCell = rollup.find((c) => c.month === '2024-04');
    expect(marchCell?.netSpendCents).toBe(3000);
    expect(aprilCell?.netSpendCents).toBe(1000);
  });

  it('separates events in different categories into distinct cells', () => {
    const ledger = makeLedger([
      makeBankEvent({ id: 'e1', signedSpendCents: 3000, occurredOn: '2024-03-10', category: 'Groceries' }),
      makeBankEvent({ id: 'e2', signedSpendCents: 2000, occurredOn: '2024-03-20', category: 'Dining' }),
    ]);
    const rollup = rollupNetSpend(ledger);
    expect(rollup).toHaveLength(2);
  });

  it('falls back to categoryFallback when mergedItems is empty', () => {
    const ledger = makeLedger([
      makeBankEvent({ id: 'e1', signedSpendCents: 500, occurredOn: '2024-03-01', categoryFallback: 'Utilities' }),
    ]);
    const rollup = rollupNetSpend(ledger);
    expect(rollup[0].category).toBe('Utilities');
  });

  it('uses uncategorized when no category is available', () => {
    const event = makeBankEvent({ id: 'e1', signedSpendCents: 500, occurredOn: '2024-03-01' });
    const ledger = makeLedger([event]);
    const rollup = rollupNetSpend(ledger);
    expect(rollup[0].category).toBe('uncategorized');
  });
});

// ── AC1 / FR-11 / FR-9: Net spend = purchase − refund ────────────────────────

describe('rollupNetSpend — AC1: net spend, not gross (FR-11 / FR-9)', () => {
  it('combines purchase and refund in the same category×month into a net cell', () => {
    const ledger = makeLedger([
      makeBankEvent({ id: 'purchase', signedSpendCents: 5000, occurredOn: '2024-03-05', category: 'Groceries' }),
      makeBankEvent({ id: 'refund',   signedSpendCents: -1500, occurredOn: '2024-03-20', category: 'Groceries' }),
    ]);
    const rollup = rollupNetSpend(ledger);
    expect(rollup).toHaveLength(1);
    expect(rollup[0]).toMatchObject({
      category: 'Groceries',
      month: '2024-03',
      netSpendCents: 3500, // 5000 − 1500 (NET, not 5000 + 1500 = 6500 GROSS)
    });
    expect(rollup[0].eventIds).toHaveLength(2);
  });

  it('refund in different month creates a separate negative cell', () => {
    const ledger = makeLedger([
      makeBankEvent({ id: 'purchase', signedSpendCents: 5000, occurredOn: '2024-03-05', category: 'Groceries' }),
      makeBankEvent({ id: 'refund',   signedSpendCents: -1500, occurredOn: '2024-04-02', category: 'Groceries' }),
    ]);
    const rollup = rollupNetSpend(ledger);
    expect(rollup).toHaveLength(2);
    expect(rollup.find((c) => c.month === '2024-03')?.netSpendCents).toBe(5000);
    expect(rollup.find((c) => c.month === '2024-04')?.netSpendCents).toBe(-1500);
  });
});

// ── AC2: Traceability and consistency ────────────────────────────────────────

describe('rollupNetSpend — AC2: traceability and consistency with events', () => {
  const events: LedgerEvent[] = [
    makeBankEvent({ id: 'e1', signedSpendCents: 4000, occurredOn: '2024-03-01', category: 'Groceries' }),
    makeBankEvent({ id: 'e2', signedSpendCents: -800,  occurredOn: '2024-03-15', category: 'Groceries' }),
    makeBankEvent({ id: 'e3', signedSpendCents: 2500, occurredOn: '2024-03-20', category: 'Dining' }),
    makeBankEvent({ id: 'e4', signedSpendCents: 1200, occurredOn: '2024-04-05', category: 'Groceries' }),
  ];
  const ledger = makeLedger(events);

  it('each event appears in exactly one cell — no duplicates, no drops', () => {
    const rollup = rollupNetSpend(ledger);
    const allEventIds = rollup.flatMap((c) => c.eventIds);
    expect(new Set(allEventIds).size).toBe(allEventIds.length); // no duplicates
    expect(new Set(allEventIds).size).toBe(events.length);      // none dropped
  });

  it('Σ cell netSpendCents === ledger.netSpendCents', () => {
    const rollup = rollupNetSpend(ledger);
    const rollupTotal = rollup.reduce((sum, c) => sum + c.netSpendCents, 0);
    expect(rollupTotal).toBe(ledger.netSpendCents);
  });

  it('rollup totals reconcile with underlying events per cell', () => {
    const rollup = rollupNetSpend(ledger);
    for (const cell of rollup) {
      const cellEvents = events.filter((e) => cell.eventIds.includes(e.id));
      const expectedTotal = cellEvents.reduce((sum, e) => sum + e.signedSpendCents, 0);
      expect(cell.netSpendCents).toBe(expectedTotal);
    }
  });
});

// ── applyCorrections — purity (ADR-008) ───────────────────────────────────────

describe('applyCorrections — purity (ADR-008)', () => {
  it('returns a new object reference', () => {
    const ledger = makeLedger([
      makeBankEvent({ id: 'e1', signedSpendCents: 3000, occurredOn: '2024-03-01', category: 'Groceries', itemRef: { receiptItemId: 'ri-1' } }),
    ]);
    const correction: Correction = { kind: 'reclassify_item', itemRef: { receiptItemId: 'ri-1' }, newCategory: 'Dining' };
    const result = applyCorrections(ledger, [correction]);
    expect(result).not.toBe(ledger);
  });

  it('does not mutate the input ledger (deep equality after call)', () => {
    const ledger = makeLedger([
      makeBankEvent({ id: 'e1', signedSpendCents: 3000, occurredOn: '2024-03-01', category: 'Groceries', itemRef: { receiptItemId: 'ri-1' } }),
    ]);
    const snapshot = JSON.stringify(ledger);
    applyCorrections(ledger, [
      { kind: 'reclassify_item', itemRef: { receiptItemId: 'ri-1' }, newCategory: 'Dining' },
    ]);
    expect(JSON.stringify(ledger)).toBe(snapshot);
  });

  it('empty corrections list returns a ledger equal to the input', () => {
    const ledger = makeLedger([
      makeBankEvent({ id: 'e1', signedSpendCents: 3000, occurredOn: '2024-03-01', category: 'Groceries' }),
    ]);
    const result = applyCorrections(ledger, []);
    expect(result).toEqual(ledger);
  });
});

// ── AC3 / FR-12: reclassify_item ─────────────────────────────────────────────

describe('applyCorrections — reclassify_item (FR-12, AC3)', () => {
  it('shifts event from old category cell to new category cell in rollup', () => {
    const ledger = makeLedger([
      makeBankEvent({
        id: 'e1',
        signedSpendCents: 4000,
        occurredOn: '2024-03-15',
        category: 'Groceries',
        itemRef: { receiptItemId: 'ri-1' },
      }),
    ]);

    const before = rollupNetSpend(ledger);
    expect(before.find((c) => c.category === 'Groceries')?.netSpendCents).toBe(4000);
    expect(before.find((c) => c.category === 'Dining')).toBeUndefined();

    const corrected = applyCorrections(ledger, [
      { kind: 'reclassify_item', itemRef: { receiptItemId: 'ri-1' }, newCategory: 'Dining' },
    ]);

    const after = rollupNetSpend(corrected);
    expect(after.find((c) => c.category === 'Groceries')).toBeUndefined();
    expect(after.find((c) => c.category === 'Dining')?.netSpendCents).toBe(4000);
    expect(after.find((c) => c.category === 'Dining')?.eventIds).toContain('e1');
  });

  it('reclassifies by orderItemId', () => {
    const event = makeBankEvent({
      id: 'e1',
      signedSpendCents: 2500,
      occurredOn: '2024-03-10',
      category: 'Electronics',
      itemRef: { orderItemId: 'oi-1' },
    });
    const ledger = makeLedger([event]);
    const corrected = applyCorrections(ledger, [
      { kind: 'reclassify_item', itemRef: { orderItemId: 'oi-1' }, newCategory: 'Clothing' },
    ]);
    const after = rollupNetSpend(corrected);
    expect(after[0].category).toBe('Clothing');
  });

  it('does not affect items whose itemRef does not match', () => {
    const ledger = makeLedger([
      makeBankEvent({ id: 'e1', signedSpendCents: 3000, occurredOn: '2024-03-01', category: 'Groceries', itemRef: { receiptItemId: 'ri-1' } }),
      makeBankEvent({ id: 'e2', signedSpendCents: 2000, occurredOn: '2024-03-01', category: 'Groceries', itemRef: { receiptItemId: 'ri-2' } }),
    ]);
    const corrected = applyCorrections(ledger, [
      { kind: 'reclassify_item', itemRef: { receiptItemId: 'ri-1' }, newCategory: 'Dining' },
    ]);
    const after = rollupNetSpend(corrected);
    const diningCell = after.find((c) => c.category === 'Dining');
    const groceriesCell = after.find((c) => c.category === 'Groceries');
    expect(diningCell?.netSpendCents).toBe(3000);  // only e1 moved
    expect(groceriesCell?.netSpendCents).toBe(2000); // e2 stays
  });
});

// ── AC3 / FR-12: reject_match ─────────────────────────────────────────────────

describe('applyCorrections — reject_match (FR-12, AC3)', () => {
  it('removes match and associated event — cell drops', () => {
    const match = makeMatch({ id: 'm-1', txId: 'tx-1' });
    const ledger = makeLedger(
      [makeBankEvent({ id: 'e1', signedSpendCents: 6000, occurredOn: '2024-03-15', category: 'Food', txId: 'tx-1' })],
      [match],
    );

    const before = rollupNetSpend(ledger);
    expect(before[0].netSpendCents).toBe(6000);

    const corrected = applyCorrections(ledger, [{ kind: 'reject_match', matchId: 'm-1' }]);

    expect(corrected.events).toHaveLength(0);
    expect(corrected.matches).toHaveLength(0);
    expect(rollupNetSpend(corrected)).toHaveLength(0);
  });

  it('recomputes netSpendCents after removing event', () => {
    const match = makeMatch({ id: 'm-1', txId: 'tx-1' });
    const ledger = makeLedger(
      [
        makeBankEvent({ id: 'e1', signedSpendCents: 6000, occurredOn: '2024-03-15', category: 'Food', txId: 'tx-1' }),
        makeBankEvent({ id: 'e2', signedSpendCents: 2000, occurredOn: '2024-03-20', category: 'Food', txId: 'tx-2' }),
      ],
      [match],
    );

    const corrected = applyCorrections(ledger, [{ kind: 'reject_match', matchId: 'm-1' }]);
    expect(corrected.netSpendCents).toBe(2000);
    expect(corrected.events).toHaveLength(1);
  });

  it('handles match in reviewQueue', () => {
    const match = makeMatch({ id: 'm-review', txId: 'tx-r', status: 'review' });
    const ledger = makeLedger(
      [makeBankEvent({ id: 'e-r', signedSpendCents: 1000, occurredOn: '2024-03-01', category: 'Food', txId: 'tx-r' })],
      [],
      [match],
    );
    const corrected = applyCorrections(ledger, [{ kind: 'reject_match', matchId: 'm-review' }]);
    expect(corrected.reviewQueue).toHaveLength(0);
    expect(corrected.events).toHaveLength(0);
  });

  it('is a no-op when matchId is not found', () => {
    const ledger = makeLedger([
      makeBankEvent({ id: 'e1', signedSpendCents: 3000, occurredOn: '2024-03-01', category: 'Groceries' }),
    ]);
    const corrected = applyCorrections(ledger, [{ kind: 'reject_match', matchId: 'nonexistent' }]);
    expect(corrected).toEqual(ledger);
  });
});

// ── AC3 / FR-12: relink_match ─────────────────────────────────────────────────

describe('applyCorrections — relink_match (FR-12, AC3)', () => {
  it('swaps event months when both transactions have events — cell moves', () => {
    const match = makeMatch({ id: 'm-1', txId: 'tx-march' });
    const ledger = makeLedger(
      [
        makeBankEvent({ id: 'e-march', signedSpendCents: 5000, occurredOn: '2024-03-15', category: 'Electronics', txId: 'tx-march' }),
        makeBankEvent({ id: 'e-april', signedSpendCents: 3000, occurredOn: '2024-04-10', category: 'Electronics', txId: 'tx-april' }),
      ],
      [match],
    );

    const before = rollupNetSpend(ledger);
    expect(before.find((c) => c.month === '2024-03')?.netSpendCents).toBe(5000);
    expect(before.find((c) => c.month === '2024-04')?.netSpendCents).toBe(3000);

    const corrected = applyCorrections(ledger, [
      { kind: 'relink_match', matchId: 'm-1', newTransactionId: 'tx-april' },
    ]);

    // Events swap their dates: e-march now lives in April, e-april in March
    const after = rollupNetSpend(corrected);
    expect(after.find((c) => c.month === '2024-03')?.netSpendCents).toBe(3000);
    expect(after.find((c) => c.month === '2024-04')?.netSpendCents).toBe(5000);
  });

  it('updates match transactionId to newTransactionId', () => {
    const match = makeMatch({ id: 'm-1', txId: 'tx-old' });
    const ledger = makeLedger(
      [makeBankEvent({ id: 'e1', signedSpendCents: 2000, occurredOn: '2024-03-01', category: 'Food', txId: 'tx-old' })],
      [match],
    );

    const corrected = applyCorrections(ledger, [
      { kind: 'relink_match', matchId: 'm-1', newTransactionId: 'tx-new' },
    ]);

    expect(corrected.matches[0].transactionId).toBe('tx-new');
  });

  it('updates event sources when no target event exists — date unchanged', () => {
    const match = makeMatch({ id: 'm-1', txId: 'tx-old' });
    const ledger = makeLedger(
      [makeBankEvent({ id: 'e1', signedSpendCents: 2000, occurredOn: '2024-03-01', category: 'Food', txId: 'tx-old' })],
      [match],
    );

    const corrected = applyCorrections(ledger, [
      { kind: 'relink_match', matchId: 'm-1', newTransactionId: 'tx-new' },
    ]);

    const updatedEvent = corrected.events.find((e) => e.id === 'e1');
    expect(updatedEvent?.fundedBy === 'bank' && updatedEvent.sources.transactionId).toBe('tx-new');
    // Date unchanged since there was no target event to swap with
    expect(updatedEvent?.occurredOn).toBe('2024-03-01');
  });

  it('handles match in reviewQueue', () => {
    const match = makeMatch({ id: 'm-r', txId: 'tx-old', status: 'review' });
    const ledger = makeLedger(
      [makeBankEvent({ id: 'e1', signedSpendCents: 1000, occurredOn: '2024-03-01', category: 'Misc', txId: 'tx-old' })],
      [],
      [match],
    );
    const corrected = applyCorrections(ledger, [
      { kind: 'relink_match', matchId: 'm-r', newTransactionId: 'tx-new' },
    ]);
    expect(corrected.reviewQueue[0].transactionId).toBe('tx-new');
  });

  it('is a no-op when matchId is not found', () => {
    const ledger = makeLedger([
      makeBankEvent({ id: 'e1', signedSpendCents: 3000, occurredOn: '2024-03-01', category: 'Groceries' }),
    ]);
    const corrected = applyCorrections(ledger, [
      { kind: 'relink_match', matchId: 'nonexistent', newTransactionId: 'tx-new' },
    ]);
    expect(corrected).toEqual(ledger);
  });
});

// ── End-to-end simulated-correction fixture (H4 stand-in) ────────────────────

describe('correction-aware rollup end-to-end (simulated H4 fixture)', () => {
  // This fixture simulates a review-queue correction applied to a fully reconciled
  // ledger, verifying that all three correction kinds work together and produce
  // rollup changes that are exactly accounted for.

  const groceryItem: ClassifiedItem = {
    itemRef: { receiptItemId: 'ri-grocery' },
    category: 'Groceries',
    rationale: 'item heuristic match',
    source: 'item_heuristic',
  };
  const diningItem: ClassifiedItem = {
    itemRef: { receiptItemId: 'ri-dining' },
    category: 'Dining',
    rationale: 'merchant fallback',
    source: 'merchant_fallback',
  };

  const baseLedger: ReconciledLedger = {
    events: [
      {
        id: 'evt-grocery',
        signedSpendCents: 8000,
        occurredOn: '2024-03-05',
        fundedBy: 'bank',
        sources: { transactionId: 'tx-march-grocery' },
        mergedItems: [groceryItem],
      },
      {
        id: 'evt-dining',
        signedSpendCents: 4500,
        occurredOn: '2024-03-18',
        fundedBy: 'bank',
        sources: { transactionId: 'tx-march-dining' },
        mergedItems: [diningItem],
      },
      {
        id: 'evt-april-grocery',
        signedSpendCents: 3200,
        occurredOn: '2024-04-12',
        fundedBy: 'bank',
        sources: { transactionId: 'tx-april-grocery' },
        mergedItems: [{ ...groceryItem, itemRef: { receiptItemId: 'ri-april' } }],
      },
    ],
    matches: [
      makeMatch({ id: 'm-grocery', txId: 'tx-march-grocery' }),
      makeMatch({ id: 'm-dining', txId: 'tx-march-dining' }),
      makeMatch({ id: 'm-april', txId: 'tx-april-grocery' }),
    ],
    reviewQueue: [],
    storeCreditDrawdowns: [],
    unmatched: { bankLines: [], orderItems: [], receipts: [] },
    netSpendCents: 8000 + 4500 + 3200,
  };

  it('before corrections: baseline rollup is correct', () => {
    const rollup = rollupNetSpend(baseLedger);
    const march = rollup.filter((c) => c.month === '2024-03');
    const april = rollup.filter((c) => c.month === '2024-04');
    expect(march.find((c) => c.category === 'Groceries')?.netSpendCents).toBe(8000);
    expect(march.find((c) => c.category === 'Dining')?.netSpendCents).toBe(4500);
    expect(april.find((c) => c.category === 'Groceries')?.netSpendCents).toBe(3200);
  });

  it('reclassify_item: Groceries → Electronics shifts only that event (AC3)', () => {
    const corrected = applyCorrections(baseLedger, [
      { kind: 'reclassify_item', itemRef: { receiptItemId: 'ri-grocery' }, newCategory: 'Electronics' },
    ]);
    const after = rollupNetSpend(corrected);
    // March Groceries should be gone, Electronics should have 8000
    expect(after.find((c) => c.month === '2024-03' && c.category === 'Groceries')).toBeUndefined();
    expect(after.find((c) => c.month === '2024-03' && c.category === 'Electronics')?.netSpendCents).toBe(8000);
    // Dining and April Groceries should be unchanged
    expect(after.find((c) => c.month === '2024-03' && c.category === 'Dining')?.netSpendCents).toBe(4500);
    expect(after.find((c) => c.month === '2024-04' && c.category === 'Groceries')?.netSpendCents).toBe(3200);
  });

  it('reject_match: removing dining match drops that cell entirely (AC3)', () => {
    const corrected = applyCorrections(baseLedger, [
      { kind: 'reject_match', matchId: 'm-dining' },
    ]);
    const after = rollupNetSpend(corrected);
    // Dining cell should be gone
    expect(after.find((c) => c.category === 'Dining')).toBeUndefined();
    // Other cells intact
    expect(after.find((c) => c.month === '2024-03' && c.category === 'Groceries')?.netSpendCents).toBe(8000);
    expect(after.find((c) => c.month === '2024-04' && c.category === 'Groceries')?.netSpendCents).toBe(3200);
    // netSpendCents reduced
    expect(corrected.netSpendCents).toBe(8000 + 3200);
  });

  it('relink_match: re-anchoring grocery match to April transaction moves cell (AC3)', () => {
    const corrected = applyCorrections(baseLedger, [
      { kind: 'relink_match', matchId: 'm-grocery', newTransactionId: 'tx-april-grocery' },
    ]);
    const after = rollupNetSpend(corrected);
    // evt-grocery (8000) and evt-april-grocery (3200) swap months:
    //   evt-grocery → April (8000), evt-april-grocery → March (3200)
    expect(after.find((c) => c.month === '2024-03' && c.category === 'Groceries')?.netSpendCents).toBe(3200);
    expect(after.find((c) => c.month === '2024-04' && c.category === 'Groceries')?.netSpendCents).toBe(8000);
    // Dining unaffected
    expect(after.find((c) => c.month === '2024-03' && c.category === 'Dining')?.netSpendCents).toBe(4500);
  });

  it('all three corrections compose correctly — before/after differ exactly as dictated', () => {
    const corrections: Correction[] = [
      { kind: 'reclassify_item', itemRef: { receiptItemId: 'ri-grocery' }, newCategory: 'Household' },
      { kind: 'reject_match', matchId: 'm-dining' },
      { kind: 'relink_match', matchId: 'm-grocery', newTransactionId: 'tx-april-grocery' },
    ];

    const corrected = applyCorrections(baseLedger, corrections);

    // After reclassify: evt-grocery category = Household
    // After reject: evt-dining removed
    // After relink: evt-grocery (Household) and evt-april-grocery swap months
    const after = rollupNetSpend(corrected);

    // March Groceries: 3200 (evt-april-grocery swapped to March, category still Groceries)
    expect(after.find((c) => c.month === '2024-03' && c.category === 'Groceries')?.netSpendCents).toBe(3200);
    // April Household: 8000 (evt-grocery swapped to April, reclassified to Household)
    expect(after.find((c) => c.month === '2024-04' && c.category === 'Household')?.netSpendCents).toBe(8000);
    // Dining: absent (rejected)
    expect(after.find((c) => c.category === 'Dining')).toBeUndefined();
    // Total events: 2 (dining removed)
    expect(corrected.events).toHaveLength(2);
    // netSpendCents: 8000 + 3200 = 11200 (dining 4500 removed)
    expect(corrected.netSpendCents).toBe(11200);

    // Purity: original ledger is unchanged
    expect(baseLedger.events).toHaveLength(3);
    expect(baseLedger.netSpendCents).toBe(15700);
  });
});
