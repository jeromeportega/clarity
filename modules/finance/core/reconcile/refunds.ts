import { similarityRatio } from '../receipts';
import {
  bankSignToSignedSpend,
  type BankLine,
  type LedgerEvent,
  type MatchRecord,
  type ReconcileInputs,
  type ReceiptView,
  type StoreCreditAccrual,
  type StoreCreditDrawdown,
} from './model';
import { daysBetween } from './match/utils';
import { availableAccrualCents, findAccrualForReturn } from './store-credit';
import { DEFAULT_CONFIG } from './thresholds';

// Priority order for selecting which kind of store credit to draw from.
const SC_KIND_PRIORITY: StoreCreditAccrual['kind'][] = [
  'gift_card',
  'store_credit',
  'account_balance',
];

/**
 * Reconcile refunds and store-credit drawdowns.
 *
 * Three concerns handled here:
 *
 *   1. **Card refunds** (FR-6): each bank CREDIT line → signed-negative
 *      LedgerEvent (value returning to the household).
 *
 *   2. **Store-credit refunds** (FR-7): return order items with
 *      refundDestination ∈ {store_credit, gift_card, account_balance} are
 *      linked to their originating StoreCreditAccrual via
 *      MatchRecord.storeCreditBalanceId.  These matches must NEVER appear in
 *      ReconciledLedger.unmatched.
 *
 *   3. **Partial store-credit payments** (FR-8): when a bank debit is smaller
 *      than the receipt total and the gap is explainable by available
 *      store-credit accrual, a negative StoreCreditDrawdown is emitted for
 *      the gap and the full goods value is recorded as spend (ADR-005).
 *      An over-drawdown (gap > available accrual) routes to review rather
 *      than writing a negative balance.
 */
