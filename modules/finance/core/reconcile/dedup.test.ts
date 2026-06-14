import { describe, expect, it } from 'vitest';

import { mergeCounted } from './dedup';
import type { BankLine, MatchRecord, OrderView, ReconcileInputs, ReceiptView, StoreCreditAccrual } from './model';

// ── Fixture builders ──────────────────────────────────────────────────────────

function bankDebit(id: string, amountCents: number, date = '2024-01-15'): BankLine {
  return { id, accountId: 'acct-001', postedDate: date, amountCents: -Math.abs(amountCents), direction: 'debit', normalizedMerchant: 'MERCHANT' };
}

function receipt(id: string, totalCents: number, itemIds: string[]): ReceiptView {
  return {
    id,
    merchant: 'MERCHANT',
    capturedAt: '2024-01-15',
    totalCents,
    items: itemIds.map((iid) => ({ id: iid, amountCents: Math.round(totalCents / itemIds.length) })),
  };
}

function order(id: string, totalCents: number, itemDefs: Array<{ id: string; amountCents: number; description?: string }>): OrderView {
  return {
    id,
    externalOrderId: `EXT-${id}`,
    orderDate: '2024-01-15',
    orderTotalCents: totalCents,
    items: itemDefs.map((i) => ({ ...i, shipmentId: `SHIP-${i.id}`, description: i.description ?? 'Item', isReturn: false })),
  };
}

function inputs(
  bankLines: BankLine[],
  receipts: ReceiptView[],
  orders: OrderView[],
  storeCreditAccruals: StoreCreditAccrual[] = [],
): ReconcileInputs {
  return { householdId: 'test-household', bankLines, orders, receipts, storeCreditAccruals };
}

function receiptBankMatch(id: string, transactionId: string, receiptId: string): MatchRecord {
  return { id, type: 'receipt_bank', transactionId, receiptId, confidence: 0.95, rationale: 'test', status: 'auto_linked' };
}

function orderBankMatch(id: string, transactionId: string, orderId: string): MatchRecord {
  return { id, type: 'order_bank', transactionId, transactionIds: [transactionId], orderId, confidence: 0.95, rationale: 'test', status: 'auto_linked' };
}

function orderBankSplitMatch(id: string, transactionIds: string[], orderId: string): MatchRecord {
  return { id, type: 'order_bank_split', transactionId: transactionIds[0], transactionIds, orderId, confidence: 0.88, rationale: 'split', status: 'auto_linked' };
}

function storeCreditDrawdownMatch(id: string, storeCreditBalanceId: string, orderId: string): MatchRecord {
  return { id, type: 'store_credit_drawdown', storeCreditBalanceId, orderId, confidence: 1.0, rationale: 'store credit drawdown', status: 'auto_linked' };
}

function storeCreditAccrual(id: string, amountCents: number, orderId?: string): StoreCreditAccrual {
  return { id, kind: 'store_credit', amountCents, occurredAt: '2024-01-15', orderId };
}

// ── The keystone: dedup triple (receipt + order + bank → 1 event) ─────────────
//
// This is the product's headline invariant (FR-5/NFR-4). Written first to drive
// the implementation from the outside in.

