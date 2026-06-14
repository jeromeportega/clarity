import type { ClassifiedItem, LedgerEvent, MatchRecord, ReconcileInputs, ReconciledLedger } from './model';
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

  const matchMatches: MatchRecord[] = [...receiptMatches, ...orderMatches];

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
