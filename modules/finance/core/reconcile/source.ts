import type { FinanceDb } from '../../db/client';
import { FIXTURE_INPUTS } from './__fixtures__/index';
import type { ReconcileInputs } from './model';

export interface ReconcileSource {
  load(householdId: string): Promise<ReconcileInputs>;
}

/**
 * In-memory fixture source used in tests and the gate. Returns the synthetic
 * corpus from `__fixtures__/index.ts`, overriding its householdId with the
 * caller's so fixture data is addressable by any test household.
 */
export class FixtureReconcileSource implements ReconcileSource {
  async load(householdId: string): Promise<ReconcileInputs> {
    return {
      ...FIXTURE_INPUTS,
      householdId,
      bankLines: FIXTURE_INPUTS.bankLines.map((b) => ({ ...b })),
      orders: FIXTURE_INPUTS.orders.map((o) => ({ ...o, items: o.items.map((i) => ({ ...i })) })),
      receipts: FIXTURE_INPUTS.receipts.map((r) => ({ ...r, items: r.items.map((i) => ({ ...i })) })),
      storeCreditAccruals: FIXTURE_INPUTS.storeCreditAccruals.map((a) => ({ ...a })),
    };
  }
}

/** Demo stub — full query implementation belongs to a later integration story. */
export class DrizzleReconcileSource implements ReconcileSource {
  constructor(private readonly db: FinanceDb) {}

  async load(_householdId: string): Promise<ReconcileInputs> {
    throw new Error('DrizzleReconcileSource.load: not implemented — wiring belongs to a later integration story');
  }
}
