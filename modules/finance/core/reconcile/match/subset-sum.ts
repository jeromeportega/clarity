import type { BankLine, Cents } from '../model';
import type { ReconcileConfig } from '../thresholds';

/**
 * Bounded depth-first search for a subset of `candidates` whose absolute
 * amounts sum exactly to `targetCents`.
 *
 * Returns the matching subset (≥1 element) or null when:
 *   - `candidates.length > cfg.subsetMaxCandidates` (bounds guard, ADR-003)
 *   - No subset sums to the target
 *
 * Pre-condition: the caller has already filtered `candidates` to the relevant
 * date window and approximate amount range.  This function only checks the
 * hard candidate-count bound and performs the exact-sum DFS.
 */
export function findChargeSubset(
  candidates: BankLine[],
  targetCents: Cents,
  cfg: ReconcileConfig,
): BankLine[] | null {
  if (candidates.length === 0) return null;
  if (candidates.length > cfg.subsetMaxCandidates) return null;

  function dfs(start: number, remaining: Cents, chosen: BankLine[]): BankLine[] | null {
    if (remaining === 0) return chosen;
    if (start >= candidates.length) return null;

    for (let i = start; i < candidates.length; i++) {
      const amt = Math.abs(candidates[i].amountCents);
      if (amt <= remaining) {
        const result = dfs(i + 1, remaining - amt, [...chosen, candidates[i]]);
        if (result !== null) return result;
      }
    }
    return null;
  }

  return dfs(0, targetCents, []);
}
