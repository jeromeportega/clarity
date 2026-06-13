import type { LedgerEvent, MatchRecord, ReconcileInputs, ReconciledLedger, StoreCreditDrawdown } from './model';
import { matchAmazonOrders, matchReceipts } from './match';
import { DEFAULT_CONFIG, type ReconcileConfig } from './thresholds';

// story-003-003 (mergeCounted), story-003-004 (reconcileRefunds), and story-003-005
// (HeuristicClassifier / detectRecurring / merchantFallback) are implemented by parallel
// stories.  They will be imported here at integration once those modules land:
//
//   import { mergeCounted }      from './dedup';       // story-003-003
//   import { reconcileRefunds }  from './refunds';     // story-003-004
//   import { HeuristicClassifier, detectRecurring, merchantFallback }
//                                from '../classify/classifier'; // story-003-005
//
// Until then engine.ts produces correct match data and correct unmatched bookkeeping;
// events, net-spend, and store-credit drawdowns are left empty for downstream fill-in.

/**
 * Pure reconciliation entry point.  Composes the matching pipeline and returns
 * a `ReconciledLedger` over the provided inputs.
 *
 * Events (`LedgerEvent[]`) and `netSpendCents` are populated by story-003-003's
 * `mergeCounted`; `storeCreditDrawdowns` by story-003-004's `reconcileRefunds`.
 * Both will be wired here once those modules are available.
 */
export function reconcile(inputs: ReconcileInputs, config?: Partial<ReconcileConfig>): ReconciledLedger {
  const cfg: ReconcileConfig = { ...DEFAULT_CONFIG, ...config };

  const receiptMatches = matchReceipts(inputs.bankLines, inputs.receipts, cfg);
  const orderMatches = matchAmazonOrders(inputs.bankLines, inputs.orders, cfg);

  const allMatches: MatchRecord[] = [...receiptMatches, ...orderMatches];
  const autoLinked = allMatches.filter((m) => m.status === 'auto_linked');
  const reviewQueue = allMatches.filter((m) => m.status === 'review');

  // Unmatched bookkeeping (dedup / refund modules may move items when integrated).
  const matchedBankIds = new Set(autoLinked.map((m) => m.transactionId).filter((id): id is string => id != null));
  const matchedReceiptIds = new Set(autoLinked.map((m) => m.receiptId).filter((id): id is string => id != null));
  const matchedOrderItemIds = new Set(
    autoLinked.map((m) => m.orderItemId).filter((id): id is string => id != null),
  );

  const events: LedgerEvent[] = []; // populated by story-003-003 mergeCounted
  const storeCreditDrawdowns: StoreCreditDrawdown[] = []; // populated by story-003-004

  return {
    events,
    matches: autoLinked,
    reviewQueue,
    storeCreditDrawdowns,
    unmatched: {
      bankLines: inputs.bankLines.filter((b) => b.direction === 'debit' && !matchedBankIds.has(b.id)).map((b) => b.id),
      receipts: inputs.receipts.filter((r) => !matchedReceiptIds.has(r.id)).map((r) => r.id),
      orderItems: inputs.orders
        .flatMap((o) => o.items)
        .filter((item) => !item.isReturn && !matchedOrderItemIds.has(item.id))
        .map((item) => item.id),
    },
    netSpendCents: 0, // computed by story-003-003 mergeCounted
  };
}
