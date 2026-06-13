/**
 * DEMO_HOUSEHOLD_ID is a code constant (not an env var) so seed data and public
 * mode can never drift from each other (§11 of the epic contract).
 */
export const DEMO_HOUSEHOLD_ID = 'demo-household-00000000-0000-0000-0000-000000000001';

export interface HouseholdScope {
  householdId: string;
}
