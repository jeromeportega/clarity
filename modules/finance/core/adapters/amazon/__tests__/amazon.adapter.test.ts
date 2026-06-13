import { describe, expect, it } from 'vitest';

import type { NormalizedOrder } from '../../../model/normalized';
import type { RawInput } from '../../source-adapter';
import { amazonAdapter } from '../amazon.adapter';
import { paymentMethodToRefundDestination } from '../parse';
import { AMAZON_HEADER, FULL_CSV, buildCsv } from './fixtures';

function input(csv: string, filename = 'Retail.OrderHistory.1.csv'): RawInput {
  return { kind: 'amazon', filename, bytes: new TextEncoder().encode(csv) };
}

async function normalizeFull(): Promise<NormalizedOrder[]> {
  const batch = await amazonAdapter.normalize(input(FULL_CSV));
  expect(batch.errors).toEqual([]);
  return batch.orders;
}

function order(orders: NormalizedOrder[], id: string): NormalizedOrder {
  const found = orders.find((o) => o.externalOrderId === id);
  if (!found) throw new Error(`order ${id} not found`);
  return found;
}

describe('amazonAdapter — contract surface', () => {
  it('declares kind "amazon" and supports amazon inputs only', () => {
    expect(amazonAdapter.kind).toBe('amazon');
    expect(amazonAdapter.supports(input('x'))).toBe(true);
    expect(
      amazonAdapter.supports({ kind: 'bank', filename: 'b.csv', bytes: new Uint8Array() }),
    ).toBe(false);
  });

  it('returns a NormalizedBatch with only the orders array populated (no transactions/receipts)', async () => {
    const batch = await amazonAdapter.normalize(input(FULL_CSV));
    expect(batch.transactions).toEqual([]);
    expect(batch.receipts).toEqual([]);
    expect(batch.orders.length).toBe(4);
  });
});

