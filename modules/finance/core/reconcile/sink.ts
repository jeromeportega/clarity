import type { FinanceDb } from '../../db/client';
import type { ReconciledLedger } from './model';

export interface ReconcileSink {
  persist(householdId: string, ledger: ReconciledLedger): Promise<void>;
}

/**
 * Accumulates a ledger in memory. Used by the gate to assert on reconciliation
 * output without requiring a live database.
 */
export class InMemorySink implements ReconcileSink {
  private _ledgers: Map<string, ReconciledLedger> = new Map();

  async persist(householdId: string, ledger: ReconciledLedger): Promise<void> {
    this._ledgers.set(householdId, ledger);
  }

  get(householdId: string): ReconciledLedger | undefined {
    return this._ledgers.get(householdId);
  }

  clear(): void {
    this._ledgers.clear();
  }
}

/** Demo stub — full write implementation belongs to a later integration story. */
export class DrizzleReconcileSink implements ReconcileSink {
  constructor(private readonly _db: FinanceDb) {}

  async persist(_householdId: string, _ledger: ReconciledLedger): Promise<void> {
    throw new Error('DrizzleReconcileSink.persist: not implemented — wiring belongs to a later integration story');
  }
}
