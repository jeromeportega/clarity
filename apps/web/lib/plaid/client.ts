import { Configuration, PlaidApi, PlaidEnvironments, type Transaction, type TransactionsSyncResponse } from 'plaid';

import type {
  PlaidAccount,
  PlaidClient,
  PlaidSyncPage,
  PlaidTransaction,
  PlaidUpdateStatus,
} from '../../../../modules/finance/core/adapters/plaid/plaid-client';

/**
 * The only file that constructs the Plaid SDK. Credentials come from the
 * environment: `PLAID_CLIENT_ID`, `PLAID_SECRET` (the secret for `PLAID_ENV`),
 * `PLAID_ENV` (`sandbox` or `production`). Core sees the `PlaidClient` port
 * and nothing else.
 *
 * Every SDK call is wrapped so that NO axios error escapes this file: an
 * axios error carries the request config — the credential headers and the
 * request body with the access token — and would print them wherever it was
 * logged. What escapes is a plain Error with Plaid's error type, code and
 * message, and nothing else.
 */
export type PlaidEnv = 'sandbox' | 'production';

export function plaidEnv(env: Record<string, string | undefined> = process.env): PlaidEnv | null {
  const raw = env.PLAID_ENV?.trim().toLowerCase();
  return raw === 'sandbox' || raw === 'production' ? raw : null;
}

export function isPlaidConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.PLAID_CLIENT_ID?.trim() && env.PLAID_SECRET?.trim() && plaidEnv(env) && env.PLAID_TOKEN_KEY?.trim());
}

/** Thrown by every SDK-backed method: safe to log, safe to store, safe to show. */
export class PlaidRequestError extends Error {
  constructor(
    message: string,
    readonly errorType: string | null,
    readonly errorCode: string | null,
    readonly httpStatus: number | null,
  ) {
    super(message);
    this.name = 'PlaidRequestError';
  }
}

/**
 * Reduce whatever the SDK threw to something that cannot leak a credential.
 * Only Plaid's own `error_type` / `error_code` / `error_message` fields (or
 * the bare message for non-HTTP failures) survive; the request config never does.
 */
export function toSafePlaidError(err: unknown): PlaidRequestError {
  const e = err as { response?: { status?: number; data?: Record<string, unknown> }; message?: string; code?: string };
  const data = e?.response?.data;
  if (data && typeof data === 'object' && typeof data.error_code === 'string') {
    const type = typeof data.error_type === 'string' ? data.error_type : null;
    const message = typeof data.error_message === 'string' ? data.error_message : 'Plaid request failed';
    return new PlaidRequestError(`Plaid ${type ?? 'ERROR'}/${data.error_code}: ${message}`, type, data.error_code, e.response?.status ?? null);
  }
  const status = e?.response?.status ?? null;
  const base = typeof e?.message === 'string' && e.message.length > 0 ? e.message : 'Plaid request failed';
  // Belt and braces: never let a header value or token-shaped string through.
  const scrubbed = base.replace(/(access|public|link)-(sandbox|production|development)-[A-Za-z0-9-]+/g, '<token>');
  return new PlaidRequestError(status ? `Plaid request failed (HTTP ${status}): ${scrubbed}` : scrubbed, null, e?.code ?? null, status);
}

/** The one-line, credential-free description for logs. */
export function safePlaidMessage(err: unknown): string {
  return err instanceof PlaidRequestError ? err.message : toSafePlaidError(err).message;
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

function toUpdateStatus(raw: TransactionsSyncResponse['transactions_update_status'] | undefined): PlaidUpdateStatus {
  switch (String(raw)) {
    case 'NOT_READY':
      return 'not_ready';
    case 'INITIAL_UPDATE_COMPLETE':
      return 'initial';
    case 'HISTORICAL_UPDATE_COMPLETE':
      return 'historical';
    default:
      return 'unknown';
  }
}

async function guarded<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    throw toSafePlaidError(err);
  }
}

/** The core's port, backed by the SDK. */
export class SdkPlaidClient implements PlaidClient {
  private readonly sdk: PlaidApi;

  constructor(env: Record<string, string | undefined> = process.env) {
    this.sdk = api(env);
  }

  async accountsGet(accessToken: string): Promise<PlaidAccount[]> {
    const { data } = await guarded(() => this.sdk.accountsGet({ access_token: accessToken }));
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
    const { data } = await guarded(() =>
      this.sdk.transactionsSync({ access_token: accessToken, cursor: cursor ?? undefined, count: 500 }),
    );
    return {
      added: data.added.map(toTransaction),
      modified: data.modified.map(toTransaction),
      removed: data.removed.map((r) => ({ transactionId: r.transaction_id, accountId: r.account_id ?? null })),
      nextCursor: data.next_cursor,
      hasMore: data.has_more,
      updateStatus: toUpdateStatus(data.transactions_update_status),
    };
  }

  /**
   * Sandbox only: create an Item at a test institution without Link, and
   * exchange it for an access token. Production Items come from Link.
   */
  async createSandboxItem(institutionId = 'ins_56'): Promise<{ accessToken: string; itemId: string; institutionId: string }> {
    const pub = await guarded(() =>
      this.sdk.sandboxPublicTokenCreate({ institution_id: institutionId, initial_products: ['transactions' as never] }),
    );
    const exchanged = await guarded(() => this.sdk.itemPublicTokenExchange({ public_token: pub.data.public_token }));
    return { accessToken: exchanged.data.access_token, itemId: exchanged.data.item_id, institutionId };
  }

  /** The Link flow's second half: a public token from Link becomes an Item. */
  async exchangePublicToken(publicToken: string): Promise<{ accessToken: string; itemId: string }> {
    const { data } = await guarded(() => this.sdk.itemPublicTokenExchange({ public_token: publicToken }));
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

/** What the app layer needs beyond the core port, for tests to fake. */
export interface PlaidAdminClient extends PlaidClient {
  createSandboxItem(institutionId?: string): Promise<{ accessToken: string; itemId: string; institutionId: string }>;
  institutionName(institutionId: string): Promise<string | null>;
}
