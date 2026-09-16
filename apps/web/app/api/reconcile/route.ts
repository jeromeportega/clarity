import { requireMutationToken } from '../../lib/auth/token';
import { reconcileHousehold } from '../../../../../modules/finance/core/reconcile/run';
import { DEMO_HOUSEHOLD_ID } from '../../../../../modules/finance/core/scope';
import { createDb } from '../../../../../modules/finance/db/client';

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
 * household explicitly so a bodiless call never kicks off a run by accident.
 * TODO(auth): with sessions, the household comes from the caller, not the body.
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
  if (body.householdId !== DEMO_HOUSEHOLD_ID) {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }

  try {
    const summary = await reconcileHousehold(createDb(), body.householdId);
    return Response.json(summary);
  } catch (err) {
    console.error('[reconcile] on-demand run failed', err);
    return Response.json({ error: 'reconciliation failed' }, { status: 500 });
  }
}
