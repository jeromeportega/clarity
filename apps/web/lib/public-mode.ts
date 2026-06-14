import { DEMO_HOUSEHOLD_ID } from '../../../modules/finance/core/scope';

export interface ResolvedScope {
  householdId: string;
  readonly?: true;
}

/**
 * Resolves the operative household scope for read routes.
 *
 * When PUBLIC_DEMO_MODE=1, pins to DEMO_HOUSEHOLD_ID with no opt-out (T2).
 * In all modes, returns a defined scope — there is no unscoped read path.
 *
 * @param req - Reserved for future per-request household resolution (e.g. x-household-id header).
 */
export function resolveHouseholdScope(req?: Request): ResolvedScope {
  void req; // reserved for future per-request household resolution
  if (process.env.PUBLIC_DEMO_MODE === '1') {
    return { householdId: DEMO_HOUSEHOLD_ID, readonly: true };
  }
  // TODO(story-004-009): multi-tenant resolution not yet implemented.
  // All reads currently pin to DEMO_HOUSEHOLD_ID so there is no unscoped path;
  // real-auth will replace this branch with per-user household lookup.
  return { householdId: DEMO_HOUSEHOLD_ID };
}
