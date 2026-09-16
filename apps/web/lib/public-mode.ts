import { getPrincipal } from '../app/lib/auth/session';
import { DEMO_HOUSEHOLD_ID } from '../../../modules/finance/core/scope';

export interface ResolvedScope {
  householdId: string;
  /** The public demo: one seeded household, no decisions, no uploads. */
  readonly?: true;
}

/**
 * The operative household for a READ — a page or a GET route.
 *
 *   PUBLIC_DEMO_MODE=1 → the demo household, read-only, for everyone (no
 *                        opt-out: a request cannot name another household);
 *   a signed-in person → their own household, writable;
 *   otherwise          → null: there is nothing to show, and the caller
 *                        redirects to sign-in or answers 403.
 *
 * There is no unscoped read path.
 */
export async function resolveReadScope(): Promise<ResolvedScope | null> {
  if (process.env.PUBLIC_DEMO_MODE === '1') {
    return { householdId: DEMO_HOUSEHOLD_ID, readonly: true };
  }
  const principal = await getPrincipal();
  return principal ? { householdId: principal.householdId } : null;
}
