import type { FinanceDb } from '../../db/client';
import { reconcile } from './engine';
import { DrizzleReconcileSink, type ReconcileSink } from './sink';
import { DrizzleReconcileSource, type ReconcileSource } from './source';
import type { ReconcileConfig } from './thresholds';

/** What one reconciliation run saw and produced — small enough for a response body. */
export interface ReconcileRunSummary {
  householdId: string;
  inputs: { bankLines: number; orders: number; receipts: number; storeCreditAccruals: number };
  /** Auto-linked matches (persisted as `matched`). */
  matched: number;
  /** Below-threshold candidates (persisted as `pending`; the queue's ambiguous_match source). */
  review: number;
  unmatched: { bankLines: number; orderItems: number; receipts: number };
  netSpendCents: number;
}

export interface ReconcileHouseholdOptions {
  source?: ReconcileSource;
  sink?: ReconcileSink;
  config?: Partial<ReconcileConfig>;
}

/**
 * Reconcile one household from what is in the database right now:
 * `source.load → reconcile() → sink.persist`. This is the runtime entry point
 * the ingest and upload routes call after they commit new rows, and what
 * `POST /api/reconcile` runs on demand.
 *
 * Safe to run again at any time. The sink only ever adds: match rows carry
 * deterministic ids (a re-run is a no-op for rows that already exist), a
 * transaction a human has settled is never re-opened, and a receipt item that
 * already has a category — from the SKU resolver or from a correction — keeps
 * it. A run that fails part-way leaves nothing inconsistent to repair beyond
 * running it again.
 */
export async function reconcileHousehold(
  db: FinanceDb,
  householdId: string,
  opts: ReconcileHouseholdOptions = {},
): Promise<ReconcileRunSummary> {
  const source = opts.source ?? new DrizzleReconcileSource(db);
  const sink = opts.sink ?? new DrizzleReconcileSink(db);

  const inputs = await source.load(householdId);
  const ledger = reconcile(inputs, opts.config);
  await sink.persist(householdId, ledger);

  return {
    householdId,
    inputs: {
      bankLines: inputs.bankLines.length,
      orders: inputs.orders.length,
      receipts: inputs.receipts.length,
      storeCreditAccruals: inputs.storeCreditAccruals.length,
    },
    matched: ledger.matches.length,
    review: ledger.reviewQueue.length,
    unmatched: {
      bankLines: ledger.unmatched.bankLines.length,
      orderItems: ledger.unmatched.orderItems.length,
      receipts: ledger.unmatched.receipts.length,
    },
    netSpendCents: ledger.netSpendCents,
  };
}