describe('mergeCounted — dedup triple (keystone, FR-5)', () => {
  it('receipt + order sharing one bank line → exactly one LedgerEvent', () => {
    const bl = bankDebit('B1', 5000);
    const rcpt = receipt('R1', 5000, ['RI1']);
    const ord = order('O1', 5000, [{ id: 'OI1', amountCents: 5000 }]);

    const matches: MatchRecord[] = [
      receiptBankMatch('m1', 'B1', 'R1'),
      orderBankMatch('m2', 'B1', 'O1'),
    ];

    const events = mergeCounted(matches, inputs([bl], [rcpt], [ord]));

    // Exactly ONE event for this bank anchor — no double-count.
    expect(events).toHaveLength(1);
  });

  it('signedSpendCents equals the bank line amount, not receipt+order sum', () => {
    const bl = bankDebit('B1', 5000);
    const rcpt = receipt('R1', 5000, ['RI1']);
    const ord = order('O1', 5000, [{ id: 'OI1', amountCents: 5000 }]);

    const matches: MatchRecord[] = [
      receiptBankMatch('m1', 'B1', 'R1'),
      orderBankMatch('m2', 'B1', 'O1'),
    ];

    const [event] = mergeCounted(matches, inputs([bl], [rcpt], [ord]));

    // Dollar counted once from the bank line, not the sum of receipt+order amounts.
    expect(event.signedSpendCents).toBe(5000);
    expect(event.sources.transactionId).toBe('B1');
  });

  it('mergedItems contains item refs from BOTH receipt and order', () => {
    const bl = bankDebit('B1', 5000);
    const rcpt = receipt('R1', 5000, ['RI1']);
    const ord = order('O1', 5000, [{ id: 'OI1', amountCents: 5000 }]);

    const matches: MatchRecord[] = [
      receiptBankMatch('m1', 'B1', 'R1'),
      orderBankMatch('m2', 'B1', 'O1'),
    ];

    const [event] = mergeCounted(matches, inputs([bl], [rcpt], [ord]));
    const itemRefs = event.mergedItems.map((i) => i.itemRef);

    expect(itemRefs.some((r) => r.receiptItemId === 'RI1')).toBe(true);
    expect(itemRefs.some((r) => r.orderItemId === 'OI1')).toBe(true);
    // Two distinct item refs, not zero and not duplicated.
    expect(event.mergedItems).toHaveLength(2);
  });

  it('Σ mergedItems amounts are NOT added to signedSpendCents (items do not double-count the dollar)', () => {
    // Both receipt and order total 5000¢ — their sum would be 10000¢ if double-counted.
    const bl = bankDebit('B1', 5000);
    const rcpt = receipt('R1', 5000, ['RI1']);
    const ord = order('O1', 5000, [{ id: 'OI1', amountCents: 5000 }]);

    const matches: MatchRecord[] = [
      receiptBankMatch('m1', 'B1', 'R1'),
      orderBankMatch('m2', 'B1', 'O1'),
    ];

    const [event] = mergeCounted(matches, inputs([bl], [rcpt], [ord]));

    // The anchor is the bank line; mergedItems are informational, not summed.
    expect(event.signedSpendCents).toBe(5000);
    expect(event.signedSpendCents).not.toBe(10000);
  });

  it('sources carry both orderId and receiptId from the merged sources', () => {
    const bl = bankDebit('B1', 5000);
    const rcpt = receipt('R1', 5000, ['RI1']);
    const ord = order('O1', 5000, [{ id: 'OI1', amountCents: 5000 }]);

    const matches: MatchRecord[] = [
      receiptBankMatch('m1', 'B1', 'R1'),
      orderBankMatch('m2', 'B1', 'O1'),
    ];

    const [event] = mergeCounted(matches, inputs([bl], [rcpt], [ord]));

    expect(event.sources.transactionId).toBe('B1');
    expect(event.sources.orderId).toBe('O1');
    expect(event.sources.receiptId).toBe('R1');
  });

  it('multiple orders on the same bank anchor: orderId is deterministic regardless of match order', () => {
    // Two orders matched to the same bank line — orderId should be lexicographic min, not first-seen.
    const bl = bankDebit('B1', 5000);
    const o1 = order('O-alpha', 2500, [{ id: 'OI1', amountCents: 2500 }]);
    const o2 = order('O-zeta', 2500, [{ id: 'OI2', amountCents: 2500 }]);

    // Pass matches in reverse lexicographic order to prove we don't just pick the first.
    const matchesZetaFirst: MatchRecord[] = [
      orderBankMatch('m2', 'B1', 'O-zeta'),
      orderBankMatch('m1', 'B1', 'O-alpha'),
    ];
    const matchesAlphaFirst: MatchRecord[] = [
      orderBankMatch('m1', 'B1', 'O-alpha'),
      orderBankMatch('m2', 'B1', 'O-zeta'),
    ];

    const [e1] = mergeCounted(matchesZetaFirst, inputs([bl], [], [o1, o2]));
    const [e2] = mergeCounted(matchesAlphaFirst, inputs([bl], [], [o1, o2]));

    // Both orderings should produce the same primary orderId (lexicographic min).
    expect(e1.sources.orderId).toBe('O-alpha');
    expect(e2.sources.orderId).toBe('O-alpha');
  });

  it('multiple receipts on the same bank anchor: receiptId is deterministic regardless of match order', () => {
    // Two receipts matched to the same bank line — receiptId should be lexicographic min, not first-seen.
    const bl = bankDebit('B1', 5000);
    const r1 = receipt('R-alpha', 5000, ['RI1']);
    const r2 = receipt('R-zeta', 5000, ['RI2']);

    // Pass matches in reverse lexicographic order to prove we don't just pick the first.
    const matchesZetaFirst: MatchRecord[] = [
      receiptBankMatch('m2', 'B1', 'R-zeta'),
      receiptBankMatch('m1', 'B1', 'R-alpha'),
    ];
    const matchesAlphaFirst: MatchRecord[] = [
      receiptBankMatch('m1', 'B1', 'R-alpha'),
      receiptBankMatch('m2', 'B1', 'R-zeta'),
    ];

    const [e1] = mergeCounted(matchesZetaFirst, inputs([bl], [r1, r2], []));
    const [e2] = mergeCounted(matchesAlphaFirst, inputs([bl], [r1, r2], []));

    // Both orderings should produce the same primary receiptId (lexicographic min).
    expect(e1.sources.receiptId).toBe('R-alpha');
    expect(e2.sources.receiptId).toBe('R-alpha');
  });
});

