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
 * anything afterwards — and SQLite's write lock is database-wide, not
 * per household. So runs are serialised process-wide: a run that arrives
 * while any run is in flight waits for it and then runs over the newer data
 * (arrivals for the same household coalesce into one wait), and a run that
 * still loses a lock to another process (another serverless instance on the
 * same Turso database) is retried whole, with backoff, because every attempt
 * re-reads before it writes.
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
// Process-wide write gate, with per-household coalescing
// ---------------------------------------------------------------------------
//
// SQLite's write lock is database-wide, so the gate is too: every run in this
// process — any household, any handle on the same database — takes its turn
// behind the previous one. Arrivals for a household that already has a run
// queued share that run (it will read the newer data when its turn comes).
//
// This is deliberately mutable process-global state inside `core`, which is
// otherwise DI-seamed: a lock is a property of the process, not of a caller.
// It persists across tests in a worker (harmless: it only orders runs). If a
// bundler ever duplicates this module across server chunks, each chunk gets
// its own gate and `withLockRetry` is the remaining backstop.

/** The run currently holding — or last to hold — the gate. */
let tail: Promise<unknown> = Promise.resolve();
/** Per household: the run queued behind the gate, shared by later arrivals until it starts. */
const waiting = new Map<string, Promise<ReconcileRunSummary>>();

function serialised(householdId: string, fn: () => Promise<ReconcileRunSummary>): Promise<ReconcileRunSummary> {
  const queued = waiting.get(householdId);
  if (queued) return queued;

  const previous = tail;
  // Take the turn once whatever holds the gate settles, either way.
  const run = previous.then(fn, fn);
  tail = run.catch(() => undefined);
  waiting.set(householdId, run);
  // The moment the run starts it is no longer "queued": a later arrival must
  // queue a fresh run so it sees data written after this one began.
  void previous
    .finally(() => {
      if (waiting.get(householdId) === run) waiting.delete(householdId);
    })
    .catch(() => undefined);
  return run;
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
