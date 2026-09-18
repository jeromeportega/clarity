import { describe, expect, it } from 'vitest';

import { isPlaidConfigured, PlaidRequestError, plaidEnv, safePlaidMessage, toSafePlaidError } from './client';

// The SDK is axios-based: a failed call throws an AxiosError whose `config`
// carries the request headers (PLAID-CLIENT-ID, PLAID-SECRET) and the JSON
// body (access_token). This is what would have hit the logs.
const SECRET = 'sandbox-secret-0123456789abcdef';
const TOKEN = 'access-sandbox-11111111-2222-3333-4444-555555555555';
function axiosLike(data: unknown, status = 400) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    code: 'ERR_BAD_REQUEST',
    config: {
      url: 'https://sandbox.plaid.com/transactions/sync',
      headers: { 'PLAID-CLIENT-ID': 'cid', 'PLAID-SECRET': SECRET },
      data: JSON.stringify({ access_token: TOKEN, cursor: null }),
    },
    response: { status, data, headers: {}, config: {} },
  });
}

describe('toSafePlaidError — nothing from the request survives', () => {
  it('keeps Plaid’s error type, code and message and drops the config', () => {
    const err = toSafePlaidError(axiosLike({ error_type: 'ITEM_ERROR', error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'the login details of this item have changed', request_id: 'r1' }));
    expect(err).toBeInstanceOf(PlaidRequestError);
    expect(err.message).toBe('Plaid ITEM_ERROR/ITEM_LOGIN_REQUIRED: the login details of this item have changed');
    expect(err).toMatchObject({ errorType: 'ITEM_ERROR', errorCode: 'ITEM_LOGIN_REQUIRED', httpStatus: 400 });
    const everything = JSON.stringify(err, Object.getOwnPropertyNames(err));
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain('config');
  });

  it('an HTTP failure without a Plaid body keeps only the status and a scrubbed message', () => {
    const err = toSafePlaidError(axiosLike('<html>gateway timeout</html>', 504));
    expect(err.message).toBe('Plaid request failed (HTTP 504): Request failed with status code 504');
    expect(err.errorCode).toBe('ERR_BAD_REQUEST');
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain(SECRET);
  });

  it('scrubs a token-shaped string out of any message, and tolerates non-Error throwables', () => {
    expect(toSafePlaidError(new Error(`bad token ${TOKEN} in body`)).message).toBe('bad token <token> in body');
    expect(toSafePlaidError('nope').message).toBe('Plaid request failed');
    expect(toSafePlaidError(undefined).message).toBe('Plaid request failed');
    expect(safePlaidMessage(new PlaidRequestError('already safe', null, null, null))).toBe('already safe');
  });
});

describe('configuration', () => {
  it('needs all four variables and a recognised environment', () => {
    const full = { PLAID_CLIENT_ID: 'c', PLAID_SECRET: 's', PLAID_ENV: 'sandbox', PLAID_TOKEN_KEY: 'k'.repeat(64) };
    expect(isPlaidConfigured(full)).toBe(true);
    expect(isPlaidConfigured({ ...full, PLAID_ENV: 'development' })).toBe(false);
    expect(isPlaidConfigured({ ...full, PLAID_TOKEN_KEY: '' })).toBe(false);
    expect(plaidEnv({ PLAID_ENV: ' Production ' })).toBe('production');
    expect(plaidEnv({})).toBeNull();
  });
});
