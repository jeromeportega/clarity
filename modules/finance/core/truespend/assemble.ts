import { and, eq, isNotNull, like } from 'drizzle-orm';
import type { FinanceDb } from '../../db/client';
import { receiptItems, receipts, categories, orderItems, orders, matches, transactions, accounts } from '../../db/schema';
import type { ReconciliationGateway } from '../reconciliation/types';
import type { HouseholdScope } from '../scope';

export interface TrueSpendItem {
  id: string;
  description: string;
  amountCents: number;
  category: string;
}

export interface TrueSpendCategory {
  category: string;
  netCents: number;
  items: TrueSpendItem[];
}

export interface TrueSpendBreakdown {
  month: string;
  categories: TrueSpendCategory[];
}

const MONTH_RE = /^\d{4}-\d{2}$/;

/**
 * Assemble the true-spend breakdown for a household / month.
 *
 * Totals come exclusively from gw.getRollups (which reflects 003's corrections
 * via recomputeRollups — do NOT recompute from raw items here). Items are
 * fetched from the DB for the drill-down path; they do not affect the total.
 *
 * month must be YYYY-MM; values that fail validation are treated as absent
 * (no filter) to prevent LIKE-wildcard abuse.
 */
export async function assembleBreakdown(
  scope: HouseholdScope,
  gw: ReconciliationGateway,
  db: FinanceDb,
  month?: string,
): Promise<TrueSpendBreakdown> {
  const safeMonth = month && MONTH_RE.test(month) ? month : undefined;
  const rollups = await gw.getRollups(scope, safeMonth ? { month: safeMonth } : undefined);

  if (rollups.length === 0) {
    return { month: safeMonth ?? '', categories: [] };
  }

  const items = await queryItems(scope, db, safeMonth);

  const itemsByCategory = new Map<string, TrueSpendItem[]>();
  for (const item of items) {
    const list = itemsByCategory.get(item.category) ?? [];
    list.push(item);
    itemsByCategory.set(item.category, list);
  }

  const cats: TrueSpendCategory[] = rollups.map((r) => ({
    category: r.key.category,
    netCents: r.netCents,
    items: itemsByCategory.get(r.key.category) ?? [],
  }));

  return { month: safeMonth ?? '', categories: cats };
}

/**
 * Fetch contributing items for the drill-down across all three source tables:
 *   1. receipt_items (direct categoryId)
 *   2. order_items (category via matches → receipt_items)
 *   3. transactions (category via matches → receipt_items)
 *
 * Items from tables 2 and 3 only appear when a match exists linking them to a
 * categorised receipt_item; unmatched order/transaction items have no category
 * assignment in H1 and are correctly absent.
 */
async function queryItems(
  scope: HouseholdScope,
  db: FinanceDb,
  month: string | undefined,
): Promise<TrueSpendItem[]> {
  const monthFilter = month ? `${month}-%` : undefined;

  const [riRows, oiRows, txRows] = await Promise.all([
    queryReceiptItems(scope, db, monthFilter),
    queryOrderItems(scope, db, monthFilter),
    queryTransactionItems(scope, db, monthFilter),
  ]);

  return [...riRows, ...oiRows, ...txRows];
}

async function queryReceiptItems(
  scope: HouseholdScope,
  db: FinanceDb,
  monthFilter: string | undefined,
): Promise<TrueSpendItem[]> {
  const conditions = [eq(receipts.householdId, scope.householdId)];
  if (monthFilter) conditions.push(like(receipts.purchasedAt, monthFilter));

  const rows = await db
    .select({
      id: receiptItems.id,
      rawDescription: receiptItems.rawDescription,
      canonicalName: receiptItems.canonicalName,
      linePriceCents: receiptItems.linePriceCents,
      categoryName: categories.name,
    })
    .from(receiptItems)
    .innerJoin(receipts, eq(receiptItems.receiptId, receipts.id))
    .innerJoin(categories, eq(receiptItems.categoryId, categories.id))
    .where(and(...conditions));

  return rows.map((row) => ({
    id: row.id,
    description: row.canonicalName ?? row.rawDescription,
    amountCents: row.linePriceCents,
    category: row.categoryName,
  }));
}

async function queryOrderItems(
  scope: HouseholdScope,
  db: FinanceDb,
  monthFilter: string | undefined,
): Promise<TrueSpendItem[]> {
  const conditions = [
    eq(orders.householdId, scope.householdId),
    isNotNull(matches.receiptItemId),
    isNotNull(receiptItems.categoryId),
  ];
  if (monthFilter) conditions.push(like(orders.orderDate, monthFilter));

  const rows = await db
    .select({
      id: orderItems.id,
      description: orderItems.description,
      amountCents: orderItems.amountCents,
      categoryName: categories.name,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .innerJoin(matches, eq(matches.orderItemId, orderItems.id))
    .innerJoin(receiptItems, eq(matches.receiptItemId, receiptItems.id))
    .innerJoin(categories, eq(receiptItems.categoryId, categories.id))
    .where(and(...conditions));

  return rows.map((row) => ({
    id: row.id,
    description: row.description,
    amountCents: row.amountCents,
    category: row.categoryName,
  }));
}

async function queryTransactionItems(
  scope: HouseholdScope,
  db: FinanceDb,
  monthFilter: string | undefined,
): Promise<TrueSpendItem[]> {
  const conditions = [
    eq(accounts.householdId, scope.householdId),
    isNotNull(matches.receiptItemId),
    isNotNull(receiptItems.categoryId),
  ];
  if (monthFilter) conditions.push(like(transactions.postedDate, monthFilter));

  const rows = await db
    .select({
      id: transactions.id,
      merchant: transactions.normalizedMerchant,
      amountCents: transactions.amountCents,
      categoryName: categories.name,
    })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .innerJoin(matches, eq(matches.transactionId, transactions.id))
    .innerJoin(receiptItems, eq(matches.receiptItemId, receiptItems.id))
    .innerJoin(categories, eq(receiptItems.categoryId, categories.id))
    .where(and(...conditions));

  return rows.map((row) => ({
    id: row.id,
    description: row.merchant,
    amountCents: row.amountCents,
    category: row.categoryName,
  }));
}
