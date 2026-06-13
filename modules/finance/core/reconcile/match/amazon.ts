import type { BankLine, MatchRecord, OrderView } from '../model';
import type { ReconcileConfig } from '../thresholds';
import { findChargeSubset } from './subset-sum';

function daysBetween(a: string, b: string): number {
  return Math.abs(Date.parse(b) - Date.parse(a)) / 86_400_000;
}

function isAmazonLine(b: BankLine): boolean {
  return b.direction === 'debit' && b.normalizedMerchant.toUpperCase().includes('AMAZON');
}

/**
 * Match Amazon orders to bank charges.
 *
 * Strategy per order:
 *   1. Filter bank lines to AMAZON debits within ±orderDateWindowDays.
 *   2. Direct match: single line whose |amountCents| is within tipAdjustmentToleranceCents
 *      of the order total.  Pick best by smallest amount diff, then closest date.
 *      → produces type 'order_bank'.
 *   3. Split-shipment: if no direct match, call findChargeSubset on the candidate pool.
 *      If a ≥2-element subset is returned, it's a split shipment.
 *      → produces type 'order_bank_split'.
 *   4. If subset pool exceeds subsetMaxCandidates, findChargeSubset returns null
 *      and the order is not auto-linked (no record emitted, or a low-confidence
 *      review record is emitted when there is at least one in-window candidate).
 *
 * Each order is matched at most once; each bank line may be claimed by at
 * most one order (highest confidence first, same dedup as receipt matcher).
 */
export function matchAmazonOrders(
  bank: BankLine[],
  orders: OrderView[],
  cfg: ReconcileConfig,
): MatchRecord[] {
  type Scored = { order: OrderView; lines: BankLine[]; confidence: number; rationale: string; type: MatchRecord['type'] };
  const candidates: Scored[] = [];

  for (const o of orders) {
    const total = o.orderTotalCents;
    if (total == null || total <= 0) continue;

    // Pool: AMAZON debits within the date window
    const pool = bank.filter((b) => isAmazonLine(b) && daysBetween(b.postedDate, o.orderDate) <= cfg.orderDateWindowDays);

    // ── Direct match (single charge) ────────────────────────────────────────
    const directPool = pool.filter((b) => Math.abs(Math.abs(b.amountCents) - total) <= cfg.tipAdjustmentToleranceCents);

    if (directPool.length > 0) {
      // Best = smallest amount diff, tie-break by closest date
      const best = directPool.reduce<BankLine>((a, b) => {
        const diffA = Math.abs(Math.abs(a.amountCents) - total);
        const diffB = Math.abs(Math.abs(b.amountCents) - total);
        if (diffA !== diffB) return diffA < diffB ? a : b;
        return daysBetween(a.postedDate, o.orderDate) <= daysBetween(b.postedDate, o.orderDate) ? a : b;
      });

      const amountDiff = Math.abs(Math.abs(best.amountCents) - total);
      const dateDiff = daysBetween(best.postedDate, o.orderDate);
      const amountScore = 1 - amountDiff / cfg.tipAdjustmentToleranceCents;
      const dateScore = 1 - dateDiff / cfg.orderDateWindowDays;
      const confidence = amountScore * 0.6 + dateScore * 0.4;

      candidates.push({
        order: o,
        lines: [best],
        confidence,
        type: 'order_bank',
        rationale:
          `Order ${o.externalOrderId} (${total}¢, ${o.orderDate}) ↔ ` +
          `Bank ${best.normalizedMerchant} (${Math.abs(best.amountCents)}¢, ${best.postedDate}): ` +
          `amount diff ${amountDiff}¢, ${dateDiff} day(s) apart`,
      });
      continue;
    }

    // ── Split-shipment via subset sum ────────────────────────────────────────
    const subset = findChargeSubset(pool, total, cfg);
    if (subset !== null && subset.length >= 2) {
      const maxDateDiff = Math.max(...subset.map((b) => daysBetween(b.postedDate, o.orderDate)));
      const dateScore = 1 - maxDateDiff / cfg.orderDateWindowDays;
      // Exact sum → full amount score; weight date more loosely for multi-shipment.
      const confidence = 0.85 * dateScore + 0.15;

      const subsetDesc = subset.map((b) => `${b.id}(${Math.abs(b.amountCents)}¢)`).join(' + ');
      candidates.push({
        order: o,
        lines: subset,
        confidence,
        type: 'order_bank_split',
        rationale:
          `Order ${o.externalOrderId} (${total}¢, ${o.orderDate}) → split shipment: ` +
          `[${subsetDesc}] = ${total}¢`,
      });
      continue;
    }

    // Pool exceeded subsetMaxCandidates or no subset exists — not matched.
  }

  // Sort descending by confidence; claim lines greedily (highest confidence first).
  candidates.sort((a, b) => b.confidence - a.confidence);

  const claimedBankIds = new Set<string>();
  const claimedOrderIds = new Set<string>();
  const records: MatchRecord[] = [];

  for (const c of candidates) {
    if (claimedOrderIds.has(c.order.id)) continue;
    if (c.lines.some((l) => claimedBankIds.has(l.id))) continue;

    for (const l of c.lines) claimedBankIds.add(l.id);
    claimedOrderIds.add(c.order.id);

    const status: MatchRecord['status'] = c.confidence >= cfg.confidenceThreshold ? 'auto_linked' : 'review';

    records.push({
      id: `${c.type}-${c.order.id}-${c.lines.map((l) => l.id).join('+')}`,
      type: c.type,
      transactionId: c.lines[0].id,
      orderId: c.order.id,
      confidence: c.confidence,
      rationale: c.rationale,
      status,
    });
  }

  return records;
}