// ── Net-spend property ─────────────────────────────────────────────────────────

describe('mergeCounted — net-spend property (FR-5, FR-9)', () => {
  it('netSpend = Σ counted bank anchors across a multi-purchase fixture', () => {
    // Two independent purchases; no shared anchors.
    const b1 = bankDebit('B1', 3000, '2024-01-10');
    const b2 = bankDebit('B2', 7000, '2024-01-20');
    const r1 = receipt('R1', 3000, ['RI1']);
    const o2 = order('O2', 7000, [{ id: 'OI2', amountCents: 7000 }]);

    const matches: MatchRecord[] = [
      receiptBankMatch('m1', 'B1', 'R1'),
      orderBankMatch('m2', 'B2', 'O2'),
    ];

    const events = mergeCounted(matches, inputs([b1, b2], [r1], [o2]));

    const netSpend = events.reduce((sum, e) => sum + e.signedSpendCents, 0);
    const expectedNetSpend = 3000 + 7000; // one anchor per bank line

    expect(netSpend).toBe(expectedNetSpend);
    expect(events).toHaveLength(2);
  });

  it('triple (receipt + order + bank) contributes bank amount once, not three times', () => {
    const bl = bankDebit('B1', 5000);
    const rcpt = receipt('R1', 5000, ['RI1']);
    const ord = order('O1', 5000, [{ id: 'OI1', amountCents: 5000 }]);

    const matches: MatchRecord[] = [
      receiptBankMatch('m1', 'B1', 'R1'),
      orderBankMatch('m2', 'B1', 'O1'),
    ];

    const events = mergeCounted(matches, inputs([bl], [rcpt], [ord]));
    const netSpend = events.reduce((sum, e) => sum + e.signedSpendCents, 0);

    expect(netSpend).toBe(5000); // not 10000 (receipt+order) or 15000
  });
});

// ── Receipt-only / order-only: no false merge ─────────────────────────────────

describe('mergeCounted — no false merge (single-source matches)', () => {
  it('receipt matched alone yields one event per receipt match', () => {
    const b1 = bankDebit('B1', 3000);
    const b2 = bankDebit('B2', 4000);
    const r1 = receipt('R1', 3000, ['RI1']);
    const r2 = receipt('R2', 4000, ['RI2']);

    const matches: MatchRecord[] = [
      receiptBankMatch('m1', 'B1', 'R1'),
      receiptBankMatch('m2', 'B2', 'R2'),
    ];

    const events = mergeCounted(matches, inputs([b1, b2], [r1, r2], []));

    expect(events).toHaveLength(2);
    const spends = events.map((e) => e.signedSpendCents).sort((a, b) => a - b);
    expect(spends).toEqual([3000, 4000]);
  });

  it('order matched alone yields one event per order match', () => {
    const b1 = bankDebit('B1', 2500);
    const b2 = bankDebit('B2', 6000);
    const o1 = order('O1', 2500, [{ id: 'OI1', amountCents: 2500 }]);
    const o2 = order('O2', 6000, [{ id: 'OI2', amountCents: 6000 }]);

    const matches: MatchRecord[] = [
      orderBankMatch('m1', 'B1', 'O1'),
      orderBankMatch('m2', 'B2', 'O2'),
    ];

    const events = mergeCounted(matches, inputs([b1, b2], [], [o1, o2]));

    expect(events).toHaveLength(2);
    const spends = events.map((e) => e.signedSpendCents).sort((a, b) => a - b);
    expect(spends).toEqual([2500, 6000]);
  });

  it('distinct bank anchors produce distinct events even when order totals match', () => {
    // Two separate $50 purchases; different bank lines → two distinct events.
    const b1 = bankDebit('B1', 5000, '2024-01-10');
    const b2 = bankDebit('B2', 5000, '2024-02-10');
    const o1 = order('O1', 5000, [{ id: 'OI1', amountCents: 5000 }]);
    const o2 = order('O2', 5000, [{ id: 'OI2', amountCents: 5000 }]);

    const matches: MatchRecord[] = [
      orderBankMatch('m1', 'B1', 'O1'),
      orderBankMatch('m2', 'B2', 'O2'),
    ];

    const events = mergeCounted(matches, inputs([b1, b2], [], [o1, o2]));

    expect(events).toHaveLength(2);
    const txIds = events.map((e) => e.sources.transactionId).sort();
    expect(txIds).toEqual(['B1', 'B2']);
  });
});

