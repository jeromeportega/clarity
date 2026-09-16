import { and, eq, inArray, isNull, like } from 'drizzle-orm';

import type { FinanceDb } from '../../db/client';
import {
  accounts,
  categories,
  categoryIdFor,
  matches,
  orderItems,
  orders,
  receiptItems,
  receipts,
  transactions,
} from '../../db/schema';
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

/** The transaction handle drizzle hands the `db.transaction` callback. */
type Tx = Parameters<Parameters<FinanceDb['transaction']>[0]>[0];
type MatchRow = typeof matches.$inferInsert;

/**
 * Every row the sink writes carries this id prefix. Ownership is the prefix
 * plus an engine status: rows that are `m-…` AND `matched` / `pending` belong
 * to the engine and are re-derived on every run; a `manual` or `rejected` row
 * is a human's, whatever its id, and is never touched.
 */
export const ENGINE_MATCH_ID_PREFIX = 'm-';
const ENGINE_OWNED_STATUSES = ['matched', 'pending'] as const;
const CHUNK = 200;

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

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

/**
 * Persist a reconciled ledger to the DB, in ONE transaction.
 *
 * The engine's output is a function of (the household's data + the humans'
 * decisions), so the rows derived from it are re-derived on every run:
 *
 *   1. categories — resolve one row per taxonomy category on a classified item.
 *   2. receipt_items.category_id — stamp classified receipt items that have NO
 *      category yet. The heuristic classifier is the fallback of last resort:
 *      it never overwrites the SKU resolver's answer or a human's correction.
 *   3. matches — the engine's rows are SYNCED, not appended: rows the engine
 *      still produces are inserted or updated (status, confidence, rationale
 *      follow the engine), rows it no longer produces are deleted, so a match
 *      the engine has retracted cannot linger and count a dollar twice.
 *      Human rows (`manual`, `rejected`) are never touched, and no `pending`
 *      candidate is written for a transaction a human has already settled.
 *
 *      Granularity: an auto-linked match fans out to one row per linked item
 *      (what True Spend's drill-down joins); a below-threshold match is ONE
 *      candidate row carrying `receipt_id` / `order_id` only — one candidate,
 *      one row, so the queue counts candidates and a human's pick settles
 *      exactly the receipt or order they chose.
 */
export class DrizzleReconcileSink implements ReconcileSink {
  constructor(private readonly _db: FinanceDb) {}

  async persist(householdId: string, ledger: ReconciledLedger): Promise<void> {
    await this._db.transaction(async (tx) => {
      const categoryNames = new Set<string>();
      const categoryByReceiptItem = new Map<string, string>();
      for (const event of ledger.events) {
        for (const item of event.mergedItems) {
          categoryNames.add(item.category);
          const riId = item.itemRef.receiptItemId;
          if (riId) categoryByReceiptItem.set(riId, item.category);
        }
      }

      const categoryIdByName = await ensureCategories(tx, categoryNames);
      await stampReceiptItemCategories(tx, householdId, categoryByReceiptItem, categoryIdByName);
      const desired = await buildMatchRows(tx, householdId, ledger);
      await syncEngineRows(tx, householdId, desired);
    });
  }
}

/** Resolve categories by name; return a name→id map covering all requested names. */
async function ensureCategories(tx: Tx, names: Set<string>): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (names.size === 0) return map;

  const existing = await tx
    .select({ id: categories.id, name: categories.name })
    .from(categories)
    .where(inArray(categories.name, [...names]));
  for (const row of existing) map.set(row.name, row.id);

  const toInsert = [...names].filter((n) => !map.has(n));
  if (toInsert.length > 0) {
    // Ids are the taxonomy's stable slugs (`db/taxonomy.ts`). The classifier
    // clamps to the taxonomy, so an unknown name should never arrive; if one
    // does it lands on 'other' rather than minting a 22nd category that
    // would leak into listCategories() and the resolver's allowed list.
    const values = toInsert.map((name) => ({ id: categoryIdFor(name) ?? 'other', name }));
    // ux_categories_name makes this idempotent across concurrent/repeat seeds.
    await tx.insert(categories).values(values).onConflictDoNothing();
    const reread = await tx
      .select({ id: categories.id, name: categories.name })
      .from(categories)
      .where(inArray(categories.name, toInsert));
    for (const row of reread) map.set(row.name, row.id);
  }

  return map;
}

/**
 * Set receipt_items.category_id for classified receipt items in this
 * household that do not have one yet — one scoped UPDATE per category. An
 * existing category (the SKU resolver's, or a human's) always wins.
 */
