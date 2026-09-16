/**
 * DrizzleReconcileSource — the database → ReconcileInputs port.
 *
 * Seeds two households side by side and asserts that everything the engine
 * receives is the requested household's, shaped and signed exactly as the
 * engine's model expects, in a stable order.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type FinanceDb } from '../../db/client';
import {
  accounts,
  households,
  matches,
  orderItems,
  orders,
  receiptItems,
  receipts,
  storeCreditBalances,
  transactions,
} from '../../db/schema';
import { DrizzleReconcileSource } from './source';

const HH = 'hh-source-a';
const OTHER = 'hh-source-b';

let db: FinanceDb;
let cleanup: () => void;

async function seed(): Promise<void> {
  await db.insert(households).values([
    { id: HH, name: 'A' },
    { id: OTHER, name: 'B' },
  ]);
  await db.insert(accounts).values([
    { id: 'acct-a', householdId: HH, name: 'Checking' },
    { id: 'acct-b', householdId: OTHER, name: 'Checking' },
  ]);
  await db.insert(transactions).values([
    {
      id: 'txn-a-2', accountId: 'acct-a', postedDate: '2025-01-20', amountCents: -4999,
      direction: 'debit', normalizedMerchant: 'BEST BUY', sourceRowHash: 'h2', dedupKey: 'k2',
    },
    {
      id: 'txn-a-1', accountId: 'acct-a', postedDate: '2025-01-15', amountCents: -1200,
      direction: 'debit', normalizedMerchant: 'AMAZON', sourceRowHash: 'h1', dedupKey: 'k1',
    },
    {
      id: 'txn-a-3', accountId: 'acct-a', postedDate: '2025-02-01', amountCents: 800,
      direction: 'credit', normalizedMerchant: 'AMAZON', sourceRowHash: 'h3', dedupKey: 'k3',
    },
    {
      id: 'txn-b-1', accountId: 'acct-b', postedDate: '2025-01-15', amountCents: -1200,
      direction: 'debit', normalizedMerchant: 'AMAZON', sourceRowHash: 'hb', dedupKey: 'kb',
    },
  ]);
  await db.insert(orders).values([
    { id: 'ord-a-1', householdId: HH, source: 'amazon', externalOrderId: 'A-001', orderDate: '2025-01-14', orderTotalCents: 1200 },
    { id: 'ord-a-2', householdId: HH, source: 'amazon', externalOrderId: 'A-002', orderDate: '2025-01-30', orderTotalCents: null },
    { id: 'ord-b-1', householdId: OTHER, source: 'amazon', externalOrderId: 'B-001', orderDate: '2025-01-14', orderTotalCents: 1200 },
  ]);
  await db.insert(orderItems).values([
    { id: 'oi-a-1b', orderId: 'ord-a-1', shipmentId: 'ship-1', itemSeq: 2, description: 'Cable', quantity: 1, amountCents: 700, isReturn: false, sourceRowHash: 'o2' },
    { id: 'oi-a-1a', orderId: 'ord-a-1', shipmentId: 'ship-1', itemSeq: 1, description: 'Apples', quantity: 1, amountCents: 500, isReturn: false, sourceRowHash: 'o1' },
    { id: 'oi-a-2r', orderId: 'ord-a-2', shipmentId: 'ship-2', itemSeq: 1, description: 'Returned Lamp', quantity: 1, amountCents: -800, isReturn: true, refundDestination: 'store_credit', sourceRowHash: 'o3' },
    { id: 'oi-b-1', orderId: 'ord-b-1', shipmentId: 'ship-b', itemSeq: 1, description: 'Theirs', quantity: 1, amountCents: 1200, isReturn: false, sourceRowHash: 'ob' },
  ]);
  await db.insert(receipts).values([
    { id: 'rcpt-a-1', householdId: HH, source: 'photo', store: 'BEST BUY', purchasedAt: '2025-01-20', totalCents: 4999, paymentLast4: '4242' },
    // An unreadable photo persists as a masked placeholder.
    { id: 'rcpt-a-2', householdId: HH, source: 'photo', store: '', purchasedAt: '', totalCents: 0, needsReview: true },
    { id: 'rcpt-b-1', householdId: OTHER, source: 'photo', store: 'BEST BUY', purchasedAt: '2025-01-20', totalCents: 4999 },
  ]);
  await db.insert(receiptItems).values([
    { id: 'ri-a-1b', receiptId: 'rcpt-a-1', lineNo: 2, rawDescription: 'CASE', canonicalName: null, quantity: 1, linePriceCents: 1500, discountCents: 500 },
    { id: 'ri-a-1a', receiptId: 'rcpt-a-1', lineNo: 1, rawDescription: 'HDPHN', canonicalName: 'Wireless Headphones', quantity: 1, linePriceCents: 3999, discountCents: 0 },
    { id: 'ri-b-1', receiptId: 'rcpt-b-1', lineNo: 1, rawDescription: 'THEIRS', quantity: 1, linePriceCents: 4999 },
  ]);
  await db.insert(storeCreditBalances).values([
    { id: 'scb-a-1', householdId: HH, orderItemId: 'oi-a-2r', kind: 'store_credit', amountCents: 800 },
    { id: 'scb-a-2', householdId: HH, orderItemId: null, kind: 'gift_card', amountCents: 2500 },
    { id: 'scb-b-1', householdId: OTHER, orderItemId: 'oi-b-1', kind: 'store_credit', amountCents: 100 },
  ]);
}

describe('DrizzleReconcileSource.load', () => {
  beforeEach(async () => {
    ({ db, cleanup } = createTestDb());
    await seed();
  });
  afterEach(() => cleanup());

  it('returns only the household’s rows, in a stable order', async () => {
    const inputs = await new DrizzleReconcileSource(db).load(HH);

    expect(inputs.householdId).toBe(HH);
    expect(inputs.bankLines.map((b) => b.id)).toEqual(['txn-a-1', 'txn-a-2', 'txn-a-3']);
    expect(inputs.orders.map((o) => o.id)).toEqual(['ord-a-1', 'ord-a-2']);
    expect(inputs.receipts.map((r) => r.id)).toEqual(['rcpt-a-1', 'rcpt-a-2']);
    expect(inputs.storeCreditAccruals.map((a) => a.id)).toEqual(['scb-a-1', 'scb-a-2']);
  });

  it('bank lines keep the schema’s sign convention — the engine performs the one flip', async () => {
    const { bankLines } = await new DrizzleReconcileSource(db).load(HH);
    expect(bankLines[0]).toEqual({
      id: 'txn-a-1', accountId: 'acct-a', postedDate: '2025-01-15', amountCents: -1200,
      direction: 'debit', normalizedMerchant: 'AMAZON',
    });
    expect(bankLines[2]).toMatchObject({ id: 'txn-a-3', amountCents: 800, direction: 'credit' });
  });

  it('orders carry their line items in shipment/sequence order, returns signed negative with their destination', async () => {
    const { orders: views } = await new DrizzleReconcileSource(db).load(HH);
    expect(views[0]).toEqual({
      id: 'ord-a-1', externalOrderId: 'A-001', orderDate: '2025-01-14', orderTotalCents: 1200,
      items: [
        { id: 'oi-a-1a', shipmentId: 'ship-1', description: 'Apples', amountCents: 500, isReturn: false },
        { id: 'oi-a-1b', shipmentId: 'ship-1', description: 'Cable', amountCents: 700, isReturn: false },
      ],
    });
    // No total → the field is absent, not null.
    expect(views[1]).not.toHaveProperty('orderTotalCents');
    expect(views[1]!.items).toEqual([
      { id: 'oi-a-2r', shipmentId: 'ship-2', description: 'Returned Lamp', amountCents: -800, isReturn: true, refundDestination: 'store_credit' },
    ]);
  });

  it('receipts carry merchant, date, total, card and net line amounts; placeholders stay unscorable', async () => {
    const { receipts: views } = await new DrizzleReconcileSource(db).load(HH);
    expect(views[0]).toEqual({
      id: 'rcpt-a-1', merchant: 'BEST BUY', capturedAt: '2025-01-20', totalCents: 4999, lastFour: '4242',
      items: [
        // canonical name when known, raw text otherwise; amount net of the line's discount
        { id: 'ri-a-1a', description: 'Wireless Headphones', amountCents: 3999 },
        { id: 'ri-a-1b', description: 'CASE', amountCents: 1000 },
      ],
    });
    // The unreadable-photo placeholder: no merchant, no date — the matcher
    // must never score it against a bank line.
    expect(views[1]).toEqual({ id: 'rcpt-a-2', totalCents: 0, items: [] });
  });

  it('store-credit accruals are dated by their order when they have one, else by their own creation day', async () => {
    const { storeCreditAccruals } = await new DrizzleReconcileSource(db).load(HH);
    expect(storeCreditAccruals[0]).toEqual({
      id: 'scb-a-1', kind: 'store_credit', amountCents: 800, occurredAt: '2025-01-30',
      orderId: 'ord-a-2', orderItemId: 'oi-a-2r',
    });
    expect(storeCreditAccruals[1]).toMatchObject({ id: 'scb-a-2', kind: 'gift_card', amountCents: 2500 });
    expect(storeCreditAccruals[1]!.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(storeCreditAccruals[1]).not.toHaveProperty('orderId');
  });

  it('loads the humans’ decisions: one manual row per transaction naming its receipt or order, foreign and anchorless rows ignored', async () => {
    await db.insert(matches).values([
      { id: 'm-1', transactionId: 'txn-a-1', receiptId: 'rcpt-a-1', status: 'manual', confidence: 100, method: 'receipt_bank' },
      // Item-level rows from the same decision resolve to the same receipt — one decision per transaction.
      { id: 'm-1b', transactionId: 'txn-a-1', receiptId: 'rcpt-a-1', receiptItemId: 'ri-a-1a', status: 'manual', confidence: 100, method: 'receipt_bank' },
      { id: 'm-2', transactionId: 'txn-a-2', orderId: 'ord-a-1', status: 'manual', confidence: 100, method: 'order_bank' },
      // A decision about nothing identifiable.
      { id: 'm-3', transactionId: 'txn-a-3', status: 'manual', confidence: 100, method: 'receipt_bank' },
      // Not a decision.
      { id: 'm-4', transactionId: 'txn-a-3', receiptId: 'rcpt-a-1', status: 'pending', confidence: 50, method: 'receipt_bank' },
      // Another household's.
      { id: 'm-5', transactionId: 'txn-b-1', receiptId: 'rcpt-b-1', status: 'manual', confidence: 100, method: 'receipt_bank' },
    ]);

    const { confirmedMatches } = await new DrizzleReconcileSource(db).load(HH);

    expect(confirmedMatches).toEqual([
      { transactionId: 'txn-a-1', receiptId: 'rcpt-a-1' },
      { transactionId: 'txn-a-2', orderId: 'ord-a-1' },
    ]);
  });

  it('a household with no data loads as empty inputs, not an error', async () => {
    await db.insert(households).values({ id: 'hh-empty', name: 'Empty' });
    const inputs = await new DrizzleReconcileSource(db).load('hh-empty');
    expect(inputs).toEqual({ householdId: 'hh-empty', bankLines: [], orders: [], receipts: [], storeCreditAccruals: [], confirmedMatches: [] });
  });
});
