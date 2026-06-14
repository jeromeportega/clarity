/**
 * Tuned matching constants for the H3 reconciliation engine (FR-14).
 * All defaults are calibrated against the synthetic fixture corpus in
 * `__fixtures__/index.ts` and documented below.
 */
export interface ReconcileConfig {
  /** Max cents of tip/rounding that a receipt or bank charge may differ before
   *  the match is rejected. Default 1500 (= $15.00). */
  tipAdjustmentToleranceCents: number;

  /** Sørensen–Dice bigram similarity floor for merchant name matching.
   *  Below this, names are considered too dissimilar to link. Default 0.72. */
  merchantSimilarityCutoff: number;

  /** ±N days around a receipt date when searching for a matching bank line.
   *  Default 3. */
  receiptDateWindowDays: number;

  /** ±N days around an order date when searching for a matching bank charge.
   *  Default 7 (Amazon can settle several days after order placement). */
  orderDateWindowDays: number;

  /** Maximum number of bank-line candidates fed to the subset-sum solver.
   *  Caps combinatorial explosion. Default 12. */
  subsetMaxCandidates: number;

  /** Minimum confidence for a match to be auto-linked without human review.
   *  Below this threshold the match goes to the reviewQueue (FR-4). Default 0.70. */
  confidenceThreshold: number;

  /** Max cents that a recurring charge amount may vary month-to-month and
   *  still be considered the same recurrence. Default 200 (= $2.00). */
  recurringAmountToleranceCents: number;

  /** Max days that a recurring event may drift from its expected cadence and
   *  still be classified as recurring. Default 3. */
  recurringCadenceToleranceDays: number;

  /** Number of prior months used when computing insight comparisons (NFR-6).
   *  When actual history is shorter the insight is marked inconclusive. Default 3. */
  insightComparisonMonths: number;
}

export const DEFAULT_CONFIG: ReconcileConfig = {
  tipAdjustmentToleranceCents: 1500,
  merchantSimilarityCutoff: 0.72,
  receiptDateWindowDays: 3,
  orderDateWindowDays: 7,
  subsetMaxCandidates: 12,
  confidenceThreshold: 0.70,
  recurringAmountToleranceCents: 200,
  recurringCadenceToleranceDays: 3,
  insightComparisonMonths: 3,
};
