import { randomUUID } from 'node:crypto';

import { and, eq, inArray } from 'drizzle-orm';

import type { FinanceDb } from '../../db/client';
import { categories, matches, orderItems, orders, receiptItems, receipts } from '../../db/schema';
import type { MatchRecord, ReconciledLedger } from './model';

export interface ReconcileSink {
  persist(householdId: string, ledger: ReconciledLedger): Promise<void>;
}

/**
 * Accumulates a ledger in memory. Used by the gate to assert on reconciliation
 * output without requiring a live database.
 */
export class InMemorySink implements ReconcileSink {
  private _ledgers: Map<string, ReconciledLedger> = new Map();

  async persist(householdId: string, ledger: ReconciledLedger): Promise<void> {
    this._ledgers.set(householdId, ledger);
  }

  get(householdId: string): ReconciledLedger | undefined {
    return this._ledgers.get(householdId);
  }

  clear(): void {
    this._ledgers.clear();
  }
}

// DB matches.status enum ← engine MatchRecord.status.
// 'auto_linked' purchases land as 'matched' (confirmed at the read layer);
// 'review' candidates land as 'pending' (ambiguous at the read layer).
function dbStatus(status: MatchRecord['status']): 'matched' | 'pending' {
  return status === 'auto_linked' ? 'matched' : 'pending';
}

// Engine confidence is a normalized float [0,1]; the DB / live read layer
// contract (live.ts) stores integer percentage [0,100] and divides by 100 on read.
function toDbConfidence(confidence: number): number {
  return Math.round(confidence * 100);
}

/**
 * Persist a reconciled ledger to the DB.
 *
 * Writes three things, all idempotent (safe to re-run):
 *   1. categories — upsert one row per H1-taxonomy category that appears on a
 *      classified item (the taxonomy source of truth `assembleBreakdown` joins).
 *   2. receipt_items.category_id — stamp each classified receipt item with its
 *      category so the true-spend item drill-down resolves.
 *   3. matches — one item-level row per (transaction, order/receipt item) link,
 *      carrying status / confidence / method / rationale. Deterministic ids keyed
 *      on the engine match id + item id make re-runs onConflictDoNothing no-ops.
 */
export class DrizzleReconcileSink implements ReconcileSink {
  constructor(private readonly _db: FinanceDb) {}

  async persist(householdId: string, ledger: ReconciledLedger): Promise<void> {
    const db = this._db;

    // ── 1. Resolve / upsert categories for every classified item category ──────
    const categoryNames = new Set<string>();
    for (const event of ledger.events) {
      for (const item of event.mergedItems) categoryNames.add(item.category);
    }
    const categoryIdByName = await this.ensureCategories(categoryNames);

    // ── 2. Stamp receipt_items.category_id from classified items ───────────────
    // Build the desired category per receipt item from the classified events,
    // scoped to receipt items that actually belong to this household.
    const categoryByReceiptItem = new Map<string, string>();
    for (const event of ledger.events) {
      for (const item of event.mergedItems) {
        const riId = item.itemRef.receiptItemId;
        if (riId) categoryByReceiptItem.set(riId, item.category);
      }
    }
    await this.stampReceiptItemCategories(householdId, categoryByReceiptItem, categoryIdByName);

    // ── 3. Persist item-level matches ──────────────────────────────────────────
    const rows = await this.buildMatchRows(householdId, ledger);
    if (rows.length > 0) {
      // onConflictDoNothing on the PK keeps re-runs idempotent.
      await db.insert(matches).values(rows).onConflictDoNothing();
    }
  }

  /** Upsert categories by name; return a name→id map covering all requested names. */
  private async ensureCategories(names: Set<string>): Promise<Map<string, string>> {
    const db = this._db;
    const map = new Map<string, string>();
    if (names.size === 0) return map;

    const existing = await db
      .select({ id: categories.id, name: categories.name })
      .from(categories)
      .where(inArray(categories.name, [...names]));
    for (const row of existing) map.set(row.name, row.id);

    const toInsert = [...names].filter((n) => !map.has(n));
    if (toInsert.length > 0) {
      const values = toInsert.map((name) => ({ id: randomUUID(), name }));
      // ux_categories_name makes this idempotent across concurrent/repeat seeds.
      await db.insert(categories).values(values).onConflictDoNothing();
      // Re-read to pick up both our inserts and any rows a concurrent run added.
      const reread = await db
        .select({ id: categories.id, name: categories.name })
        .from(categories)
        .where(inArray(categories.name, toInsert));
      for (const row of reread) map.set(row.name, row.id);
    }

    return map;
  }

