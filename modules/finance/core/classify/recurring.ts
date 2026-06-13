import type { ClassifiedItem, LedgerEvent } from '../reconcile/model';
import type { ReconcileConfig } from '../reconcile/thresholds';
import { clampToTaxonomy, H1_TAXONOMY } from './taxonomy';

const MERCHANT_PREFIX = 'merchant: ';
const MONTHLY_DAYS = 30;

function extractMerchant(rationale: string): string | null {
  if (!rationale.startsWith(MERCHANT_PREFIX)) return null;
  const semi = rationale.indexOf(';', MERCHANT_PREFIX.length);
  return semi > 0 ? rationale.slice(MERCHANT_PREFIX.length, semi) : null;
}

function daysBetween(a: string, b: string): number {
  return Math.round(
    (new Date(b).getTime() - new Date(a).getTime()) / (1000 * 60 * 60 * 24),
  );
}

// Determine the recurring category based on the event's existing classification.
// Preserves 'Housing' (mortgage) and 'Utilities' labels; defaults to 'Subscriptions'.
function recurringCategory(event: LedgerEvent, taxonomy: readonly string[]): string {
  const existing = event.mergedItems[0]?.category;
  if (existing === 'Housing') return clampToTaxonomy('Housing', taxonomy);
  if (existing === 'Utilities') return clampToTaxonomy('Utilities', taxonomy);
  return clampToTaxonomy('Subscriptions', taxonomy);
}

export function detectRecurring(
  events: LedgerEvent[],
  cfg: ReconcileConfig,
): Map<string, ClassifiedItem> {
  const result = new Map<string, ClassifiedItem>();
  if (events.length < 2) return result;

  // Group events by merchant key (extracted from first item's rationale)
  const byMerchant = new Map<string, LedgerEvent[]>();
  for (const evt of events) {
    const rationale = evt.mergedItems[0]?.rationale ?? '';
    const merchant = extractMerchant(rationale) ?? 'unknown';
    const group = byMerchant.get(merchant) ?? [];
    group.push(evt);
    byMerchant.set(merchant, group);
  }

  for (const [merchant, group] of byMerchant) {
    if (group.length < 2) continue;

    // Sort by amount to find amount-stable subgroups
    const byAmount = [...group].sort(
      (a, b) => a.signedSpendCents - b.signedSpendCents,
    );

    // Greedy subgrouping: new subgroup when amount jumps beyond tolerance
    const subgroups: LedgerEvent[][] = [];
    let current: LedgerEvent[] = [byAmount[0]];
    subgroups.push(current);

    for (let i = 1; i < byAmount.length; i++) {
      const anchor = current[0].signedSpendCents;
      if (Math.abs(byAmount[i].signedSpendCents - anchor) <= cfg.recurringAmountToleranceCents) {
        current.push(byAmount[i]);
      } else {
        current = [byAmount[i]];
        subgroups.push(current);
      }
    }

    for (const subgroup of subgroups) {
      if (subgroup.length < 2) continue;

      // Sort by date and verify monthly cadence on all consecutive pairs
      const sorted = [...subgroup].sort((a, b) =>
        a.occurredOn.localeCompare(b.occurredOn),
      );

      const cadences: number[] = [];
      let allMonthly = true;

      for (let i = 1; i < sorted.length; i++) {
        const diff = daysBetween(sorted[i - 1].occurredOn, sorted[i].occurredOn);
        if (Math.abs(diff - MONTHLY_DAYS) > cfg.recurringCadenceToleranceDays) {
          allMonthly = false;
          break;
        }
        cadences.push(diff);
      }

      if (!allMonthly) continue;

      const avgCadence = Math.round(
        cadences.reduce((a, b) => a + b, 0) / cadences.length,
      );
      const amountDollars = (Math.abs(sorted[0].signedSpendCents) / 100).toFixed(2);

      for (const evt of sorted) {
        const category = recurringCategory(evt, H1_TAXONOMY);
        const rationale =
          `merchant: ${merchant}; recurring $${amountDollars}/mo (cadence: ~${avgCadence}d) → ${category}`;
        result.set(evt.id, {
          itemRef: {},
          category,
          rationale,
          source: 'recurring',
        });
      }
    }
  }

  return result;
}
