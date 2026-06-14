import type { Cents } from './money';
import type { ExtractedReceipt } from './vision/vision-provider';

export interface ReconcileResult {
  ok: boolean;
  computedTotalCents: Cents;
  printedTotalCents: Cents | null;
  deltaCents: number;
}

// FR-15 arithmetic check, in integer cents end-to-end — float math would defeat
// the exact ±tolerance comparison. The computed total is
//   Σ linePrice − Σ discount + tax + Σ fees
// where linePrice is signed (a return is negative) and fees include CRV / bag /
// bottle. `ok` is true only when a total was printed AND the magnitude of the
// delta is within tolerance. A receipt with no printed total can never
// reconcile, so it is deterministically `ok: false`; its delta is reported
// against a printed value of 0 so the field is always a real number.
export function reconcile(r: ExtractedReceipt, toleranceCents: number): ReconcileResult {
  const sumLine = r.lineItems.reduce((acc, li) => acc + li.linePrice, 0);
  const sumDiscount = r.lineItems.reduce((acc, li) => acc + li.discount, 0);
  const sumFees = r.fees.reduce((acc, f) => acc + f.amount, 0);

  const computedTotalCents = sumLine - sumDiscount + (r.tax ?? 0) + sumFees;
  const printedTotalCents = r.total;
  const deltaCents = computedTotalCents - (printedTotalCents ?? 0);
  const ok = printedTotalCents !== null && Math.abs(deltaCents) <= toleranceCents;

  return { ok, computedTotalCents, printedTotalCents, deltaCents };
}
