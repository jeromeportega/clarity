import type { Cents } from '../reconcile/model';

export interface InsightFlag {
  code: 'merchant_above_avg' | 'category_tracking_over' | 'new_recurring_charge';
  message: string;
  amounts: { observedCents: Cents; comparisonCents?: Cents; deltaPct?: number };
  /** Human-readable explanation of how the flag was derived. */
  basis: string;
  /**
   * True when there is insufficient history to make a confident comparison
   * (history window < insightComparisonMonths). The flag is still surfaced but
   * callers should display it with reduced prominence (NFR-6).
   */
  inconclusive?: boolean;
}
