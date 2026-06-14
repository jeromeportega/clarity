import type { HouseholdScope } from '../scope';

export type { HouseholdScope };

/**
 * Gateway-level status — mapped from the DB `matches.status` enum
 * (pending/matched/rejected/manual) at the live-backend read layer.
 * 'rejected' and 'manual' DB values must be explicitly mapped in
 * LiveReconciliationGateway (see live.ts TODO). 'unmatched' transactions
 * surface exclusively through listUnmatchedTransactions, not listMatches.
 */
export type MatchStatus = 'confirmed' | 'ambiguous';

/** A reconciled or candidate link between a transaction and an order/receipt item. */
export interface Match {
  id: string;
  transactionId: string;
  orderItemId: string | null;
  receiptItemId: string | null;
  status: MatchStatus;
  /** normalised float [0, 1]; H3 DB stores integer pct → divide by 100 at the live read layer */
  confidence: number | null;
  method: string | null;
}

export interface AmbiguousMatchGroup {
  transactionId: string;
  candidates: Match[];
}

/** A normalized transaction visible through the reconciliation read path. */
export interface Transaction {
  id: string;
  householdId: string;
  accountId: string;
  postedDate: string;       // ISO-8601 (ADR-001)
  /** negative = money out (debit), positive = money in (credit); signed integer cents (ADR-001) */
  amountCents: number;
  direction: 'debit' | 'credit';
  normalizedMerchant: string;
}

/** Composite key that uniquely identifies one spend-rollup bucket. */
export interface RollupKey {
  householdId: string;
  category: string;
  month: string;  // YYYY-MM
}

/** Aggregated net spend for one household / category / month bucket. */
export interface SpendRollup {
  key: RollupKey;
  netCents: number;  // signed integer cents (ADR-001)
}

/**
 * The stable read interface for matches and rollups consumed by H4 stories.
 * No story imports H3 internals directly — all reads flow through this seam.
 */
export interface ReconciliationGateway {
  listMatches(scope: HouseholdScope): Promise<Match[]>;
  getAmbiguousMatchGroups(scope: HouseholdScope): Promise<AmbiguousMatchGroup[]>;
  listUnmatchedTransactions(scope: HouseholdScope): Promise<Transaction[]>;
  /**
   * @param opts.month — non-empty YYYY-MM string; omit to return all months.
   */
  getRollups(scope: HouseholdScope, opts?: { month?: string }): Promise<SpendRollup[]>;
  recomputeRollups(scope: HouseholdScope, affectedTransactionIds: string[]): Promise<void>;
}
