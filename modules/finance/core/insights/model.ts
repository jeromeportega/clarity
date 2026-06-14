import type { Cents } from '../reconcile/model';

export interface InsightFlag {
  code: 'merchant_above_avg' | 'category_tracking_over' | 'new_recurring_charge';
  message: string;
  amounts: { observedCents: Cents; comparisonCents?: Cents; deltaPct?: number };
  /** Human-readable explanation of how the flag was derived. */
  basis: string;
  /**
   * True when there is insufficient history to make a confident comparison
   * (prior months for this merchant/category < insightComparisonMonths). The
   * flag is still surfaced so callers can show "not enough data yet" rather
   * than a misleading comparison (NFR-6, ADR-010).
   */
  inconclusive?: boolean;
}
