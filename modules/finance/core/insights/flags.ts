import type { Cents, LedgerEvent, ReconciledLedger } from '../reconcile/model';
import type { ReconcileConfig } from '../reconcile/thresholds';
import type { Rollup } from '../rollups/model';
import type { InsightFlag } from './model';

// ── Helpers ───────────────────────────────────────────────────────────────────

const MERCHANT_PREFIX = 'merchant: ';

function merchantFromRationale(rationale: string): string | null {
  if (!rationale.startsWith(MERCHANT_PREFIX)) return null;
  const semi = rationale.indexOf(';', MERCHANT_PREFIX.length);
  return semi !== -1
    ? rationale.slice(MERCHANT_PREFIX.length, semi).trim()
    : rationale.slice(MERCHANT_PREFIX.length).trim();
}

function monthOf(isoDate: string): string {
  return isoDate.slice(0, 7);
}

/** Offset a YYYY-MM string by `delta` months (negative = earlier). */
function addMonths(yyyymm: string, delta: number): string {
  const [y, m] = yyyymm.split('-').map(Number);
  const total = y * 12 + m - 1 + delta;
  const yr = Math.floor(total / 12);
  const mo = ((total % 12) + 12) % 12 + 1;
  return `${yr}-${String(mo).padStart(2, '0')}`;
}

function calcDeltaPct(observed: Cents, comparison: Cents): number {
  if (comparison === 0) return 0;
  return Math.round(((observed - comparison) / comparison) * 100);
}

function latestMonth(events: LedgerEvent[]): string | null {
  return events.reduce<string | null>((max, e) => {
    const m = monthOf(e.occurredOn);
    return max === null || m > max ? m : max;
  }, null);
}

// ── Flag: merchant_above_avg ──────────────────────────────────────────────────
//
// For each merchant that appears in the current month (positive spend only):
// - If prior months >= insightComparisonMonths: emit the flag only when current
//   spend exceeds the N-month average (in-line or below-average spend does not fire).
// - If prior months < insightComparisonMonths: emit inconclusive with
//   basis: 'insufficient_history' — no fabricated average (ADR-010, NFR-6).
//
// Merchant identity is extracted from the "merchant: <name>;" prefix written
// by both HeuristicClassifier (merchant_fallback) and detectRecurring.

function deriveMerchantAboveAvg(
  events: LedgerEvent[],
  currentMonth: string,
  cfg: ReconcileConfig,
): InsightFlag[] {
  const { insightComparisonMonths } = cfg;

  // Accumulate (merchant → (month → totalSpendCents)) for purchases only.
  const merchantMonthSpend = new Map<string, Map<string, Cents>>();

  for (const event of events) {
    if (event.signedSpendCents <= 0) continue;
    const rationale =
      event.mergedItems.find((i) => i.rationale.startsWith(MERCHANT_PREFIX))?.rationale ?? '';
    const merchant = merchantFromRationale(rationale);
    if (!merchant) continue;

    const month = monthOf(event.occurredOn);
    const byMonth = merchantMonthSpend.get(merchant) ?? new Map<string, Cents>();
    byMonth.set(month, (byMonth.get(month) ?? 0) + event.signedSpendCents);
    merchantMonthSpend.set(merchant, byMonth);
  }

  const flags: InsightFlag[] = [];

  for (const [merchant, byMonth] of merchantMonthSpend) {
    const currentSpend = byMonth.get(currentMonth);
    if (currentSpend === undefined) continue;

    const priorSpends: Cents[] = [];
    for (let i = 1; i <= insightComparisonMonths; i++) {
      const s = byMonth.get(addMonths(currentMonth, -i));
      if (s !== undefined) priorSpends.push(s);
    }

    if (priorSpends.length < insightComparisonMonths) {
      // Only emit inconclusive when the merchant has appeared before (has history but
      // not enough). Completely new merchants (0 prior months) are skipped to avoid
      // flooding callers with low-signal noise on first import (ADR-010).
      if (priorSpends.length >= 1) {
        flags.push({
          code: 'merchant_above_avg',
          message: `Insufficient history to compare ${merchant} spend`,
          amounts: { observedCents: currentSpend },
          basis: 'insufficient_history',
          inconclusive: true,
        });
      }
      continue;
    }

    const avgCents = Math.round(priorSpends.reduce((s, v) => s + v, 0) / priorSpends.length);
    if (currentSpend > avgCents) {
      flags.push({
        code: 'merchant_above_avg',
        message: `${merchant} spend this month is above the ${insightComparisonMonths}-month average`,
        amounts: {
          observedCents: currentSpend,
          comparisonCents: avgCents,
          deltaPct: calcDeltaPct(currentSpend, avgCents),
        },
        basis: `${insightComparisonMonths}-month avg for ${merchant}`,
      });
    }
  }

  return flags;
}

