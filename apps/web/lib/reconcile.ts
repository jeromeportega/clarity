import { reconcileHousehold, type ReconcileRunSummary } from '../../../modules/finance/core/reconcile/run';
import type { FinanceDb } from '../../../modules/finance/db/client';

export type ReconcileOutcome = ReconcileRunSummary | { error: string };

/**
 * Run reconciliation for a household right after a write route has committed
 * new rows (an ingest, an uploaded receipt), so matching and the review queue
 * reflect the new data by the time the response is read.
 *
 * The write has already succeeded by the time this runs, so a failure here is
 * reported in the response rather than turning a committed import into a 500;
 * the run is idempotent and `POST /api/reconcile` re-runs it on demand.
 */
export async function reconcileAfterWrite(db: FinanceDb, householdId: string): Promise<ReconcileOutcome> {
  try {
    return await reconcileHousehold(db, householdId);
  } catch (err) {
    console.error('[reconcile] run after write failed', err);
    return { error: 'reconciliation failed; the import is saved — POST /api/reconcile to retry' };
  }
}
