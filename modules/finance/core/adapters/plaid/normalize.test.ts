import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { accountNameFor, accountTypeFor, normalizePlaidTransaction, toCents } from './normalize';
import type { PlaidAccount, PlaidTransaction } from './plaid-client';

const here = dirname(fileURLToPath(import.meta.url));

const base: PlaidTransaction = {
  transactionId: 'txn_1',
  accountId: 'acc_1',
  amount: 12.34,
  isoCurrencyCode: 'USD',
  date: '2026-09-11',
  authorizedDate: '2026-09-10',
  name: 'UBER   *TRIP HELP.UBER.COM',
  merchantName: 'Uber',
  pending: false,
  pendingTransactionId: null,
  categoryDetailed: 'TRANSPORTATION_TAXIS_AND_RIDE_SHARES',
};

describe('normalizePlaidTransaction — Plaid dollars to the house model', () => {
  it('flips the sign: Plaid positive (money out) is our negative debit, in integer cents', () => {
    const n = normalizePlaidTransaction(base);
    expect(n.amountCents).toBe(-1234);
    expect(n.direction).toBe('debit');
    const refund = normalizePlaidTransaction({ ...base, amount: -25 });
    expect(refund.amountCents).toBe(2500);
    expect(refund.direction).toBe('credit');
  });

  it('rounds to the cent rather than truncating float noise', () => {
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents(19.999)).toBe(2000);
    expect(toCents(-4.005)).toBe(-400); // -400.49999… → -400: Math.round rounds a half toward +∞; Plaid never sends a third decimal
  });

  it('prefers Plaid’s merchant name, falls back to the bank line, and cleans it like the bank adapter', () => {
    expect(normalizePlaidTransaction(base).rawMerchant).toBe('Uber');
    const noMerchant = normalizePlaidTransaction({ ...base, merchantName: null });
    expect(noMerchant.rawMerchant).toBe('UBER   *TRIP HELP.UBER.COM');
    expect(noMerchant.normalizedMerchant.length).toBeGreaterThan(0);
    expect(noMerchant.normalizedMerchant).not.toMatch(/\s{2,}/);
  });

  it('keys the row on the provider id, so the dedup key is stable however the bank rewords the line', () => {
    const a = normalizePlaidTransaction(base);
    const b = normalizePlaidTransaction({ ...base, name: 'UBER TRIP', merchantName: 'UBER' });
    expect(a.sourceRowHash).toBe(b.sourceRowHash);
    expect(a.externalId).toBe('txn_1');
    expect(normalizePlaidTransaction({ ...base, transactionId: 'txn_2' }).sourceRowHash).not.toBe(a.sourceRowHash);
  });

  it('carries pending state, the replaced pending id and the category hint through', () => {
    const n = normalizePlaidTransaction({ ...base, pending: true, pendingTransactionId: null, categoryDetailed: null });
    expect(n).toMatchObject({ pending: true, pendingExternalId: null, categoryHint: null });
    const posted = normalizePlaidTransaction({ ...base, pendingTransactionId: 'txn_pending' });
    expect(posted).toMatchObject({ pending: false, pendingExternalId: 'txn_pending', categoryHint: 'TRANSPORTATION_TAXIS_AND_RIDE_SHARES' });
  });

  it('normalises every transaction in the sandbox fixture without throwing', () => {
    const fixture = JSON.parse(readFileSync(join(here, '__tests__/fixtures/sandbox-sync.json'), 'utf8')) as {
      items: Array<{ added: Array<Record<string, unknown>> }>;
    };
    const added = fixture.items[0]!.added;
    expect(added.length).toBeGreaterThan(10);
    for (const t of added) {
      const n = normalizePlaidTransaction({
        transactionId: t.transaction_id as string,
        accountId: t.account_id as string,
        amount: t.amount as number,
        isoCurrencyCode: (t.iso_currency_code as string | null) ?? null,
        date: t.date as string,
        authorizedDate: (t.authorized_date as string | null) ?? null,
        name: t.name as string,
        merchantName: (t.merchant_name as string | null) ?? null,
        pending: t.pending as boolean,
        pendingTransactionId: (t.pending_transaction_id as string | null) ?? null,
        categoryDetailed: null,
      });
      expect(Number.isInteger(n.amountCents)).toBe(true);
      expect(n.postedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(n.normalizedMerchant.length).toBeGreaterThan(0);
    }
  });
});

describe('account mapping', () => {
  const acct = (over: Partial<PlaidAccount>): PlaidAccount => ({
    accountId: 'a', name: 'Plaid Checking', officialName: 'Plaid Gold Standard 0% Interest Checking', type: 'depository', subtype: 'checking', mask: '0000', ...over,
  });

  it('uses the subtype for deposit accounts, "credit" for cards, and the type otherwise', () => {
    expect(accountTypeFor(acct({}))).toBe('checking');
    expect(accountTypeFor(acct({ subtype: 'savings' }))).toBe('savings');
    expect(accountTypeFor(acct({ type: 'credit', subtype: 'credit card' }))).toBe('credit');
    expect(accountTypeFor(acct({ type: 'loan', subtype: 'mortgage' }))).toBe('loan');
    expect(accountTypeFor(acct({ subtype: null }))).toBe('depository');
  });

  it('names the account from the official name with the mask, falling back to the short name', () => {
    expect(accountNameFor(acct({}))).toBe('Plaid Gold Standard 0% Interest Checking ····0000');
    expect(accountNameFor(acct({ officialName: null, mask: null }))).toBe('Plaid Checking');
  });
});
