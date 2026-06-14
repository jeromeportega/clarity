import { DEMO_HOUSEHOLD_ID } from '../../../../modules/finance/core/scope';

export interface ResolvedScope {
  householdId: string;
  readonly?: true;
}

/**
 * Resolves the operative household scope for read routes.
 *
 * When PUBLIC_DEMO_MODE=1, pins to DEMO_HOUSEHOLD_ID with no opt-out (T2).
 * In all modes, returns a defined scope — there is no unscoped read path.
 */
export function resolveHouseholdScope(_req?: Request): ResolvedScope {
  if (process.env.PUBLIC_DEMO_MODE === '1') {
    return { householdId: DEMO_HOUSEHOLD_ID, readonly: true };
  }
  return { householdId: DEMO_HOUSEHOLD_ID };
}
