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
  /** Retry schedule (ms) for a run that lost a database lock. Injected for tests. */
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [100, 300, 900];

/**
 * Reconcile one household from what is in the database right now:
 * `source.load → reconcile() → sink.persist`. This is the runtime entry point
 * the ingest and upload routes call after they commit new rows, what the queue
 * routes call after a match decision, and what `POST /api/reconcile` runs on
 * demand.
 *
 * Safe to run again at any time, and meant to be: the engine's output is a
 * function of the household's data plus the humans' decisions (`manual`
 * match rows become `confirmedMatches`), and the sink SYNCS the engine's rows
 * to that output inside one transaction — new rows appear, changed rows
 * follow the engine, retracted rows disappear, human rows are never touched,
 * and a receipt item that already has a category (from the SKU resolver or a
 * correction) keeps it. A run either lands whole or not at all.
 *
 * Concurrency: the sink's transaction holds the database's write lock for the
 * length of the sync, and two runs racing on one shared libSQL handle do not
 * merely fail — the losing `BEGIN` can leave the handle unable to commit
 * anything afterwards. So runs are serialised per household within the
 * process: a run that arrives while one is in flight waits for it and then
 * runs over the newer data (several arrivals coalesce into one wait), and a
 * run that still loses a lock to another process (another serverless
 * instance on the same Turso database) is retried whole, with backoff,
 * because every attempt re-reads before it writes.
 */
export async function reconcileHousehold(
  db: FinanceDb,
  householdId: string,
  opts: ReconcileHouseholdOptions = {},
): Promise<ReconcileRunSummary> {
  return serialised(householdId, () => withLockRetry(() => runOnce(db, householdId, opts), opts));
}

async function runOnce(db: FinanceDb, householdId: string, opts: ReconcileHouseholdOptions): Promise<ReconcileRunSummary> {
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

// ---------------------------------------------------------------------------
// Per-process, per-household serialisation with coalescing
// ---------------------------------------------------------------------------

/** The run currently holding the household's turn, if any. */
const running = new Map<string, Promise<unknown>>();
/** The single run queued behind it; later arrivals share this promise. */
const waiting = new Map<string, Promise<ReconcileRunSummary>>();

function serialised(key: string, fn: () => Promise<ReconcileRunSummary>): Promise<ReconcileRunSummary> {
  const queued = waiting.get(key);
  if (queued) return queued;

  const current = running.get(key);
  if (!current) {
    const run = fn();
    running.set(key, run);
    void run
      .finally(() => {
        if (running.get(key) === run) running.delete(key);
      })
      .catch(() => undefined);
    return run;
  }

  // Wait for the in-flight run to settle (either way), then take the turn.
  const next = current.then(fn, fn);
  waiting.set(key, next);
  void current
    .finally(() => {
      if (waiting.get(key) === next) waiting.delete(key);
      running.set(key, next);
    })
    .catch(() => undefined);
  void next
    .finally(() => {
      if (running.get(key) === next) running.delete(key);
    })
    .catch(() => undefined);
  return next;
}

// ---------------------------------------------------------------------------
// Lock-loss retry
// ---------------------------------------------------------------------------

/** libSQL surfaces a lost write lock as SQLITE_BUSY (file and remote transports alike). */
export function isDatabaseBusyError(err: unknown): boolean {
  const text = err instanceof Error ? `${(err as { code?: string }).code ?? ''} ${err.message}` : String(err);
  return /SQLITE_BUSY|database is locked/i.test(text);
}

async function withLockRetry<T>(attempt: () => Promise<T>, opts: ReconcileHouseholdOptions): Promise<T> {
  const delays = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (err) {
      if (!isDatabaseBusyError(err) || i >= delays.length) throw err;
      await sleep(delays[i]!);
    }
  }
}