  /** Set receipt_items.category_id for classified receipt items in this household. */
  private async stampReceiptItemCategories(
    householdId: string,
    categoryByReceiptItem: Map<string, string>,
    categoryIdByName: Map<string, string>,
  ): Promise<void> {
    if (categoryByReceiptItem.size === 0) return;
    const db = this._db;

    // Only touch receipt items that belong to this household (defense-in-depth).
    const ownRows = await db
      .select({ id: receiptItems.id })
      .from(receiptItems)
      .innerJoin(receipts, eq(receiptItems.receiptId, receipts.id))
      .where(
        and(
          eq(receipts.householdId, householdId),
          inArray(receiptItems.id, [...categoryByReceiptItem.keys()]),
        ),
      );
    const ownIds = new Set(ownRows.map((r) => r.id));

    for (const [riId, categoryName] of categoryByReceiptItem) {
      if (!ownIds.has(riId)) continue;
      const categoryId = categoryIdByName.get(categoryName);
      if (!categoryId) continue;
      await db
        .update(receiptItems)
        .set({ categoryId })
        .where(eq(receiptItems.id, riId));
    }
  }

  /**
   * Expand engine MatchRecords (receipt/order anchored) into item-level DB rows.
   * Receipt matches fan out to receipt_items; order matches to non-return
   * order_items. Each row gets a deterministic id so re-runs are no-ops.
   */
  private async buildMatchRows(
    householdId: string,
    ledger: ReconciledLedger,
  ): Promise<Array<typeof matches.$inferInsert>> {
    const db = this._db;
    const all: MatchRecord[] = [...ledger.matches, ...ledger.reviewQueue];

    const receiptIds = new Set<string>();
    const orderIds = new Set<string>();
    for (const m of all) {
      if (m.receiptId) receiptIds.add(m.receiptId);
      if (m.orderId) orderIds.add(m.orderId);
    }

    // Resolve receipt → receipt-item ids, order → non-return order-item ids,
    // both scoped to this household so cross-household data never leaks in.
    const receiptItemsByReceipt = new Map<string, string[]>();
    if (receiptIds.size > 0) {
      const riRows = await db
        .select({ id: receiptItems.id, receiptId: receiptItems.receiptId })
        .from(receiptItems)
        .innerJoin(receipts, eq(receiptItems.receiptId, receipts.id))
        .where(
          and(eq(receipts.householdId, householdId), inArray(receiptItems.receiptId, [...receiptIds])),
        );
      for (const row of riRows) {
        const list = receiptItemsByReceipt.get(row.receiptId) ?? [];
        list.push(row.id);
        receiptItemsByReceipt.set(row.receiptId, list);
      }
    }

    const orderItemsByOrder = new Map<string, string[]>();
    if (orderIds.size > 0) {
      const oiRows = await db
        .select({ id: orderItems.id, orderId: orderItems.orderId, isReturn: orderItems.isReturn })
        .from(orderItems)
        .innerJoin(orders, eq(orderItems.orderId, orders.id))
        .where(and(eq(orders.householdId, householdId), inArray(orderItems.orderId, [...orderIds])));
      for (const row of oiRows) {
        if (row.isReturn) continue;
        const list = orderItemsByOrder.get(row.orderId) ?? [];
        list.push(row.id);
        orderItemsByOrder.set(row.orderId, list);
      }
    }

    const rows: Array<typeof matches.$inferInsert> = [];
    const seen = new Set<string>();

    function push(row: typeof matches.$inferInsert): void {
      if (seen.has(row.id)) return;
      seen.add(row.id);
      rows.push(row);
    }

    for (const m of all) {
      const transactionId = m.transactionId;
      if (!transactionId) continue; // DB requires a non-null transaction anchor

      const status = dbStatus(m.status);
      const confidence = toDbConfidence(m.confidence);
      const base = {
        transactionId,
        status,
        confidence,
        method: m.type,
        rationale: m.rationale,
        storeCreditBalanceId: m.storeCreditBalanceId ?? null,
      } as const;

      const orderItemIds = m.orderId ? orderItemsByOrder.get(m.orderId) ?? [] : [];
      const receiptItemIds = m.receiptId ? receiptItemsByReceipt.get(m.receiptId) ?? [] : [];

      if (orderItemIds.length === 0 && receiptItemIds.length === 0) {
        // No resolvable item rows (e.g. order with only return items) — record the
        // transaction-level link so listMatches still surfaces it.
        push({ id: `m-${m.id}`, orderItemId: null, receiptItemId: null, ...base });
        continue;
      }

      // When both sides resolve, pair them positionally so a single row carries
      // BOTH orderItemId and receiptItemId — the join true-spend's order drill-down
      // needs. Otherwise fan out over whichever side resolved.
      if (orderItemIds.length > 0 && receiptItemIds.length > 0) {
        const n = Math.max(orderItemIds.length, receiptItemIds.length);
        for (let i = 0; i < n; i++) {
          const oi = orderItemIds[i] ?? null;
          const ri = receiptItemIds[i] ?? null;
          push({ id: `m-${m.id}-${oi ?? 'x'}-${ri ?? 'x'}`, orderItemId: oi, receiptItemId: ri, ...base });
        }
      } else if (orderItemIds.length > 0) {
        for (const oi of orderItemIds) {
          push({ id: `m-${m.id}-oi-${oi}`, orderItemId: oi, receiptItemId: null, ...base });
        }
      } else {
        for (const ri of receiptItemIds) {
          push({ id: `m-${m.id}-ri-${ri}`, orderItemId: null, receiptItemId: ri, ...base });
        }
      }
    }

    return rows;
  }
}