// ── Flag: category_tracking_over ──────────────────────────────────────────────
//
// For each category present in the current month's rollup cells:
// - If the prior month also has data: emit the flag only when current > prior
//   (below or equal spend does not fire).
// - If the prior month has no data: emit inconclusive (NFR-6, ADR-010).

function deriveCategoryTrackingOver(
  rollup: Rollup,
  currentMonth: string,
): InsightFlag[] {
  const priorMonth = addMonths(currentMonth, -1);

  const byCategory = new Map<string, Map<string, Cents>>();
  for (const cell of rollup) {
    const byMonth = byCategory.get(cell.category) ?? new Map<string, Cents>();
    byMonth.set(cell.month, cell.netSpendCents);
    byCategory.set(cell.category, byMonth);
  }

  const flags: InsightFlag[] = [];

  for (const [category, byMonth] of byCategory) {
    const currentSpend = byMonth.get(currentMonth);
    if (currentSpend === undefined || currentSpend <= 0) continue;

    const priorSpend = byMonth.get(priorMonth);

    if (priorSpend === undefined || priorSpend <= 0) {
      flags.push({
        code: 'category_tracking_over',
        message: `No meaningful prior-month baseline to compare ${category} spend`,
        amounts: { observedCents: currentSpend },
        basis: 'insufficient_history',
        inconclusive: true,
      });
      continue;
    }

    if (currentSpend > priorSpend) {
      flags.push({
        code: 'category_tracking_over',
        message: `${category} spend is tracking above last month`,
        amounts: {
          observedCents: currentSpend,
          comparisonCents: priorSpend,
          deltaPct: calcDeltaPct(currentSpend, priorSpend),
        },
        basis: `prior month (${priorMonth}) for ${category}`,
      });
    }
  }

  return flags;
}

// ── Flag: new_recurring_charge ────────────────────────────────────────────────
//
// Identifies subscriptions or recurring charges that began recently.
// A recurring charge is "new" when its earliest detected occurrence in the
// ledger falls within the insightComparisonMonths window ending at currentMonth.
// Basis cites when the charge was first seen.

function deriveNewRecurringCharge(
  events: LedgerEvent[],
  currentMonth: string,
  cfg: ReconcileConfig,
): InsightFlag[] {
  const { insightComparisonMonths } = cfg;
  // Window start: the oldest month that is still "recent" (inclusive).
  const windowStart = addMonths(currentMonth, -(insightComparisonMonths - 1));

  // For each recurring merchant, track the earliest month seen and the current-month amount.
  const recurringByMerchant = new Map<
    string,
    { earliestMonth: string; representativeAmount: Cents; currentMonthAmount?: Cents }
  >();

  for (const event of events) {
    const recurringItem = event.mergedItems.find((item) => item.source === 'recurring');
    if (!recurringItem) continue;
    if (event.signedSpendCents <= 0) continue;

    const merchant = merchantFromRationale(recurringItem.rationale);
    if (!merchant) continue;

    const month = monthOf(event.occurredOn);
    const existing = recurringByMerchant.get(merchant);
    const currentMonthAmount =
      month === currentMonth ? event.signedSpendCents : existing?.currentMonthAmount;

    if (!existing || month < existing.earliestMonth) {
      recurringByMerchant.set(merchant, {
        earliestMonth: month,
        representativeAmount: event.signedSpendCents,
        currentMonthAmount,
      });
    } else {
      recurringByMerchant.set(merchant, { ...existing, currentMonthAmount });
    }
  }

  const flags: InsightFlag[] = [];

  for (const [merchant, { earliestMonth, representativeAmount, currentMonthAmount }] of recurringByMerchant) {
    if (earliestMonth >= windowStart) {
      flags.push({
        code: 'new_recurring_charge',
        message: `New recurring charge for ${merchant} detected`,
        amounts: { observedCents: currentMonthAmount ?? representativeAmount },
        basis: `new subscription first seen ${earliestMonth}, within last ${insightComparisonMonths} months`,
      });
    }
  }

  return flags;
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Derive ≥2 in-app insight flags from the rollup and ledger (FR-13).
 * Pure: reads rollup + ledger, returns InsightFlag[]. No side effects.
 */
export function deriveInsights(
  rollup: Rollup,
  ledger: ReconciledLedger,
  cfg: ReconcileConfig,
): InsightFlag[] {
  const current = latestMonth(ledger.events);
  if (!current) return [];

  return [
    ...deriveMerchantAboveAvg(ledger.events, current, cfg),
    ...deriveCategoryTrackingOver(rollup, current),
    ...deriveNewRecurringCharge(ledger.events, current, cfg),
  ];
}
