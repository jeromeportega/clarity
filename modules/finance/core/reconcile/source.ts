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
    return { ...FIXTURE_INPUTS, householdId };
  }
}

/** Demo stub — full query implementation belongs to a later integration story. */
export class DrizzleReconcileSource implements ReconcileSource {
  constructor(private readonly db: FinanceDb) {}

  async load(householdId: string): Promise<ReconcileInputs> {
    void this.db; // referenced to satisfy the type; full impl not in scope here
    return {
      householdId,
      bankLines: [],
      orders: [],
      receipts: [],
      storeCreditAccruals: [],
    };
  }
}
