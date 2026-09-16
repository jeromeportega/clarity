import { similarityRatio } from '../../receipts';
import type { BankLine, MatchRecord, ReceiptView } from '../model';
import type { ReconcileConfig } from '../thresholds';
import { epochDay, lowerBound, upperBound } from './utils';

/** A bank debit with its absolute amount and day number pre-computed. */
interface IndexedDebit {
  line: BankLine;
  abs: number;
  day: number | null;
}

/**
 * Score one (receipt, bank debit) pair that has already passed the amount and
 * date gates.
 *
 * Hard gate applied here: merchantSimilarity < merchantSimilarityCutoff ⇒ null.
 *
 * Confidence = weighted sum of four signals:
 *   merchant similarity  40 %
 *   amount closeness     30 %  (1 at exact, 0 at tolerance boundary)
 *   date closeness       20 %  (1 same day, 0 at window boundary)
 *   lastFour agreement   10 %  (1 match, 0 mismatch, 0.5 unknown)
 */
function scoreReceiptBank(
  receipt: ReceiptView,
  bank: BankLine,
  cfg: ReconcileConfig,
  amountDiff: number,
  dateDiff: number,
): { confidence: number; rationale: string } | null {
  const receiptAmt = receipt.totalCents!;
  const bankAmt = Math.abs(bank.amountCents);

  const merchantSim = similarityRatio(receipt.merchant ?? '', bank.normalizedMerchant);
  if (merchantSim < cfg.merchantSimilarityCutoff) return null;

  const amountScore = cfg.tipAdjustmentToleranceCents === 0 ? 1 : 1 - amountDiff / cfg.tipAdjustmentToleranceCents;
  const dateScore = cfg.receiptDateWindowDays === 0 ? 1 : 1 - dateDiff / cfg.receiptDateWindowDays;

  let lastFourScore = 0.5;
  if (receipt.lastFour && bank.lastFour) {
    lastFourScore = receipt.lastFour === bank.lastFour ? 1 : 0;
  }

  const confidence = merchantSim * 0.4 + amountScore * 0.3 + dateScore * 0.2 + lastFourScore * 0.1;

  const lastFourNote =
    receipt.lastFour && bank.lastFour
      ? receipt.lastFour === bank.lastFour
        ? `, card ****${receipt.lastFour} matched`
        : `, card mismatch (receipt ****${receipt.lastFour} vs bank ****${bank.lastFour})`
      : '';

  const rationale =
    `Receipt ${receipt.merchant ?? '?'} (${receiptAmt}¢, ${receipt.capturedAt}) ↔ ` +
    `Bank ${bank.normalizedMerchant} (${bankAmt}¢, ${bank.postedDate}): ` +
    `merchant sim ${merchantSim.toFixed(2)}, amount diff ${amountDiff}¢, ${dateDiff} day(s) apart` +
    lastFourNote;

  return { confidence, rationale };
}

/**
 * Match every receipt to at most one bank debit line.
 *
 * Hard gates (any one fails → the pair is never scored):
 *   - receipt missing totalCents, a placeholder 0 total, or missing capturedAt
 *   - |receiptAmt - |bankAmt|| > tipAdjustmentToleranceCents
 *   - date distance > receiptDateWindowDays
 *   - merchantSimilarity < merchantSimilarityCutoff
 *
 * Bank debits are indexed by absolute amount once, so each receipt only looks
 * at the lines inside its amount window (binary search) instead of every line
 * in the household — the pair loop is O(R · k) for k candidates in-window, not
 * O(R · B) with a date parse and a string similarity per pair.
 *
 * For each receipt, all qualifying bank lines are scored; the highest-scoring
 * line wins. Each bank line is claimed by at most one receipt (highest
 * confidence receipt claims the line).
 */
export function matchReceipts(
  bank: BankLine[],
  receipts: ReceiptView[],
  cfg: ReconcileConfig,
): MatchRecord[] {
  const debits: IndexedDebit[] = bank
    .filter((b) => b.direction === 'debit')
    .map((line) => ({ line, abs: Math.abs(line.amountCents), day: epochDay(line.postedDate) }))
    .sort((a, b) => a.abs - b.abs);
  const absAmounts = debits.map((d) => d.abs);

  type Candidate = { receipt: ReceiptView; bank: BankLine; confidence: number; rationale: string };
  const candidates: Candidate[] = [];

  for (const r of receipts) {
    // No total, a placeholder total (an unreadable photo persists as 0 — never
    // a real purchase), or no date ⇒ nothing to score against.
    if (r.totalCents == null || r.totalCents === 0 || !r.capturedAt) continue;
    const receiptDay = epochDay(r.capturedAt);
    if (receiptDay === null) continue;

    const lo = lowerBound(absAmounts, r.totalCents - cfg.tipAdjustmentToleranceCents);
    const hi = upperBound(absAmounts, r.totalCents + cfg.tipAdjustmentToleranceCents);
    for (let i = lo; i < hi; i++) {
      const d = debits[i]!;
      if (d.day === null) continue;
      const dateDiff = Math.abs(d.day - receiptDay);
      if (dateDiff > cfg.receiptDateWindowDays) continue;
      const amountDiff = Math.abs(r.totalCents - d.abs);
      const score = scoreReceiptBank(r, d.line, cfg, amountDiff, dateDiff);
      if (score !== null) candidates.push({ receipt: r, bank: d.line, ...score });
    }
  }

  // Sort descending by confidence so the best matches claim bank lines first;
  // ids break ties so the result never depends on input order.
  candidates.sort(
    (a, b) =>
      b.confidence - a.confidence ||
      (a.receipt.id < b.receipt.id ? -1 : a.receipt.id > b.receipt.id ? 1 : 0) ||
      (a.bank.id < b.bank.id ? -1 : a.bank.id > b.bank.id ? 1 : 0),
  );

  const claimedBankIds = new Set<string>();
  const claimedReceiptIds = new Set<string>();
  const records: MatchRecord[] = [];

  for (const c of candidates) {
    if (claimedBankIds.has(c.bank.id)) continue;
    if (claimedReceiptIds.has(c.receipt.id)) continue;

    claimedBankIds.add(c.bank.id);
    claimedReceiptIds.add(c.receipt.id);

    const status: MatchRecord['status'] = c.confidence >= cfg.confidenceThreshold ? 'auto_linked' : 'review';

    records.push({
      id: `receipt_bank-${c.receipt.id}-${c.bank.id}`,
      type: 'receipt_bank',
      transactionId: c.bank.id,
      receiptId: c.receipt.id,
      confidence: c.confidence,
      rationale: c.rationale,
      status,
    });
  }

  return records;
}
