// =============================================================================
// The Plaid port. The core never imports the `plaid` SDK (the boundary test
// forbids it): it talks to this interface, the app layer implements it with the
// SDK, and tests inject a fake that replays sandbox fixtures. Only the fields
// the sync needs are modelled — the rest of Plaid's objects never enter core.
// =============================================================================

export interface PlaidAccount {
  accountId: string;
  name: string;
  officialName: string | null;
  /** Plaid's account type: depository, credit, loan, investment, other. */
  type: string;
  /** checking, savings, cd, money market, credit card, … */
  subtype: string | null;
  /** Last digits as printed by the bank, when known. */
  mask: string | null;
}

export interface PlaidTransaction {
  transactionId: string;
  accountId: string;
  /** Dollars as Plaid reports them: POSITIVE is money leaving the account. */
  amount: number;
  isoCurrencyCode: string | null;
  /** Posting date, or the pending date while pending — ISO YYYY-MM-DD. */
  date: string;
  authorizedDate: string | null;
  /** The bank's description line. */
  name: string;
  /** Plaid's cleaned merchant, when it has one. */
  merchantName: string | null;
  pending: boolean;
  /** For a posted transaction: the id of the pending one it replaced. */
  pendingTransactionId: string | null;
  /** Plaid's `personal_finance_category.detailed`, e.g. FOOD_AND_DRINK_GROCERIES. */
  categoryDetailed: string | null;
}

export interface PlaidRemovedTransaction {
  transactionId: string;
  /** Plaid may omit it; the sync then skips the entry rather than guessing. */
  accountId: string | null;
}

/**
 * Where Plaid is with this Item's history: a fresh Item answers `not_ready`
 * (nothing pulled yet) before `initial` (recent activity) and `historical`
 * (the full window). A sync that adds nothing while `not_ready` is not "no
 * activity" — it is "come back in a minute".
 */
export type PlaidUpdateStatus = 'not_ready' | 'initial' | 'historical' | 'unknown';

export interface PlaidSyncPage {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: PlaidRemovedTransaction[];
  nextCursor: string;
  hasMore: boolean;
  updateStatus: PlaidUpdateStatus;
}

export interface PlaidClient {
  /** The accounts under one Item (an institution login). */
  accountsGet(accessToken: string): Promise<PlaidAccount[]>;
  /** One page of `/transactions/sync`; `cursor` null means from the beginning. */
  transactionsSync(accessToken: string, cursor: string | null): Promise<PlaidSyncPage>;
}
