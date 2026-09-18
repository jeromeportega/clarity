import { count, eq, sql } from 'drizzle-orm';

import type { HouseholdScope } from '../../../modules/finance/core/reconciliation/types';
import type { FinanceDb } from '../../../modules/finance/db/client';
import { accounts, plaidItems, transactions } from '../../../modules/finance/db/schema';

export interface BankAccountView {
  id: string;
  name: string;
  type: string | null;
  mask: string | null;
  source: 'manual' | 'file' | 'plaid';
  transactionCount: number;
  latestPostedDate: string | null;
}

export interface ConnectedBankView {
  plaidItemId: string;
  institutionName: string | null;
  status: 'ok' | 'error' | 'login_required';
  lastSyncedAt: string | null;
  accounts: BankAccountView[];
}

export interface BanksView {
  connected: ConnectedBankView[];
  /** Accounts that came from files or were made by hand — no Item behind them. */
  other: BankAccountView[];
}

/** Everything the Banks page shows for one household; never a token. */
export async function fetchBanks(db: FinanceDb, scope: HouseholdScope): Promise<BanksView> {
  const items = await db
    .select({
      plaidItemId: plaidItems.id,
      institutionName: plaidItems.institutionName,
      status: plaidItems.status,
      lastSyncedAt: plaidItems.lastSyncedAt,
    })
    .from(plaidItems)
    .where(eq(plaidItems.householdId, scope.householdId))
    .orderBy(plaidItems.createdAt);

  const accountRows = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      type: accounts.type,
      mask: accounts.mask,
      source: accounts.source,
      plaidItemId: accounts.plaidItemId,
      transactionCount: count(transactions.id),
      latestPostedDate: sql<string | null>`max(${transactions.postedDate})`,
    })
    .from(accounts)
    .leftJoin(transactions, eq(transactions.accountId, accounts.id))
    .where(eq(accounts.householdId, scope.householdId))
    .groupBy(accounts.id)
    .orderBy(accounts.name);

  const view = (a: (typeof accountRows)[number]): BankAccountView => ({
    id: a.id,
    name: a.name,
    type: a.type,
    mask: a.mask,
    source: a.source,
    transactionCount: Number(a.transactionCount),
    latestPostedDate: a.latestPostedDate ?? null,
  });

  return {
    connected: items.map((item) => ({
      ...item,
      accounts: accountRows.filter((a) => a.plaidItemId === item.plaidItemId).map(view),
    })),
    other: accountRows.filter((a) => a.plaidItemId === null).map(view),
  };
}