export function reconcileRefunds(
  inputs: ReconcileInputs,
  matches: MatchRecord[],
): {
  events: LedgerEvent[];
  drawdowns: StoreCreditDrawdown[];
  matches: MatchRecord[];
} {
  const cfg = DEFAULT_CONFIG;
  const newMatches: MatchRecord[] = [];
  const events: LedgerEvent[] = [];
  const drawdowns: StoreCreditDrawdown[] = [];

  // ── 1. Card refunds: bank CREDIT lines → negative LedgerEvent ─────────────
  for (const creditLine of inputs.bankLines.filter((b) => b.direction === 'credit')) {
    const signedSpend = bankSignToSignedSpend(creditLine.amountCents); // < 0

    newMatches.push({
      id: `refund_card-${creditLine.id}`,
      type: 'refund_card',
      transactionId: creditLine.id,
      confidence: 0.9,
      rationale:
        `Bank CREDIT ${creditLine.normalizedMerchant} (${creditLine.amountCents}¢, ` +
        `${creditLine.postedDate}): card refund`,
      status: 'auto_linked',
    });

    events.push({
      id: `refund-card-${creditLine.id}`,
      signedSpendCents: signedSpend,
      occurredOn: creditLine.postedDate,
      fundedBy: 'bank',
      sources: { transactionId: creditLine.id },
      mergedItems: [],
    });
  }

  // ── 2. Store-credit refunds: return order items → accrual link ─────────────
  for (const order of inputs.orders) {
    for (const item of order.items) {
      if (!item.isReturn) continue;
      const dest = item.refundDestination;
      if (!dest || dest === 'card') continue;
      // dest ∈ 'store_credit' | 'gift_card' | 'account_balance'

      const kind = dest as StoreCreditAccrual['kind'];
      const accrual = findAccrualForReturn(inputs.storeCreditAccruals, {
        orderId: order.id,
        orderItemId: item.id,
        amountCents: item.amountCents,
        kind,
      });

      const refundCents = Math.abs(item.amountCents);
      const signedSpend = -refundCents; // < 0 (value returning)

      newMatches.push({
        id: `store_credit_refund-${order.id}-${item.id}`,
        type: 'store_credit_refund',
        orderId: order.id,
        orderItemId: item.id,
        storeCreditBalanceId: accrual?.id,
        confidence: accrual ? 0.95 : 0.75,
        rationale: accrual
          ? `Return ${item.description} (${item.amountCents}¢) linked to ${kind} accrual ${accrual.id}`
          : `Return ${item.description} (${item.amountCents}¢) — no matching accrual; ${kind} refund assumed`,
        status: 'auto_linked',
      });

      events.push({
        id: `refund-sc-${order.id}-${item.id}`,
        signedSpendCents: signedSpend,
        occurredOn: order.orderDate,
        fundedBy: 'store_credit',
        sources: { orderId: order.id },
        mergedItems: [],
      });
    }
  }

  // ── 3. Partial store-credit payments: bank debit < receipt total ───────────
  // Build the set of already-matched bank IDs and receipt IDs so we only search
  // among genuinely unmatched pairs.
  const matchedBankIds = new Set<string>(
    [...matches, ...newMatches].flatMap(
      (m) => m.transactionIds ?? (m.transactionId ? [m.transactionId] : []),
    ),
  );
  const matchedReceiptIds = new Set<string>(
    [...matches, ...newMatches]
      .map((m) => m.receiptId)
      .filter((id): id is string => id != null),
  );

  const unmatchedDebits = inputs.bankLines.filter(
    (b) => b.direction === 'debit' && !matchedBankIds.has(b.id),
  );
  const unmatchedReceipts = inputs.receipts.filter(
    (r) => !matchedReceiptIds.has(r.id) && r.totalCents != null && r.capturedAt != null,
  );

  type PartialCandidate = {
    bank: BankLine;
    receipt: ReceiptView;
    gap: number;
    confidence: number;
    rationale: string;
  };

  const partialCandidates: PartialCandidate[] = [];

  for (const bank of unmatchedDebits) {
    for (const receipt of unmatchedReceipts) {
      if (!receipt.capturedAt || receipt.totalCents == null) continue;

      const bankAbs = Math.abs(bank.amountCents);
      if (bankAbs >= receipt.totalCents) continue; // bank covers the full receipt — not this case

      const gap = receipt.totalCents - bankAbs;
      const merchantSim = similarityRatio(bank.normalizedMerchant, receipt.merchant ?? '');
      if (merchantSim < cfg.merchantSimilarityCutoff) continue;

      const dateDiff = daysBetween(bank.postedDate, receipt.capturedAt);
      if (dateDiff > cfg.receiptDateWindowDays) continue;

      const dateScore = cfg.receiptDateWindowDays === 0 ? 1 : 1 - dateDiff / cfg.receiptDateWindowDays;
      const confidence = merchantSim * 0.6 + dateScore * 0.4;

      partialCandidates.push({
        bank,
        receipt,
        gap,
        confidence,
        rationale:
          `Partial store-credit payment: ${bank.normalizedMerchant} bank ${bankAbs}¢ ` +
          `+ store credit ${gap}¢ = receipt ${receipt.totalCents}¢`,
      });
    }
  }

  // Highest confidence first; greedy claim — each bank line and receipt claimed once.
  // Tiebreaker by IDs ensures deterministic ordering on equal-confidence candidates.
  partialCandidates.sort(
    (a, b) =>
      b.confidence - a.confidence ||
      a.bank.id.localeCompare(b.bank.id) ||
      a.receipt.id.localeCompare(b.receipt.id),
  );

  // Track remaining accrual within this reconcile run.
  const remainingByKind = new Map<StoreCreditAccrual['kind'], number>(
    SC_KIND_PRIORITY.map((k) => [k, availableAccrualCents(inputs.storeCreditAccruals, k)]),
  );

  const claimedBankIds = new Set<string>();
  const claimedReceiptIds = new Set<string>();

  for (const cand of partialCandidates) {
    if (claimedBankIds.has(cand.bank.id)) continue;
    if (claimedReceiptIds.has(cand.receipt.id)) continue;

    const { bank, receipt, gap } = cand;

    // Find the first kind with sufficient remaining accrual to cover the gap.
    let chosenKind: StoreCreditAccrual['kind'] | null = null;
    let chosenAccrual: StoreCreditAccrual | undefined;

    for (const kind of SC_KIND_PRIORITY) {
      if ((remainingByKind.get(kind) ?? 0) >= gap) {
        chosenKind = kind;
        // Decouple from single-record sufficiency: the net-sum guard above already
        // validated that enough accrual exists across all records for this kind.
        // Pick the largest positive accrual as the audit-trail pointer — it may be
        // a partial pointer when the gap is covered by several smaller accruals.
        chosenAccrual = [...inputs.storeCreditAccruals]
          .filter((a) => a.kind === kind && a.amountCents > 0)
          .sort((a, b) => b.amountCents - a.amountCents)[0];
        break;
      }
    }

    const matchId = `store_credit_drawdown-${bank.id}-${receipt.id}`;

    if (chosenKind === null) {
      // Over-drawdown guard: route to review, write NO negative balance (Security Model).
      // Claim the pair so no later (lower-confidence) candidate can double-count them.
      claimedBankIds.add(bank.id);
      claimedReceiptIds.add(receipt.id);
      newMatches.push({
        id: matchId,
        type: 'store_credit_drawdown',
        transactionId: bank.id,
        receiptId: receipt.id,
        confidence: cand.confidence,
        rationale:
          `${cand.rationale} — insufficient accrual (${gap}¢ needed); routed to review`,
        status: 'review',
      });
      continue;
    }

    claimedBankIds.add(bank.id);
    claimedReceiptIds.add(receipt.id);
    remainingByKind.set(chosenKind, (remainingByKind.get(chosenKind) ?? 0) - gap);

    const matchStatus: MatchRecord['status'] =
      cand.confidence >= cfg.confidenceThreshold ? 'auto_linked' : 'review';

    newMatches.push({
      id: matchId,
      type: 'store_credit_drawdown',
      transactionId: bank.id,
      receiptId: receipt.id,
      storeCreditBalanceId: chosenAccrual?.id,
      confidence: cand.confidence,
      rationale: cand.rationale,
      status: matchStatus,
    });

    // Negative drawdown for the store-credit portion.
    drawdowns.push({
      id: `drawdown-${bank.id}-${receipt.id}`,
      kind: chosenKind,
      amountCents: -gap, // < 0
      occurredAt: bank.postedDate,
      reason: 'partial_payment',
    });

    // Full goods value in the event per ADR-005 (funding-source-agnostic spend).
    // fundedBy: 'bank' is the only valid discriminated-union variant available
    // here — 'store_credit' requires sources.orderId which partial payments lack,
    // and 'split' likewise requires orderId. The bank line is the primary anchor.
    events.push({
      id: `sc-partial-${bank.id}-${receipt.id}`,
      signedSpendCents: receipt.totalCents ?? 0, // full receipt value
      occurredOn: bank.postedDate,
      fundedBy: 'bank',
      sources: {
        transactionId: bank.id,
        receiptId: receipt.id,
      },
      mergedItems: [],
    });
  }

  return { events, drawdowns, matches: newMatches };
}
