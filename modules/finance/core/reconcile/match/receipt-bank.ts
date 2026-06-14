import { similarityRatio } from '../../receipts';
import type { BankLine, MatchRecord, ReceiptView } from '../model';
import type { ReconcileConfig } from '../thresholds';
import { daysBetween } from './utils';

/**
 * Attempt to match `receipt` to one bank debit line.
 *
 * Hard gates (any one fails → no match):
 *   - receipt missing totalCents or capturedAt
 *   - |receiptAmt - |bankAmt|| > tipAdjustmentToleranceCents
 *   - date distance > receiptDateWindowDays
 *   - merchantSimilarity < merchantSimilarityCutoff
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
): { confidence: number; rationale: string } | null {
  if (receipt.totalCents == null || !receipt.capturedAt) return null;
  if (bank.direction !== 'debit') return null;

  const receiptAmt = receipt.totalCents;
  const bankAmt = Math.abs(bank.amountCents);
  const amountDiff = Math.abs(receiptAmt - bankAmt);
  if (amountDiff > cfg.tipAdjustmentToleranceCents) return null;

  const dateDiff = daysBetween(receipt.capturedAt, bank.postedDate);
  if (dateDiff > cfg.receiptDateWindowDays) return null;

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
 * For each receipt, all qualifying bank lines are scored; the highest-scoring
 * line wins.  Each bank line is claimed by at most one receipt (first come,
 * first served by confidence order — highest confidence receipt claims the
 * line).
 */
export function matchReceipts(
  bank: BankLine[],
  receipts: ReceiptView[],
  cfg: ReconcileConfig,
): MatchRecord[] {
  // Score every (receipt, bank) pair.
  type Candidate = { receipt: ReceiptView; bank: BankLine; confidence: number; rationale: string };
  const candidates: Candidate[] = [];

  for (const r of receipts) {
    for (const b of bank) {
      const score = scoreReceiptBank(r, b, cfg);
      if (score !== null) {
        candidates.push({ receipt: r, bank: b, ...score });
      }
    }
  }

  // Sort descending by confidence so the best matches claim bank lines first.
  candidates.sort((a, b) => b.confidence - a.confidence);

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
