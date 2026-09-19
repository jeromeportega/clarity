import { and, eq } from 'drizzle-orm';

import { compileLearnedStores, receiptCapableMerchant } from '../../../modules/finance/core/queue/receipt-capable';
import type { HouseholdScope } from '../../../modules/finance/core/reconciliation/types';
import type { FinanceDb } from '../../../modules/finance/db/client';
import { accounts, receipts, transactions } from '../../../modules/finance/db/schema';

export interface ChargeSummary {
  id: string;
  /** The bank line's normalised merchant. */
  merchant: string;
  /** The store as the queue row names it ("Costco", a learned "Corner Market"), else the merchant. */
  displayMerchant: string;
  amountCents: number;
  postedDate: string;
}

/** One bank line, by id, only if it belongs to this household. */
export async function fetchChargeSummary(db: FinanceDb, scope: HouseholdScope, id: string): Promise<ChargeSummary | null> {
  const rows = await db
    .select({
      id: transactions.id,
      merchant: transactions.normalizedMerchant,
      amountCents: transactions.amountCents,
      postedDate: transactions.postedDate,
    })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(and(eq(transactions.id, id), eq(accounts.householdId, scope.householdId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const storeRows = await db.selectDistinct({ store: receipts.store }).from(receipts).where(eq(receipts.householdId, scope.householdId));
  const learned = compileLearnedStores(storeRows.map((r) => r.store).filter((s): s is string => typeof s === 'string' && s.trim().length > 0));
  return { ...row, displayMerchant: receiptCapableMerchant(row.merchant, learned) ?? row.merchant };
}