async function stampReceiptItemCategories(
  tx: Tx,
  householdId: string,
  categoryByReceiptItem: Map<string, string>,
  categoryIdByName: Map<string, string>,
): Promise<void> {
  if (categoryByReceiptItem.size === 0) return;

  const itemsByCategoryId = new Map<string, string[]>();
  for (const [riId, categoryName] of categoryByReceiptItem) {
    const categoryId = categoryIdByName.get(categoryName);
    if (!categoryId) continue;
    const list = itemsByCategoryId.get(categoryId) ?? [];
    list.push(riId);
    itemsByCategoryId.set(categoryId, list);
  }

  const householdReceipts = tx
    .select({ id: receipts.id })
    .from(receipts)
    .where(eq(receipts.householdId, householdId));

  for (const [categoryId, riIds] of itemsByCategoryId) {
    for (const ids of chunks(riIds)) {
      await tx
        .update(receiptItems)
        .set({ categoryId })
        .where(
          and(
            inArray(receiptItems.id, ids),
            isNull(receiptItems.categoryId),
            inArray(receiptItems.receiptId, householdReceipts),
          ),
        );
    }
  }
}

/**
 * Expand engine MatchRecords into the rows the DB should hold.
 *   auto_linked, receipt/order anchored → one row per linked item (receipt
 *     items; non-return order items), carrying receipt_id / order_id too;
 *   review → ONE candidate row with receipt_id / order_id only;
 *   anything with no receipt and no order (a card refund) → one transaction-
 *     level row.
 * Ids are deterministic so the same engine output always maps to the same rows.
 */
async function buildMatchRows(tx: Tx, householdId: string, ledger: ReconciledLedger): Promise<MatchRow[]> {
  const all: MatchRecord[] = [...ledger.matches, ...ledger.reviewQueue];

  const receiptIds = new Set<string>();
  const orderIds = new Set<string>();
  for (const m of all) {
    if (m.status !== 'auto_linked') continue;
    if (m.receiptId) receiptIds.add(m.receiptId);
    if (m.orderId) orderIds.add(m.orderId);
  }

  // Resolve receipt → receipt-item ids, order → non-return order-item ids,
  // both scoped to this household so cross-household data never leaks in.
  const receiptItemsByReceipt = new Map<string, string[]>();
  if (receiptIds.size > 0) {
    const riRows = await tx
      .select({ id: receiptItems.id, receiptId: receiptItems.receiptId })
      .from(receiptItems)
      .innerJoin(receipts, eq(receiptItems.receiptId, receipts.id))
      .where(and(eq(receipts.householdId, householdId), inArray(receiptItems.receiptId, [...receiptIds])))
      .orderBy(receiptItems.receiptId, receiptItems.lineNo);
    for (const row of riRows) {
      const list = receiptItemsByReceipt.get(row.receiptId) ?? [];
      list.push(row.id);
      receiptItemsByReceipt.set(row.receiptId, list);
    }
  }

  const orderItemsByOrder = new Map<string, string[]>();
  if (orderIds.size > 0) {
    const oiRows = await tx
      .select({ id: orderItems.id, orderId: orderItems.orderId, isReturn: orderItems.isReturn })
      .from(orderItems)
      .innerJoin(orders, eq(orderItems.orderId, orders.id))
      .where(and(eq(orders.householdId, householdId), inArray(orderItems.orderId, [...orderIds])))
      .orderBy(orderItems.orderId, orderItems.shipmentId, orderItems.itemSeq);
    for (const row of oiRows) {
      if (row.isReturn) continue;
      const list = orderItemsByOrder.get(row.orderId) ?? [];
      list.push(row.id);
      orderItemsByOrder.set(row.orderId, list);
    }
  }

  const rows: MatchRow[] = [];
  const seen = new Set<string>();
  function push(row: MatchRow): void {
    if (seen.has(row.id)) return;
    seen.add(row.id);
    rows.push(row);
  }

  for (const m of all) {
    const transactionId = m.transactionId;
    if (!transactionId) continue; // DB requires a non-null transaction anchor

    const base = {
      transactionId,
      receiptId: m.receiptId ?? null,
      orderId: m.orderId ?? null,
      status: dbStatus(m.status),
      confidence: toDbConfidence(m.confidence),
      method: m.type,
      rationale: m.rationale,
      storeCreditBalanceId: m.storeCreditBalanceId ?? null,
    } as const;

    // A candidate is one row: the human picks a receipt or an order, not a line.
    if (m.status === 'review') {
      push({ id: `${ENGINE_MATCH_ID_PREFIX}${m.id}`, orderItemId: null, receiptItemId: null, ...base });
      continue;
    }

    const orderItemIds = m.orderId ? orderItemsByOrder.get(m.orderId) ?? [] : [];
    const receiptItemIds = m.receiptId ? receiptItemsByReceipt.get(m.receiptId) ?? [] : [];

    if (orderItemIds.length === 0 && receiptItemIds.length === 0) {
      // No resolvable item rows (a card refund; an order with only returns) —
      // record the transaction-level link so listMatches still surfaces it.
      push({ id: `${ENGINE_MATCH_ID_PREFIX}${m.id}`, orderItemId: null, receiptItemId: null, ...base });
      continue;
    }

    // When both sides resolve, pair them positionally so a single row carries
    // BOTH orderItemId and receiptItemId — the join True Spend's order drill-down
    // needs. Otherwise fan out over whichever side resolved.
    if (orderItemIds.length > 0 && receiptItemIds.length > 0) {
      const n = Math.max(orderItemIds.length, receiptItemIds.length);
      for (let i = 0; i < n; i++) {
        const oi = orderItemIds[i] ?? null;
        const ri = receiptItemIds[i] ?? null;
        push({ id: `${ENGINE_MATCH_ID_PREFIX}${m.id}-${oi ?? 'x'}-${ri ?? 'x'}`, orderItemId: oi, receiptItemId: ri, ...base });
      }
    } else if (orderItemIds.length > 0) {
      for (const oi of orderItemIds) {
        push({ id: `${ENGINE_MATCH_ID_PREFIX}${m.id}-oi-${oi}`, orderItemId: oi, receiptItemId: null, ...base });
      }
    } else {
      for (const ri of receiptItemIds) {
        push({ id: `${ENGINE_MATCH_ID_PREFIX}${m.id}-ri-${ri}`, orderItemId: null, receiptItemId: ri, ...base });
      }
    }
  }

  return rows;
}

