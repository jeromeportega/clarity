/**
 * Human decisions are engine inputs: a ConfirmedMatch is honoured over the
 * scorer, and everything it contradicts is dropped.
 */
import { describe, expect, it } from 'vitest';

import { applyHumanDecisions, reconcile } from './engine';
import type { BankLine, MatchRecord, ReceiptView, ReconcileInputs } from './model';
import { DEFAULT_CONFIG } from './thresholds';

function candidate(over: Partial<MatchRecord> & { id: string }): MatchRecord {
  return { type: 'receipt_bank', confidence: 0.8, rationale: 'scored', status: 'auto_linked', ...over };
}

describe('applyHumanDecisions', () => {
  it('promotes the candidate for the confirmed pair to auto_linked at confidence 1', () => {
    const weak = candidate({ id: 'a', transactionId: 't1', receiptId: 'r1', confidence: 0.5, status: 'review' });
    const out = applyHumanDecisions([weak], [{ transactionId: 't1', receiptId: 'r1' }]);
    expect(out).toEqual([
      { ...weak, status: 'auto_linked', confidence: 1, confirmedBy: 'human', rationale: 'scored; confirmed by human' },
    ]);
  });

  it('drops every other candidate for that transaction, and for that receipt', () => {
    const chosen = candidate({ id: 'a', transactionId: 't1', receiptId: 'r1' });
    const otherReceiptSameTxn = candidate({ id: 'b', transactionId: 't1', receiptId: 'r2' });
    const sameReceiptOtherTxn = candidate({ id: 'c', transactionId: 't2', receiptId: 'r1' });
    const unrelated = candidate({ id: 'd', transactionId: 't3', receiptId: 'r3' });

    const out = applyHumanDecisions(
      [otherReceiptSameTxn, sameReceiptOtherTxn, chosen, unrelated],
      [{ transactionId: 't1', receiptId: 'r1' }],
    );

    expect(out.map((m) => m.id)).toEqual(['a', 'd']);
    expect(out[0]!.confirmedBy).toBe('human');
  });

  it('synthesises the link when the scorer no longer proposes the pair', () => {
    const out = applyHumanDecisions([], [{ transactionId: 't1', receiptId: 'r1' }, { transactionId: 't2', orderId: 'o1' }]);
    expect(out).toEqual([
      expect.objectContaining({ id: 'receipt_bank-r1-t1', type: 'receipt_bank', transactionId: 't1', receiptId: 'r1', confidence: 1, status: 'auto_linked', confirmedBy: 'human' }),
      expect.objectContaining({ id: 'order_bank-o1-t2', type: 'order_bank', transactionId: 't2', transactionIds: ['t2'], orderId: 'o1', confidence: 1, status: 'auto_linked', confirmedBy: 'human' }),
    ]);
  });

  it('honours an order decision against a split-shipment candidate that includes the line', () => {
    const split = candidate({ id: 's', type: 'order_bank_split', transactionId: 't1', transactionIds: ['t1', 't2'], orderId: 'o1', confidence: 0.6, status: 'review' });
    const out = applyHumanDecisions([split], [{ transactionId: 't2', orderId: 'o1' }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 's', status: 'auto_linked', confidence: 1, confirmedBy: 'human' });
  });

  it('ignores a decision that names neither a receipt nor an order', () => {
    const c = candidate({ id: 'a', transactionId: 't1', receiptId: 'r1' });
    expect(applyHumanDecisions([c], [{ transactionId: 't1' }])).toEqual([c]);
  });

  it('is a no-op without decisions', () => {
    const c = candidate({ id: 'a', transactionId: 't1', receiptId: 'r1' });
    expect(applyHumanDecisions([c], [])).toEqual([c]);
  });
});

describe('reconcile() with confirmedMatches', () => {
  const bank: BankLine = { id: 't1', accountId: 'a', postedDate: '2025-03-05', amountCents: -3599, direction: 'debit', normalizedMerchant: 'COSTCO' };
  // 1000¢ apart and 3 days apart: every gate passes, confidence 0.55 < 0.70.
  const receipt: ReceiptView = {
    id: 'r1', merchant: 'COSTCO', capturedAt: '2025-03-02', totalCents: 2599,
    items: [{ id: 'i1', description: 'Organic Bananas', amountCents: 2599 }],
  };
  const base: ReconcileInputs = { householdId: 'hh', bankLines: [bank], orders: [], receipts: [receipt], storeCreditAccruals: [] };

  it('without a decision the pair is a review candidate: no event, no category, nothing counted', () => {
    const ledger = reconcile(base, DEFAULT_CONFIG);
    expect(ledger.reviewQueue.map((m) => m.id)).toEqual(['receipt_bank-r1-t1']);
    expect(ledger.matches).toEqual([]);
    expect(ledger.events).toEqual([]);
    expect(ledger.netSpendCents).toBe(0);
  });

  it('with the decision the pair is linked, its items classified, and its dollars counted once', () => {
    const ledger = reconcile({ ...base, confirmedMatches: [{ transactionId: 't1', receiptId: 'r1' }] }, DEFAULT_CONFIG);

    expect(ledger.reviewQueue).toEqual([]);
    expect(ledger.matches).toHaveLength(1);
    expect(ledger.matches[0]).toMatchObject({ id: 'receipt_bank-r1-t1', status: 'auto_linked', confidence: 1, confirmedBy: 'human' });
    expect(ledger.events).toHaveLength(1);
    expect(ledger.events[0]!.mergedItems.map((i) => i.itemRef.receiptItemId)).toEqual(['i1']);
    expect(ledger.events[0]!.mergedItems[0]!.category).not.toBe('uncategorized');
    expect(ledger.netSpendCents).toBe(3599);
    expect(ledger.unmatched).toEqual({ bankLines: [], orderItems: [], receipts: [] });
  });
});
