import type {
  ReconciliationGateway,
  HouseholdScope,
  Match,
  AmbiguousMatchGroup,
  Transaction,
  SpendRollup,
} from './types';

/**
 * Thin H3 integration wrapper — returns empty results until the H3 reconcile
 * engine is wired in. Swap these stubs for real DB reads when H3 merges.
 *
 * TODO(H3): map DB status enum to MatchStatus at the read layer:
 *   pending   → 'ambiguous'
 *   matched   → 'confirmed'
 *   rejected  → drop from listMatches (or add to MatchStatus if needed)
 *   manual    → 'confirmed'
 * Also normalise confidence: DB stores integer pct (0–100) → divide by 100.
 */
export class LiveReconciliationGateway implements ReconciliationGateway {
  constructor() {
    console.warn('[LiveReconciliationGateway] H3 not yet wired — all reads return empty');
  }

  async listMatches(_scope: HouseholdScope): Promise<Match[]> {
    return [];
  }

  async getAmbiguousMatchGroups(_scope: HouseholdScope): Promise<AmbiguousMatchGroup[]> {
    return [];
  }

  async listUnmatchedTransactions(_scope: HouseholdScope): Promise<Transaction[]> {
    return [];
  }

  async getRollups(_scope: HouseholdScope, _opts?: { month?: string }): Promise<SpendRollup[]> {
    return [];
  }

  async recomputeRollups(
    _scope: HouseholdScope,
    _affectedTransactionIds: string[],
  ): Promise<void> {}
}