type ExistingRow = Pick<
  typeof matches.$inferSelect,
  'id' | 'transactionId' | 'orderItemId' | 'receiptItemId' | 'receiptId' | 'orderId' | 'status' | 'confidence' | 'method' | 'rationale' | 'storeCreditBalanceId'
>;

function rowDiffers(existing: ExistingRow, wanted: MatchRow): boolean {
  return (
    existing.status !== wanted.status ||
    existing.confidence !== (wanted.confidence ?? null) ||
    existing.method !== (wanted.method ?? null) ||
    existing.rationale !== (wanted.rationale ?? null) ||
    existing.orderItemId !== (wanted.orderItemId ?? null) ||
    existing.receiptItemId !== (wanted.receiptItemId ?? null) ||
    existing.receiptId !== (wanted.receiptId ?? null) ||
    existing.orderId !== (wanted.orderId ?? null) ||
    existing.storeCreditBalanceId !== (wanted.storeCreditBalanceId ?? null)
  );
}

/**
 * Make the household's engine-owned rows equal `desired`: insert the new,
 * update the changed, delete the retracted. Human rows are invisible here.
 */
async function syncEngineRows(tx: Tx, householdId: string, desired: MatchRow[]): Promise<void> {
  const householdTransactions = tx
    .select({ id: transactions.id })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(eq(accounts.householdId, householdId));

  const existing: ExistingRow[] = await tx
    .select({
      id: matches.id,
      transactionId: matches.transactionId,
      orderItemId: matches.orderItemId,
      receiptItemId: matches.receiptItemId,
      receiptId: matches.receiptId,
      orderId: matches.orderId,
      status: matches.status,
      confidence: matches.confidence,
      method: matches.method,
      rationale: matches.rationale,
      storeCreditBalanceId: matches.storeCreditBalanceId,
    })
    .from(matches)
    .where(
      and(
        inArray(matches.transactionId, householdTransactions),
        inArray(matches.status, [...ENGINE_OWNED_STATUSES]),
        like(matches.id, `${ENGINE_MATCH_ID_PREFIX}%`),
      ),
    );

  // A transaction a human has settled takes no new candidates — the engine
  // already honours decisions; this is the belt to that braces.
  const settledRows = await tx
    .select({ transactionId: matches.transactionId })
    .from(matches)
    .where(and(inArray(matches.transactionId, householdTransactions), eq(matches.status, 'manual')));
  const settled = new Set(settledRows.map((r) => r.transactionId));
  const wanted = desired.filter((r) => !(r.status === 'pending' && settled.has(r.transactionId)));

  const existingById = new Map(existing.map((r) => [r.id, r]));
  const wantedIds = new Set(wanted.map((r) => r.id));

  const toInsert = wanted.filter((r) => !existingById.has(r.id));
  const toUpdate = wanted.filter((r) => {
    const e = existingById.get(r.id);
    return e !== undefined && rowDiffers(e, r);
  });
  const toDelete = existing.filter((e) => !wantedIds.has(e.id)).map((e) => e.id);

  for (const ids of chunks(toDelete)) {
    await tx.delete(matches).where(inArray(matches.id, ids));
  }
  for (const rows of chunks(toInsert)) {
    await tx.insert(matches).values(rows);
  }
  for (const r of toUpdate) {
    await tx
      .update(matches)
      .set({
        status: r.status,
        confidence: r.confidence ?? null,
        method: r.method ?? null,
        rationale: r.rationale ?? null,
        orderItemId: r.orderItemId ?? null,
        receiptItemId: r.receiptItemId ?? null,
        receiptId: r.receiptId ?? null,
        orderId: r.orderId ?? null,
        storeCreditBalanceId: r.storeCreditBalanceId ?? null,
      })
      .where(eq(matches.id, r.id));
  }
}