// ── Anchor precedence (ADR-002) ───────────────────────────────────────────────

describe('mergeCounted — anchor precedence (ADR-002)', () => {
  it('bank line > receipt total: receipt_bank anchors on the bank line amount', () => {
    // Receipt total is 5100¢ (tip adjusted), bank line is 5000¢ — anchor must be bank line.
    const bl = bankDebit('B1', 5000);
    const rcpt = receipt('R1', 5100, ['RI1']); // slightly different (tip)

    const matches: MatchRecord[] = [receiptBankMatch('m1', 'B1', 'R1')];

    const [event] = mergeCounted(matches, inputs([bl], [rcpt], []));

    // Bank line amount, not receipt total.
    expect(event.signedSpendCents).toBe(5000);
    expect(event.fundedBy).toBe('bank');
    expect(event.sources.transactionId).toBe('B1');
  });

  it('store-credit anchor: fully SC-funded purchase (no bank line) anchors on SC ledger row', () => {
    // An order paid entirely with store credit — no bank line match.
    const sc = storeCreditAccrual('SC1', 3000, 'O1');
    const ord = order('O1', 3000, [{ id: 'OI1', amountCents: 3000 }]);

    const matches: MatchRecord[] = [storeCreditDrawdownMatch('m1', 'SC1', 'O1')];

    const events = mergeCounted(matches, inputs([], [], [ord], [sc]));

    expect(events).toHaveLength(1);
    expect(events[0].fundedBy).toBe('store_credit');
    expect(events[0].signedSpendCents).toBe(3000);
    expect(events[0].sources.orderId).toBe('O1');
  });

  it('bank line > store-credit: when a bank line exists, SC match for same order does not create a separate event', () => {
    // Order O1 is paid with a bank line AND has a store-credit match (e.g. partial SC).
    // The bank line anchor takes precedence; only one event should exist.
    const bl = bankDebit('B1', 5000);
    const sc = storeCreditAccrual('SC1', 2000, 'O1');
    const ord = order('O1', 5000, [{ id: 'OI1', amountCents: 5000 }]);

    const matches: MatchRecord[] = [
      orderBankMatch('m1', 'B1', 'O1'),
      storeCreditDrawdownMatch('m2', 'SC1', 'O1'),
    ];

    const events = mergeCounted(matches, inputs([bl], [], [ord], [sc]));

    // Exactly one event total — no duplicate SC event alongside the bank event.
    expect(events).toHaveLength(1);
    const bankEvents = events.filter((e) => e.fundedBy === 'bank');
    expect(bankEvents).toHaveLength(1);
    expect(bankEvents[0].sources.transactionId).toBe('B1');
  });

  it('bank > SC precedence: suppresses SC event even when SC balance has multiple linked orders and the matched order is not first', () => {
    // SC balance linked to both O1 (claimed by bank) and O2 (not claimed).
    // If only the first orderId is checked, O2 could slip through and emit a duplicate.
    const bl = bankDebit('B1', 5000);
    const sc = storeCreditAccrual('SC1', 3000, 'O1');
    const o1 = order('O1', 5000, [{ id: 'OI1', amountCents: 5000 }]);
    const o2 = order('O2', 3000, [{ id: 'OI2', amountCents: 3000 }]);

    // SC balance matches two orders: O2 first (won't be in orderIdsClaimedByBank),
    // then O1 (will be claimed by bank). The SC event should still be suppressed
    // because at least one of its orderIds was claimed by bank.
    const matches: MatchRecord[] = [
      orderBankMatch('m1', 'B1', 'O1'),
      // SC with O2 first, O1 second — triggers via separate match records
      storeCreditDrawdownMatch('m2', 'SC1', 'O2'),
      storeCreditDrawdownMatch('m3', 'SC1', 'O1'),
    ];

    const events = mergeCounted(matches, inputs([bl], [], [o1, o2], [sc]));

    // SC event suppressed because O1 was claimed by bank anchor.
    expect(events).toHaveLength(1);
    expect(events[0].fundedBy).toBe('bank');
  });
});

// ── Split shipment ─────────────────────────────────────────────────────────────

