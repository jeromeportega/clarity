import type { BankLine, ClassifiedItem, LedgerEvent, MatchRecord, ReconcileInputs } from './model';
import { bankSignToSignedSpend } from './model';

/**
 * Merge matched records into one LedgerEvent per anchored transaction,
 * counting each dollar exactly once (FR-5, NFR-4).
 *
 * Anchor precedence (ADR-002, frozen):
 *   bank line > store-credit ledger row > receipt total
 *
 * A receipt + order matched to the same bank line produce a single event:
 * the dollar is taken from the bank line once; item refs from both sources
 * are unioned into mergedItems.
 */
export function mergeCounted(matches: MatchRecord[], inputs: ReconcileInputs): LedgerEvent[] {
  const bankLineMap = new Map(inputs.bankLines.map((b) => [b.id, b]));
  const orderMap = new Map(inputs.orders.map((o) => [o.id, o]));
  const receiptMap = new Map(inputs.receipts.map((r) => [r.id, r]));
  const storeCreditMap = new Map(inputs.storeCreditAccruals.map((s) => [s.id, s]));

  type Group = {
    transactionId?: string;
    transactionIds?: string[]; // split-shipment constituent lines
    storeCreditBalanceId?: string;
    receiptIds: Set<string>;
    orderIds: Set<string>;
  };

  // Groups keyed by anchor. Separate maps enforce anchor precedence at build time.
  const bankGroups = new Map<string, Group>(); // key = single transactionId
  const splitGroups = new Map<string, Group>(); // key = sorted transactionIds joined by '\0'
  const scGroups = new Map<string, Group>(); // key = storeCreditBalanceId

  // Track which orderIds are already claimed by a bank anchor so that a
  // store-credit match for the same order is not emitted as a second event
  // (bank line > store-credit precedence).
  const orderIdsClaimedByBank = new Set<string>();

  // 'dedup_merge' is excluded: it has no explicit anchor semantics here and must
  // be resolved by the caller into one of the standard anchor types before being
  // passed to mergeCounted. TODO: add explicit handling when semantics are defined.
  const purchaseTypes = new Set<MatchRecord['type']>([
    'receipt_bank',
    'order_bank',
    'order_bank_split',
    'store_credit_drawdown',
  ]);

  for (const match of matches) {
    if (!purchaseTypes.has(match.type)) continue;

    if (match.type === 'order_bank_split') {
      // Split shipment: multiple bank lines for one order.
      const ids = match.transactionIds?.length
        ? match.transactionIds
        : match.transactionId
          ? [match.transactionId]
          : [];
      if (!ids.length) continue;
      const sortedIds = [...ids].sort();
      // Use null byte as delimiter — cannot appear in IDs, avoids collisions on IDs containing commas.
      const key = sortedIds.join('\0');
      let group = splitGroups.get(key);
      if (!group) {
        group = { transactionIds: sortedIds, receiptIds: new Set(), orderIds: new Set() };
        splitGroups.set(key, group);
      }
      if (match.receiptId) group.receiptIds.add(match.receiptId);
      if (match.orderId) {
        group.orderIds.add(match.orderId);
        orderIdsClaimedByBank.add(match.orderId);
      }
    } else if (match.transactionId) {
      // Single bank line anchor (receipt_bank, order_bank).
      const key = match.transactionId;
      let group = bankGroups.get(key);
      if (!group) {
        group = { transactionId: key, receiptIds: new Set(), orderIds: new Set() };
        bankGroups.set(key, group);
      }
      if (match.receiptId) group.receiptIds.add(match.receiptId);
      if (match.orderId) {
        group.orderIds.add(match.orderId);
        orderIdsClaimedByBank.add(match.orderId);
      }
    } else if (match.storeCreditBalanceId) {
      // Store-credit anchor: fully SC-funded purchase (no bank line).
      const key = match.storeCreditBalanceId;
      let group = scGroups.get(key);
      if (!group) {
        group = { storeCreditBalanceId: key, receiptIds: new Set(), orderIds: new Set() };
        scGroups.set(key, group);
      }
      if (match.receiptId) group.receiptIds.add(match.receiptId);
      if (match.orderId) group.orderIds.add(match.orderId);
    }
  }

  function buildItems(group: Group): ClassifiedItem[] {
    const items: ClassifiedItem[] = [];

    for (const receiptId of group.receiptIds) {
      const r = receiptMap.get(receiptId);
      if (!r) continue;
      for (const item of r.items) {
        items.push({
          itemRef: { receiptItemId: item.id },
          category: 'uncategorized',
          rationale: `receipt item from ${r.merchant ?? 'unknown merchant'}`,
          source: 'merchant_fallback',
        });
      }
    }

    for (const orderId of group.orderIds) {
      const o = orderMap.get(orderId);
      if (!o) continue;
      for (const item of o.items) {
        if (item.isReturn) continue;
        items.push({
          itemRef: { orderItemId: item.id },
          category: 'uncategorized',
          rationale: `order item: ${item.description}`,
          source: 'merchant_fallback',
        });
      }
    }

    return items;
  }

  // Deterministic primary orderId: lexicographic minimum of all collected orderIds.
  // Avoids non-determinism from match iteration order.
  function primaryOrderId(group: Group): string | undefined {
    return group.orderIds.size > 0 ? [...group.orderIds].sort()[0] : undefined;
  }

  const events: LedgerEvent[] = [];

  // ── Bank-anchored events (single line) ───────────────────────────────────────
  for (const group of bankGroups.values()) {
    const bankLine = bankLineMap.get(group.transactionId!);
    if (!bankLine) continue;

    const firstReceiptId = group.receiptIds.size > 0 ? [...group.receiptIds][0] : undefined;

    events.push({
      id: `led-bank-${bankLine.id}`,
      signedSpendCents: bankSignToSignedSpend(bankLine.amountCents),
      occurredOn: bankLine.postedDate,
      fundedBy: 'bank',
      sources: {
        transactionId: bankLine.id,
        orderId: primaryOrderId(group),
        receiptId: firstReceiptId,
      },
      mergedItems: buildItems(group),
    });
  }

  // ── Bank-anchored events (split shipment) ────────────────────────────────────
  for (const group of splitGroups.values()) {
    const bankLines = (group.transactionIds ?? [])
      .map((id) => bankLineMap.get(id))
      .filter((b): b is BankLine => b != null);
    // Skip if any constituent bank line is missing — a partial set would silently under-count.
    if (bankLines.length !== (group.transactionIds ?? []).length) continue;

    const totalAmountCents = bankLines.reduce((sum, b) => sum + b.amountCents, 0);
    const earliest = bankLines.reduce((a, b) => (a.postedDate <= b.postedDate ? a : b));
    const firstReceiptId = group.receiptIds.size > 0 ? [...group.receiptIds][0] : undefined;

    events.push({
      id: `led-split-${group.transactionIds!.join('+')}`,
      signedSpendCents: bankSignToSignedSpend(totalAmountCents),
      occurredOn: earliest.postedDate,
      fundedBy: 'bank',
      sources: {
        transactionId: earliest.id,
        orderId: primaryOrderId(group),
        receiptId: firstReceiptId,
      },
      mergedItems: buildItems(group),
    });
  }

  // ── Store-credit-anchored events (no bank line, fully SC-funded) ──────────────
  for (const group of scGroups.values()) {
    // Bank line > store-credit precedence: suppress SC event if ANY linked order was
    // claimed by a bank anchor. Check all orderIds, not just the first, to avoid
    // false positives when multiple orders are linked to the same SC balance.
    if ([...group.orderIds].some((id) => orderIdsClaimedByBank.has(id))) continue;

    const accrual = storeCreditMap.get(group.storeCreditBalanceId!);
    if (!accrual) continue;

    const orderId = primaryOrderId(group) ?? accrual.orderId;
    if (!orderId) continue; // store_credit LedgerEvent requires orderId in sources

    const firstReceiptId = group.receiptIds.size > 0 ? [...group.receiptIds][0] : undefined;

    // StoreCreditAccrual.amountCents is positive (value accrued, not a drawdown).
    // signedSpendCents > 0 means money was consumed from the SC balance.
    events.push({
      id: `led-sc-${group.storeCreditBalanceId}`,
      signedSpendCents: accrual.amountCents,
      occurredOn: accrual.occurredAt,
      fundedBy: 'store_credit',
      sources: {
        orderId,
        receiptId: firstReceiptId,
      },
      mergedItems: buildItems(group),
    });
  }

  return events;
}
