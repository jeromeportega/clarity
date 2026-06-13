import { describe, expect, it } from 'vitest';

import { FIXTURE_INPUTS } from '../__fixtures__/index';
import { FixtureReconcileSource } from '../source';

describe('FixtureReconcileSource', () => {
  it('returns inputs with the requested householdId', async () => {
    const source = new FixtureReconcileSource();
    const inputs = await source.load('test-household');
    expect(inputs.householdId).toBe('test-household');
  });

  it('does not mutate FIXTURE_INPUTS when overriding householdId', async () => {
    const source = new FixtureReconcileSource();
    await source.load('hh-a');
    expect(FIXTURE_INPUTS.householdId).toBe('fixture-household-001');
  });
});

describe('fixtures span ≥3 months (AC2)', () => {
  function monthBuckets(dates: string[]): Set<string> {
    return new Set(dates.map((d) => d.slice(0, 7)));
  }

  it('bank lines span ≥3 distinct YYYY-MM buckets', () => {
    const months = monthBuckets(FIXTURE_INPUTS.bankLines.map((b) => b.postedDate));
    expect(months.size).toBeGreaterThanOrEqual(3);
  });

  it('orders span ≥3 distinct YYYY-MM buckets', () => {
    const months = monthBuckets(FIXTURE_INPUTS.orders.map((o) => o.orderDate));
    expect(months.size).toBeGreaterThanOrEqual(3);
  });

  it('receipts span ≥3 distinct YYYY-MM buckets', () => {
    const months = monthBuckets(
      FIXTURE_INPUTS.receipts.map((r) => r.capturedAt).filter((d): d is string => d !== undefined),
    );
    expect(months.size).toBeGreaterThanOrEqual(3);
  });

  it('combined date set spans ≥3 distinct months', () => {
    const all = [
      ...FIXTURE_INPUTS.bankLines.map((b) => b.postedDate),
      ...FIXTURE_INPUTS.orders.map((o) => o.orderDate),
      ...FIXTURE_INPUTS.receipts.map((r) => r.capturedAt).filter((d): d is string => d !== undefined),
    ];
    const months = monthBuckets(all);
    expect(months.size).toBeGreaterThanOrEqual(3);
  });
});

describe('fixture realism — at least one of every input kind (AC2)', () => {
  it('contains at least one bank line debit (purchase)', () => {
    expect(FIXTURE_INPUTS.bankLines.some((b) => b.direction === 'debit')).toBe(true);
  });

  it('contains at least one bank line credit (refund)', () => {
    expect(FIXTURE_INPUTS.bankLines.some((b) => b.direction === 'credit')).toBe(true);
  });

  it('contains at least one order with items', () => {
    const ordersWithItems = FIXTURE_INPUTS.orders.filter((o) => o.items.length > 0);
    expect(ordersWithItems.length).toBeGreaterThan(0);
  });

  it('contains at least one receipt with items', () => {
    const receiptsWithItems = FIXTURE_INPUTS.receipts.filter((r) => r.items.length > 0);
    expect(receiptsWithItems.length).toBeGreaterThan(0);
  });

  it('contains at least one store-credit accrual', () => {
    expect(FIXTURE_INPUTS.storeCreditAccruals.length).toBeGreaterThan(0);
  });

  it('contains an order item marked as a return with a refundDestination', () => {
    const allItems = FIXTURE_INPUTS.orders.flatMap((o) => o.items);
    const returnItem = allItems.find((i) => i.isReturn && i.refundDestination != null);
    expect(returnItem).toBeDefined();
  });
});
