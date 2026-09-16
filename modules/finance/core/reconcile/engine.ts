import type { ClassifiedItem, ConfirmedMatch, LedgerEvent, MatchRecord, ReconcileInputs, ReconciledLedger } from './model';
import { matchAmazonOrders, matchReceipts } from './match';
import { mergeCounted } from './dedup';
import { reconcileRefunds } from './refunds';
import { DEFAULT_CONFIG, type ReconcileConfig } from './thresholds';
import { HeuristicClassifier } from '../classify/classifier';
import { H1_TAXONOMY } from '../classify/taxonomy';

const classifier = new HeuristicClassifier();

/** Per-item descriptions + the owning receipt/order merchant, keyed by item id. */
interface ItemContext {
  description: string;
  merchant: string;
}

/** Index every receipt item and order item by id → its description + merchant. */
function buildItemContext(inputs: ReconcileInputs): Map<string, ItemContext> {
  const ctx = new Map<string, ItemContext>();
  for (const receipt of inputs.receipts) {
    const merchant = receipt.merchant ?? '';
    for (const item of receipt.items) {
      ctx.set(item.id, { description: item.description ?? '', merchant });
    }
  }
  for (const order of inputs.orders) {
    for (const item of order.items) {
      // Amazon is the only order source today; merchant text helps the fallback.
      ctx.set(item.id, { description: item.description, merchant: 'Amazon' });
    }
  }
  return ctx;
}

/**
 * Classify every item carried on an event's `mergedItems`, replacing the
 * placeholder `'uncategorized'` category produced by mergeCounted with a real
 * H1-taxonomy category from the heuristic classifier (story-003-005).
 *
 * The classifier keys off the item's real description + merchant (looked up from
 * the original inputs via the item ref — mergeCounted's rationale is lossy), and
 * the item's `itemRef` is preserved so downstream persistence can attribute the
 * category to the correct receipt/order item row.
 */
function classifyEvent(event: LedgerEvent, itemContext: Map<string, ItemContext>): LedgerEvent {
  if (event.mergedItems.length === 0) return event;

  const mergedItems: ClassifiedItem[] = event.mergedItems.map((item) => {
    const itemId = item.itemRef.receiptItemId ?? item.itemRef.orderItemId;
    const lookup = itemId ? itemContext.get(itemId) : undefined;
    const classified = classifier.classify(
      {
        merchant: lookup?.merchant ?? '',
        description: lookup?.description,
        amountCents: event.signedSpendCents,
      },
      H1_TAXONOMY,
    );
    return {
      ...classified,
      itemRef: item.itemRef, // preserve the item linkage from mergeCounted
    };
  });

  return { ...event, mergedItems };
}

/**
 * Honour the humans. A ConfirmedMatch says "this transaction is paid by this
 * receipt (or order)", full stop:
 *   - the candidate for that exact pair is promoted to auto_linked at
 *     confidence 1 (and synthesised if the scorer no longer proposes it);
 *   - every other candidate for that transaction is dropped;
 *   - every other candidate for that receipt / order is dropped — a receipt
 *     pays exactly one bank line.
 * Anything the scorer would otherwise have linked to those rows simply becomes
 * unmatched again; it is not re-matched here.
 */
export function applyHumanDecisions(candidates: MatchRecord[], confirmed: ConfirmedMatch[]): MatchRecord[] {
  if (confirmed.length === 0) return candidates;

  const byTransaction = new Map<string, ConfirmedMatch>();
  const confirmedReceipts = new Set<string>();
  const confirmedOrders = new Set<string>();
  for (const c of confirmed) {
    if (!c.receiptId && !c.orderId) continue; // nothing identifiable to honour
    byTransaction.set(c.transactionId, c);
    if (c.receiptId) confirmedReceipts.add(c.receiptId);
    if (c.orderId) confirmedOrders.add(c.orderId);
  }

  const out: MatchRecord[] = [];
  const honoured = new Set<string>();
  for (const m of candidates) {
    const lineIds = m.transactionIds ?? (m.transactionId ? [m.transactionId] : []);
    const decision = lineIds.map((id) => byTransaction.get(id)).find((d): d is ConfirmedMatch => d !== undefined);
    if (decision) {
      const isThePair =
        (decision.receiptId !== undefined && m.receiptId === decision.receiptId) ||
        (decision.orderId !== undefined && m.orderId === decision.orderId);
      if (!isThePair) continue;
      out.push({ ...m, status: 'auto_linked', confidence: 1, confirmedBy: 'human', rationale: `${m.rationale}; confirmed by human` });
      honoured.add(decision.transactionId);
      continue;
    }
    if ((m.receiptId && confirmedReceipts.has(m.receiptId)) || (m.orderId && confirmedOrders.has(m.orderId))) continue;
    out.push(m);
  }

  for (const d of byTransaction.values()) {
    if (honoured.has(d.transactionId)) continue;
    if (d.receiptId) {
      out.push({
        id: `receipt_bank-${d.receiptId}-${d.transactionId}`,
        type: 'receipt_bank',
        transactionId: d.transactionId,
        receiptId: d.receiptId,
        confidence: 1,
        rationale: 'Confirmed by human',
        status: 'auto_linked',
        confirmedBy: 'human',
      });
    } else if (d.orderId) {
      out.push({
        id: `order_bank-${d.orderId}-${d.transactionId}`,
        type: 'order_bank',
        transactionId: d.transactionId,
        transactionIds: [d.transactionId],
        orderId: d.orderId,
        confidence: 1,
        rationale: 'Confirmed by human',
        status: 'auto_linked',
        confirmedBy: 'human',
      });
    }
  }
  return out;
}

