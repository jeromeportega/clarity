import { describe, expect, it } from 'vitest';
import type { StoreCreditAccrual } from './model';
import { availableAccrualCents, findAccrualForReturn } from './store-credit';

const makeAccrual = (
  overrides: Partial<StoreCreditAccrual> & Pick<StoreCreditAccrual, 'id' | 'kind' | 'amountCents'>,
): StoreCreditAccrual => ({
  occurredAt: '2024-01-01',
  ...overrides,
});

describe('availableAccrualCents', () => {
  it('sums positive accruals for the given kind', () => {
    const accruals: StoreCreditAccrual[] = [
      makeAccrual({ id: 'a1', kind: 'gift_card', amountCents: 2400 }),
      makeAccrual({ id: 'a2', kind: 'gift_card', amountCents: 1000 }),
      makeAccrual({ id: 'a3', kind: 'store_credit', amountCents: 500 }),
    ];
    expect(availableAccrualCents(accruals, 'gift_card')).toBe(3400);
    expect(availableAccrualCents(accruals, 'store_credit')).toBe(500);
  });

  it('nets negative drawdowns against positive accruals', () => {
    const accruals: StoreCreditAccrual[] = [
      makeAccrual({ id: 'a1', kind: 'gift_card', amountCents: 5000 }),
      makeAccrual({ id: 'd1', kind: 'gift_card', amountCents: -2000 }), // prior drawdown
    ];
    expect(availableAccrualCents(accruals, 'gift_card')).toBe(3000);
  });

  it('returns 0 when there are no accruals for the kind', () => {
    const accruals: StoreCreditAccrual[] = [
      makeAccrual({ id: 'a1', kind: 'store_credit', amountCents: 1000 }),
    ];
    expect(availableAccrualCents(accruals, 'gift_card')).toBe(0);
    expect(availableAccrualCents([], 'account_balance')).toBe(0);
  });

  it('returns a negative net when already over-drawn', () => {
    const accruals: StoreCreditAccrual[] = [
      makeAccrual({ id: 'a1', kind: 'account_balance', amountCents: 1000 }),
      makeAccrual({ id: 'd1', kind: 'account_balance', amountCents: -1500 }),
    ];
    expect(availableAccrualCents(accruals, 'account_balance')).toBe(-500);
  });
});

describe('findAccrualForReturn', () => {
  const accruals: StoreCreditAccrual[] = [
    makeAccrual({
      id: 'sc-exact',
      kind: 'gift_card',
      amountCents: 2400,
      orderId: 'order-1',
      orderItemId: 'item-1a',
    }),
    makeAccrual({
      id: 'sc-order',
      kind: 'store_credit',
      amountCents: 1500,
      orderId: 'order-2',
    }),
    makeAccrual({ id: 'sc-amount', kind: 'account_balance', amountCents: 800 }),
  ];

  it('returns the exact orderId+orderItemId match first', () => {
    const result = findAccrualForReturn(accruals, {
      orderId: 'order-1',
      orderItemId: 'item-1a',
      amountCents: -2400,
      kind: 'gift_card',
    });
    expect(result?.id).toBe('sc-exact');
  });

  it('falls back to orderId match when orderItemId does not match', () => {
    const result = findAccrualForReturn(accruals, {
      orderId: 'order-2',
      orderItemId: 'item-2x',
      amountCents: -1500,
      kind: 'store_credit',
    });
    expect(result?.id).toBe('sc-order');
  });

  it('falls back to kind+amount proximity when no orderId match', () => {
    const result = findAccrualForReturn(accruals, {
      amountCents: -810,
      kind: 'account_balance',
    });
    expect(result?.id).toBe('sc-amount');
  });

  it('returns undefined when no accrual matches', () => {
    const result = findAccrualForReturn(accruals, {
      orderId: 'order-99',
      kind: 'gift_card',
      amountCents: -9999,
    });
    expect(result).toBeUndefined();
  });

  it('ignores kind+amount match when difference exceeds 100¢', () => {
    const result = findAccrualForReturn(accruals, {
      kind: 'account_balance',
      amountCents: -950, // 950 - 800 = 150 > 100
    });
    expect(result).toBeUndefined();
  });

  it('exact orderId+orderItemId match filters by kind — does not cross-link a wrong-kind accrual', () => {
    // Two accruals share the same orderId+orderItemId but have different kinds;
    // only the one matching opts.kind should be returned.
    const sameItemAccruals: StoreCreditAccrual[] = [
      makeAccrual({ id: 'sc-wrong-kind', kind: 'store_credit', amountCents: 1500, orderId: 'order-x', orderItemId: 'item-x' }),
      makeAccrual({ id: 'sc-right-kind', kind: 'gift_card', amountCents: 1500, orderId: 'order-x', orderItemId: 'item-x' }),
    ];
    const result = findAccrualForReturn(sameItemAccruals, {
      orderId: 'order-x',
      orderItemId: 'item-x',
      kind: 'gift_card',
      amountCents: -1500,
    });
    expect(result?.id).toBe('sc-right-kind');
  });

  it('orderId-only fallback filters by kind — does not cross-link a wrong-kind accrual', () => {
    // Order has two accruals of different kinds; opts.kind must be respected.
    const mixedKindAccruals: StoreCreditAccrual[] = [
      makeAccrual({ id: 'sc-wrong', kind: 'store_credit', amountCents: 1500, orderId: 'order-mix' }),
      makeAccrual({ id: 'sc-right', kind: 'gift_card', amountCents: 1500, orderId: 'order-mix' }),
    ];
    const result = findAccrualForReturn(mixedKindAccruals, {
      orderId: 'order-mix',
      orderItemId: 'item-not-exist', // exact match will miss → falls to step 2
      kind: 'gift_card',
      amountCents: -1500,
    });
    expect(result?.id).toBe('sc-right');
  });

  it('orderId-only fallback returns undefined when no accrual matches the required kind', () => {
    const onlyWrongKind: StoreCreditAccrual[] = [
      makeAccrual({ id: 'sc-wrong', kind: 'store_credit', amountCents: 1500, orderId: 'order-mix' }),
    ];
    const result = findAccrualForReturn(onlyWrongKind, {
      orderId: 'order-mix',
      kind: 'gift_card',
      amountCents: -1500,
    });
    expect(result).toBeUndefined();
  });
});
