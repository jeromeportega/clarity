import type { FinanceDb } from '../../db/client';
import type { ImportError, RawInput, SourceAdapter } from '../adapters/source-adapter';
import { persistBatch } from './persist';

export interface ImportContext {
  householdId: string;
  accountId?: string;
}

export interface ImportResult {
  inserted: {
    transactions: number;
    orders: number;
    orderItems: number;
    storeCreditRows: number;
  };
  /** Rows that matched an existing unique key and were skipped — idempotency in action (FR-19). */
  skippedDuplicates: number;
  /** Normalization + persistence errors, never silently dropped (FR-20). */
  errors: ImportError[];
}

function emptyResult(errors: ImportError[]): ImportResult {
  return {
    inserted: { transactions: 0, orders: 0, orderItems: 0, storeCreditRows: 0 },
    skippedDuplicates: 0,
    errors,
  };
}

/**
 * The one ingestion entry point. Selects the first adapter whose `supports(input)`
 * is true, normalizes the bytes into a {@link NormalizedBatch}, then hands the
 * batch to `persist.ts` for all DB writes, dedup, and ledger accrual.
 *
 * The adapter list is INJECTED by the caller (entry points compose all four; unit
 * tests pass just the adapter under test) so core never imports the concrete
 * source implementations and the dependency direction stays one-way (ADR-008).
 *
 * If no adapter matches, returns an {@link ImportResult} carrying a single
 * {@link ImportError} — it does not throw.
 */
export async function importSource(
  db: FinanceDb,
  input: RawInput,
  ctx: ImportContext,
  adapters: SourceAdapter[],
): Promise<ImportResult> {
  const adapter = adapters.find((a) => a.supports(input));
  if (!adapter) {
    return emptyResult([
      { rowRef: input.filename, reason: `no adapter supports input of kind '${input.kind}'` },
    ]);
  }

  const batch = await adapter.normalize(input);
  const persisted = await persistBatch(db, batch, ctx);

  return {
    inserted: persisted.inserted,
    skippedDuplicates: persisted.skippedDuplicates,
    errors: [...batch.errors, ...persisted.errors],
  };
}
