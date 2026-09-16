import { eq } from 'drizzle-orm';

import { requireMutationToken } from '../../lib/auth/token';
import { reconcileHousehold } from '../../../../../modules/finance/core/reconcile/run';
import { createDb, type FinanceDb } from '../../../../../modules/finance/db/client';
import { households } from '../../../../../modules/finance/db/schema';

// Module-level singleton — avoids opening a new connection per request.
let _db: FinanceDb | undefined;
function getDb(): FinanceDb {
  _db ??= createDb();
  return _db;
}

/**
 * POST /api/reconcile — JSON `{ householdId }`.
 *
 * Runs reconciliation for the household on demand: everything in the database
 * right now → `reconcile()` → `matches` / `receipt_items.category_id`. The
 * ingest and upload routes run this themselves after every write; this route
 * exists to re-run it (after a failed post-write run, a config change, or a
 * migration) and returns the run's summary.
 *
 * Mutation route: `x-reconcile-token` gate first. The body must name the
 * household explicitly so a bodiless call never kicks off a run by accident;
 * an unknown household is 404. The token holder is the operator of every
 * household this deployment serves. TODO(auth): with sessions, the household
 * comes from the caller, not the body.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireMutationToken(request);
  if (denied) return denied;

  let body: { householdId?: unknown };
  try {
    body = (await request.json()) as { householdId?: unknown };
  } catch {
    return Response.json({ error: 'JSON body { householdId } is required' }, { status: 400 });
  }
  if (typeof body.householdId !== 'string' || body.householdId.length === 0) {
    return Response.json({ error: 'householdId is required' }, { status: 400 });
  }

  const db = getDb();
  const known = await db.select({ id: households.id }).from(households).where(eq(households.id, body.householdId)).limit(1);
  if (!known[0]) {
    return Response.json({ error: `unknown household '${body.householdId}'` }, { status: 404 });
  }

  try {
    const summary = await reconcileHousehold(db, body.householdId);
    return Response.json(summary);
  } catch (err) {
    console.error('[reconcile] on-demand run failed', err);
    return Response.json({ error: 'reconciliation failed' }, { status: 500 });
  }
}