describe('mergeCounted — split-shipment (order_bank_split)', () => {
  it('split shipment produces one event with the summed bank amount', () => {
    const b1 = bankDebit('B1', 4000, '2024-01-10');
    const b2 = bankDebit('B2', 3000, '2024-01-12');
    const ord = order('O1', 7000, [
      { id: 'OI1', amountCents: 4000 },
      { id: 'OI2', amountCents: 3000 },
    ]);

    const matches: MatchRecord[] = [orderBankSplitMatch('m1', ['B1', 'B2'], 'O1')];

    const events = mergeCounted(matches, inputs([b1, b2], [], [ord]));

    expect(events).toHaveLength(1);
    expect(events[0].signedSpendCents).toBe(7000);
    expect(events[0].fundedBy).toBe('bank');
  });

  it('split shipment order items are all preserved in mergedItems', () => {
    const b1 = bankDebit('B1', 4000, '2024-01-10');
    const b2 = bankDebit('B2', 3000, '2024-01-12');
    const ord = order('O1', 7000, [
      { id: 'OI1', amountCents: 4000, description: 'Keyboard' },
      { id: 'OI2', amountCents: 3000, description: 'Desk Mat' },
    ]);

    const matches: MatchRecord[] = [orderBankSplitMatch('m1', ['B1', 'B2'], 'O1')];

    const [event] = mergeCounted(matches, inputs([b1, b2], [], [ord]));

    const orderItemIds = event.mergedItems.map((i) => i.itemRef.orderItemId).filter(Boolean);
    expect(orderItemIds).toContain('OI1');
    expect(orderItemIds).toContain('OI2');
  });

  it('split shipment with a missing constituent bank line produces no event (completeness guard)', () => {
    // B2 is referenced by the match but absent from inputs — a partial set would under-count.
    const b1 = bankDebit('B1', 4000, '2024-01-10');
    // B2 intentionally omitted from inputs
    const ord = order('O1', 7000, [{ id: 'OI1', amountCents: 7000 }]);

    const matches: MatchRecord[] = [orderBankSplitMatch('m1', ['B1', 'B2'], 'O1')];

    const events = mergeCounted(matches, inputs([b1], [], [ord]));

    // Emitting a partial event would silently under-count — correct behavior is no event.
    expect(events).toHaveLength(0);
  });
});

// ── Empty / edge cases ────────────────────────────────────────────────────────

describe('mergeCounted — edge cases', () => {
  it('empty matches → empty events', () => {
    const events = mergeCounted([], inputs([], [], []));
    expect(events).toHaveLength(0);
  });

  it('review-status matches still produce events (dedup is not a confidence gate)', () => {
    // The confidence threshold determines review queue routing, not whether events are built.
    const bl = bankDebit('B1', 5000);
    const rcpt = receipt('R1', 5000, ['RI1']);
    const match: MatchRecord = { id: 'm1', type: 'receipt_bank', transactionId: 'B1', receiptId: 'R1', confidence: 0.5, rationale: 'low confidence', status: 'review' };

    const events = mergeCounted([match], inputs([bl], [rcpt], []));

    expect(events).toHaveLength(1);
    expect(events[0].signedSpendCents).toBe(5000);
  });

  it('return items in an order are excluded from mergedItems', () => {
    const bl = bankDebit('B1', 3000);
    const ord: OrderView = {
      id: 'O1',
      externalOrderId: 'EXT-O1',
      orderDate: '2024-01-15',
      orderTotalCents: 3000,
      items: [
        { id: 'OI1', shipmentId: 'SHIP-1', description: 'Book', amountCents: 3000, isReturn: false },
        { id: 'OI2', shipmentId: 'SHIP-1', description: 'Book (return)', amountCents: -1500, isReturn: true },
      ],
    };

    const matches: MatchRecord[] = [orderBankMatch('m1', 'B1', 'O1')];
    const [event] = mergeCounted(matches, inputs([bl], [], [ord]));

    const orderItemIds = event.mergedItems.map((i) => i.itemRef.orderItemId).filter(Boolean);
    expect(orderItemIds).toContain('OI1');
    expect(orderItemIds).not.toContain('OI2'); // return excluded
  });

  it('dedup_merge match type is not processed (no explicit handler)', () => {
    // dedup_merge has no anchor semantics in mergeCounted — it must be resolved
    // to a standard anchor type by the caller before being passed here.
    const bl = bankDebit('B1', 5000);
    const dedupMatch: MatchRecord = {
      id: 'm1',
      type: 'dedup_merge',
      transactionId: 'B1',
      confidence: 1.0,
      rationale: 'dedup',
      status: 'auto_linked',
    };

    const events = mergeCounted([dedupMatch], inputs([bl], [], []));

    // dedup_merge is not in purchaseTypes — no event should be emitted.
    expect(events).toHaveLength(0);
  });
});