describe('amazonAdapter — extraction & grouping', () => {
  it('groups rows by Order ID into orders carrying per-(shipmentId,itemSeq) items', async () => {
    const orders = await normalizeFull();
    const single = order(orders, '111-SINGLE');

    expect(single.source).toBe('amazon');
    expect(single.orderDate).toBe('2026-01-05');
    expect(single.currency).toBe('USD');
    expect(single.items).toHaveLength(2);

    // One shipment (one ship date), two items sequenced within it.
    const shipments = new Set(single.items.map((i) => i.shipmentId));
    expect(shipments.size).toBe(1);
    expect(single.items.map((i) => i.itemSeq).sort()).toEqual([1, 2]);

    const keys = single.items.map((i) => `${i.shipmentId}#${i.itemSeq}`);
    expect(new Set(keys).size).toBe(2); // every (shipmentId,itemSeq) key is unique
  });

  it('splits one order across three shipments (distinct ship dates)', async () => {
    const orders = await normalizeFull();
    const split = order(orders, '222-SPLIT');

    expect(split.items).toHaveLength(3);
    const shipments = new Set(split.items.map((i) => i.shipmentId));
    expect(shipments.size).toBe(3);
    // Each shipment carries exactly one item, sequenced as 1.
    for (const item of split.items) {
      expect(item.itemSeq).toBe(1);
    }
  });

  it('reflects per-shipment subtotals: item amounts within a shipment sum to that shipment total', async () => {
    const orders = await normalizeFull();
    const single = order(orders, '111-SINGLE');

    // 13.99 + 10.49 from the two single-shipment lines.
    const shipmentId = single.items[0]!.shipmentId;
    const subtotal = single.items
      .filter((i) => i.shipmentId === shipmentId)
      .reduce((sum, i) => sum + i.amountCents, 0);
    expect(subtotal).toBe(2448);
  });

  it('sets a purchase line as positive, not a return, with no refund destination', async () => {
    const orders = await normalizeFull();
    const buy = order(orders, '111-SINGLE').items.find((i) => i.description.includes('USB-C'))!;

    expect(buy.amountCents).toBe(1399);
    expect(buy.unitPriceCents).toBe(1299);
    expect(buy.quantity).toBe(1);
    expect(buy.isReturn).toBe(false);
    expect(buy.refundDestination).toBeUndefined();
    expect(buy.sourceRowHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('derives a return line from the negative sign (ADR-002) and keeps it as a distinct line', async () => {
    const orders = await normalizeFull();
    const ret = order(orders, '333-RETURN');

    const returnLines = ret.items.filter((i) => i.isReturn);
    expect(returnLines).toHaveLength(1);
    const refund = returnLines[0]!;
    expect(refund.amountCents).toBeLessThan(0);
    expect(refund.amountCents).toBe(-2000);
    expect(refund.isReturn).toBe(true);

    // The original purchase line for the same product is still present and positive.
    const purchases = ret.items.filter((i) => !i.isReturn);
    expect(purchases.every((i) => i.amountCents > 0)).toBe(true);
    expect(ret.items).toHaveLength(3);
  });

  it('populates refundDestination only on return lines, from what the source states', async () => {
    const orders = await normalizeFull();

    const cardReturn = order(orders, '333-RETURN').items.find((i) => i.isReturn)!;
    expect(cardReturn.refundDestination).toBe('card');

    const giftReturn = order(orders, '444-GIFTCARD').items.find((i) => i.isReturn)!;
    expect(giftReturn.refundDestination).toBe('gift_card');

    // Purchases never carry a refund destination, even when a payment method is present.
    const allPurchases = orders.flatMap((o) => o.items).filter((i) => !i.isReturn);
    expect(allPurchases.every((i) => i.refundDestination === undefined)).toBe(true);
  });

  it('never leaks PII columns into the normalized model', async () => {
    const orders = await normalizeFull();
    const blob = JSON.stringify(orders);
    for (const pii of ['Main St', 'Oak Ave', 'UPS', '1Z999', 'SN-001', 'PO-42', '555-0100']) {
      expect(blob).not.toContain(pii);
    }
  });
});

describe('amazonAdapter — malformed rows surface as errors (FR-20)', () => {
  it('records an ImportError for an unparseable amount and still parses the good rows', async () => {
    const csv = buildCsv([
      {
        'Order ID': 'OK-1',
        'Order Date': '2026-05-01',
        'Ship Date': '2026-05-02',
        'Product Name': 'Good Item',
        'Original Quantity': '1',
        'Unit Price': '5.00',
        'Total Amount': '5.00',
        'Payment Method Type': 'Visa',
      },
      {
        'Order ID': 'BAD-1',
        'Order Date': '2026-05-01',
        'Ship Date': '2026-05-02',
        'Product Name': 'Bad Item',
        'Original Quantity': '1',
        'Unit Price': 'not-a-number',
        'Total Amount': 'not-a-number',
        'Payment Method Type': 'Visa',
      },
    ]);

    const batch = await amazonAdapter.normalize(input(csv));
    expect(batch.errors.length).toBe(1);
    expect(batch.errors[0]?.reason).toMatch(/amount/i);
    expect(batch.orders.map((o) => o.externalOrderId)).toEqual(['OK-1']);
  });

  it('records an ImportError for a row missing an Order ID', async () => {
    const csv = buildCsv([
      {
        'Order ID': '',
        'Order Date': '2026-05-01',
        'Product Name': 'Orphan',
        'Total Amount': '5.00',
      },
    ]);
    const batch = await amazonAdapter.normalize(input(csv));
    expect(batch.orders).toEqual([]);
    expect(batch.errors.length).toBe(1);
    expect(batch.errors[0]?.reason).toMatch(/order id/i);
  });

  it('returns no orders and no errors for a header-only file', async () => {
    const batch = await amazonAdapter.normalize(input(AMAZON_HEADER + '\r\n'));
    expect(batch.orders).toEqual([]);
    expect(batch.errors).toEqual([]);
  });

  it('falls back to a stable shipment id when Ship Date is absent', async () => {
    const csv = buildCsv([
      {
        'Order ID': 'NOSHIP-1',
        'Order Date': '2026-06-01',
        'Ship Date': '',
        'Product Name': 'Backordered Item',
        'Original Quantity': '1',
        'Unit Price': '7.00',
        'Total Amount': '7.00',
        'Payment Method Type': 'Visa',
      },
    ]);
    const batch = await amazonAdapter.normalize(input(csv));
    expect(batch.errors).toEqual([]);
    const item = batch.orders[0]?.items[0];
    expect(item?.shipmentId).toBeTruthy();
    expect(item?.itemSeq).toBe(1);
  });
});

describe('paymentMethodToRefundDestination', () => {
  it.each([
    ['Visa - 1234', 'card'],
    ['Mastercard - 5678', 'card'],
    ['American Express', 'card'],
    ['Discover', 'card'],
    ['Amazon Store Card', 'card'],
    ['Credit Card', 'card'],
    ['Debit Card', 'card'],
    ['Gift Card', 'gift_card'],
    ['Gift Certificate', 'gift_card'],
    ['Amazon Store Credit', 'store_credit'],
    ['Store Credit', 'store_credit'],
    ['Amazon Pay Balance', 'account_balance'],
    ['Account Balance', 'account_balance'],
  ])('maps %j to %j', (input, expected) => {
    expect(paymentMethodToRefundDestination(input)).toBe(expected);
  });

  it('returns undefined when the source does not state a recognizable destination', () => {
    expect(paymentMethodToRefundDestination('')).toBeUndefined();
    expect(paymentMethodToRefundDestination('Mystery Method')).toBeUndefined();
  });
});