/**
 * Pure reconciliation entry point. Composes the full matching → dedup →
 * refund → classification pipeline over the provided inputs and returns a
 * complete `ReconciledLedger`.
 *
 * Pipeline (each stage is an existing, separately unit-tested function):
 *   1. matchReceipts / matchAmazonOrders — receipt↔bank and amazon↔bank
 *      (incl. split-shipment subset-sum) candidate matching.
 *   2. reconcileRefunds — card refunds, store-credit refunds, and partial
 *      store-credit payments; contributes additional matches + drawdowns.
 *   3. mergeCounted — collapse matches into LedgerEvents counting each dollar
 *      exactly once; yields netSpendCents and the merged item set per event.
 *   4. HeuristicClassifier — assign an H1-taxonomy category to every merged item.
 */
export function reconcile(inputs: ReconcileInputs, config?: Partial<ReconcileConfig>): ReconciledLedger {
  const cfg: ReconcileConfig = { ...DEFAULT_CONFIG, ...config };

  const receiptMatches = matchReceipts(inputs.bankLines, inputs.receipts, cfg);
  const orderMatches = matchAmazonOrders(inputs.bankLines, inputs.orders, cfg);

  const matchMatches: MatchRecord[] = applyHumanDecisions(
    [...receiptMatches, ...orderMatches],
    inputs.confirmedMatches ?? [],
  );

  // Refunds & store-credit drawdowns produce their own match records (card
  // refunds, store-credit refunds, partial-payment drawdowns) plus the
  // negative LedgerEvents and StoreCreditDrawdowns.
  const refundResult = reconcileRefunds(inputs, matchMatches);

  const allMatches: MatchRecord[] = [...matchMatches, ...refundResult.matches];
  const autoLinked = allMatches.filter((m) => m.status === 'auto_linked');
  const reviewQueue = allMatches.filter((m) => m.status === 'review');

  // mergeCounted collapses the matcher-produced purchase matches (receipt_bank /
  // order_bank / order_bank_split) into one event per anchor, counting each
  // dollar once. reconcileRefunds already emits ALL of its own events (card
  // refunds, store-credit refunds, AND partial-payment store_credit_drawdowns
  // with full goods value), so those matches must NOT be re-fed to mergeCounted —
  // doing so would double-count the drawdown spend. We therefore merge only the
  // matcher matches here and union reconcileRefunds' events in directly.
  const matcherAutoLinked = matchMatches.filter((m) => m.status === 'auto_linked');
  const itemContext = buildItemContext(inputs);
  const purchaseEvents = mergeCounted(matcherAutoLinked, inputs).map((e) =>
    classifyEvent(e, itemContext),
  );
  const events: LedgerEvent[] = [...purchaseEvents, ...refundResult.events];

  const netSpendCents = events.reduce((sum, e) => sum + e.signedSpendCents, 0);

  // Unmatched bookkeeping: any debit/receipt/order item not claimed by an
  // auto-linked match (split matches list all constituent bank-line IDs).
  const matchedBankIds = new Set(
    autoLinked.flatMap((m) => m.transactionIds ?? (m.transactionId ? [m.transactionId] : [])),
  );
  const matchedReceiptIds = new Set(autoLinked.map((m) => m.receiptId).filter((id): id is string => id != null));
  // Amazon matchers set orderId, not orderItemId; filter at the order level so all
  // items belonging to a matched order are correctly removed from unmatched.
  const matchedOrderIds = new Set(autoLinked.map((m) => m.orderId).filter((id): id is string => id != null));

  return {
    events,
    matches: autoLinked,
    reviewQueue,
    storeCreditDrawdowns: refundResult.drawdowns,
    unmatched: {
      bankLines: inputs.bankLines.filter((b) => b.direction === 'debit' && !matchedBankIds.has(b.id)).map((b) => b.id),
      receipts: inputs.receipts.filter((r) => !matchedReceiptIds.has(r.id)).map((r) => r.id),
      orderItems: inputs.orders
        .flatMap((o) => o.items.filter((item) => !item.isReturn && !matchedOrderIds.has(o.id)))
        .map((item) => item.id),
    },
    netSpendCents,
  };
}
