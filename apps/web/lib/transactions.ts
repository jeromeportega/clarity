import { and, eq } from 'drizzle-orm';

import type { HouseholdScope } from '../../../modules/finance/core/reconciliation/types';
import type { FinanceDb } from '../../../modules/finance/db/client';
import { accounts, transactions } from '../../../modules/finance/db/schema';

export interface ChargeSummary {
  id: string;
  merchant: string;
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
  return rows[0] ?? null;
}
