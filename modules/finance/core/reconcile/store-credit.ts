import type { Cents, StoreCreditAccrual } from './model';

/**
 * Net available balance for a store-credit kind.
 *
 * The store_credit_balances table holds both positive accruals and negative
 * drawdowns; the balance = SUM(amount_cents).  A negative result means the
 * kind is already over-drawn (route further drawdowns to review).
 */
export function availableAccrualCents(
  accruals: StoreCreditAccrual[],
  kind: StoreCreditAccrual['kind'],
): Cents {
  return accruals.filter((a) => a.kind === kind).reduce((sum, a) => sum + a.amountCents, 0);
}

/**
 * Find the best StoreCreditAccrual for a return item.
 *
 * Priority:
 *   1. Exact orderId + orderItemId match
 *   2. orderId match (shipment-level, multiple items on same order)
 *   3. kind + amount proximity (within 100¢ / $1.00)
 */
export function findAccrualForReturn(
  accruals: StoreCreditAccrual[],
  opts: {
    orderId?: string;
    orderItemId?: string;
    amountCents?: Cents;
    kind?: StoreCreditAccrual['kind'];
  },
): StoreCreditAccrual | undefined {
  if (opts.orderId && opts.orderItemId) {
    const exact = accruals.find(
      (a) =>
        a.orderId === opts.orderId &&
        a.orderItemId === opts.orderItemId &&
        (!opts.kind || a.kind === opts.kind),
    );
    if (exact) return exact;
  }

  if (opts.orderId) {
    const byOrder = accruals.find(
      (a) => a.orderId === opts.orderId && (!opts.kind || a.kind === opts.kind),
    );
    if (byOrder) return byOrder;
  }

  if (opts.kind != null && opts.amountCents != null) {
    const target = Math.abs(opts.amountCents);
    const byKind = accruals.filter(
      (a) => a.kind === opts.kind && Math.abs(a.amountCents - target) <= 100,
    );
    if (byKind.length > 0) {
      return byKind.sort(
        (a, b) => Math.abs(a.amountCents - target) - Math.abs(b.amountCents - target),
      )[0];
    }
  }

  return undefined;
}
