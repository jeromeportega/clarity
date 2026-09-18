import { Configuration, PlaidApi, PlaidEnvironments, type Transaction } from 'plaid';

import type {
  PlaidAccount,
  PlaidClient,
  PlaidSyncPage,
  PlaidTransaction,
} from '../../../../modules/finance/core/adapters/plaid/plaid-client';

/**
 * The only file that constructs the Plaid SDK. Credentials come from the
 * environment: `PLAID_CLIENT_ID`, `PLAID_SECRET` (the secret for `PLAID_ENV`),
 * `PLAID_ENV` (`sandbox` or `production`). Core sees the `PlaidClient` port
 * and nothing else.
 */
export type PlaidEnv = 'sandbox' | 'production';

export function plaidEnv(env: Record<string, string | undefined> = process.env): PlaidEnv | null {
  const raw = env.PLAID_ENV?.trim().toLowerCase();
  return raw === 'sandbox' || raw === 'production' ? raw : null;
}

export function isPlaidConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.PLAID_CLIENT_ID?.trim() && env.PLAID_SECRET?.trim() && plaidEnv(env) && env.PLAID_TOKEN_KEY?.trim());
}

function api(env: Record<string, string | undefined>): PlaidApi {
  const environment = plaidEnv(env);
  if (!environment) throw new Error('PLAID_ENV must be sandbox or production');
  return new PlaidApi(
    new Configuration({
      basePath: PlaidEnvironments[environment],
      baseOptions: {
        headers: {
          'PLAID-CLIENT-ID': env.PLAID_CLIENT_ID,
          'PLAID-SECRET': env.PLAID_SECRET,
          'Plaid-Version': '2020-09-14',
        },
      },
    }),
  );
}

function toTransaction(t: Transaction): PlaidTransaction {
  return {
    transactionId: t.transaction_id,
    accountId: t.account_id,
    amount: t.amount,
    isoCurrencyCode: t.iso_currency_code,
    date: t.date,
    authorizedDate: t.authorized_date,
    name: t.name,
    merchantName: t.merchant_name ?? null,
    pending: t.pending,
    pendingTransactionId: t.pending_transaction_id,
    categoryDetailed: t.personal_finance_category?.detailed ?? null,
  };
}

/** The core's port, backed by the SDK. */
export class SdkPlaidClient implements PlaidClient {
  private readonly sdk: PlaidApi;

  constructor(env: Record<string, string | undefined> = process.env) {
    this.sdk = api(env);
  }

  async accountsGet(accessToken: string): Promise<PlaidAccount[]> {
    const { data } = await this.sdk.accountsGet({ access_token: accessToken });
    return data.accounts.map((a) => ({
      accountId: a.account_id,
      name: a.name,
      officialName: a.official_name ?? null,
      type: String(a.type),
      subtype: a.subtype ? String(a.subtype) : null,
      mask: a.mask ?? null,
    }));
  }

  async transactionsSync(accessToken: string, cursor: string | null): Promise<PlaidSyncPage> {
    const { data } = await this.sdk.transactionsSync({
      access_token: accessToken,
      cursor: cursor ?? undefined,
      count: 500,
    });
    return {
      added: data.added.map(toTransaction),
      modified: data.modified.map(toTransaction),
      removed: data.removed.map((r) => ({ transactionId: r.transaction_id, accountId: r.account_id ?? '' })),
      nextCursor: data.next_cursor,
      hasMore: data.has_more,
    };
  }

  /**
   * Sandbox only: create an Item at a test institution without Link, and
   * exchange it for an access token. Production Items come from Link.
   */
  async createSandboxItem(institutionId = 'ins_56'): Promise<{ accessToken: string; itemId: string; institutionId: string }> {
    const pub = await this.sdk.sandboxPublicTokenCreate({
      institution_id: institutionId,
      initial_products: ['transactions' as never],
    });
    const exchanged = await this.sdk.itemPublicTokenExchange({ public_token: pub.data.public_token });
    return { accessToken: exchanged.data.access_token, itemId: exchanged.data.item_id, institutionId };
  }

  /** The Link flow's second half: a public token from Link becomes an Item. */
  async exchangePublicToken(publicToken: string): Promise<{ accessToken: string; itemId: string }> {
    const { data } = await this.sdk.itemPublicTokenExchange({ public_token: publicToken });
    return { accessToken: data.access_token, itemId: data.item_id };
  }

  async institutionName(institutionId: string): Promise<string | null> {
    try {
      const { data } = await this.sdk.institutionsGetById({ institution_id: institutionId, country_codes: ['US' as never] });
      return data.institution.name;
    } catch {
      return null;
    }
  }
}
