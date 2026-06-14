import { and, eq, like } from 'drizzle-orm';
import type { FinanceDb } from '../../db/client';
import { receiptItems, receipts, categories } from '../../db/schema';
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

/**
 * Assemble the true-spend breakdown for a household / month.
 *
 * Totals come exclusively from gw.getRollups (which reflects 003's corrections
 * via recomputeRollups — do NOT recompute from raw items here). Items are
 * fetched from the DB for the drill-down path; they do not affect the total.
 *
 * When month is omitted or empty, all months are returned and items are not
 * filtered by month.
 */
export async function assembleBreakdown(
  scope: HouseholdScope,
  gw: ReconciliationGateway,
  db: FinanceDb,
  month?: string,
): Promise<TrueSpendBreakdown> {
  const rollups = await gw.getRollups(scope, month ? { month } : undefined);

  if (rollups.length === 0) {
    return { month: month ?? '', categories: [] };
  }

  const items = await queryReceiptItems(scope, db, month);

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

  return { month: month ?? '', categories: cats };
}

async function queryReceiptItems(
  scope: HouseholdScope,
  db: FinanceDb,
  month: string | undefined,
): Promise<TrueSpendItem[]> {
  const monthFilter = month ? `${month}-%` : undefined;

  const conditions = [eq(receipts.householdId, scope.householdId)];
  if (monthFilter) {
    conditions.push(like(receipts.purchasedAt, monthFilter));
  }

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
