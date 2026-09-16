import type { FinanceDb } from '../../db/client';
import { reconcile } from './engine';
import { DrizzleReconcileSink, type ReconcileSink } from './sink';
import { DrizzleReconcileSource, type ReconcileSource } from './source';
import type { ReconcileConfig } from './thresholds';

/** What one reconciliation run saw and produced — small enough for a response body. */
export interface ReconcileRunSummary {
  householdId: string;
  inputs: { bankLines: number; orders: number; receipts: number; storeCreditAccruals: number; confirmedMatches: number };
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
 * Safe to run again at any time, and meant to be: the engine's output is a
 * function of the household's data plus the humans' decisions (`manual`
 * match rows become `confirmedMatches`), and the sink SYNCS the engine's rows
 * to that output inside one transaction — new rows appear, changed rows
 * follow the engine, retracted rows disappear, human rows are never touched,
 * and a receipt item that already has a category (from the SKU resolver or a
 * correction) keeps it. A run either lands whole or not at all.
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
      confirmedMatches: inputs.confirmedMatches?.length ?? 0,
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
