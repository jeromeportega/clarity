import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb } from '../../../modules/finance/db/client';
import { accounts, households, receipts, transactions } from '../../../modules/finance/db/schema';
import { fetchChargeSummary } from './transactions';

// The upload page names the charge a person came from. That read crosses a
// tenancy boundary (transactions → accounts → household), so: own charge
// returns, another household's charge does not, an unknown id does not.
describe('fetchChargeSummary', () => {
  let handle: ReturnType<typeof createTestDb>;
  beforeEach(async () => {
    handle = createTestDb();
    const db = handle.db;
    await db.insert(households).values([{ id: 'hh-a', name: 'A' }, { id: 'hh-b', name: 'B' }]);
    await db.insert(accounts).values([
      { id: 'acct-a', householdId: 'hh-a', name: 'A checking', type: 'checking' },
      { id: 'acct-b', householdId: 'hh-b', name: 'B checking', type: 'checking' },
    ]);
    await db.insert(transactions).values([
      { id: 'txn-a', accountId: 'acct-a', postedDate: '2026-09-16', amountCents: -8412, direction: 'debit', normalizedMerchant: 'COSTCO WHSE', sourceRowHash: 'ha', dedupKey: 'ka' },
      { id: 'txn-a2', accountId: 'acct-a', postedDate: '2026-09-17', amountCents: -1500, direction: 'debit', normalizedMerchant: 'CORNER MARKET 123', sourceRowHash: 'ha2', dedupKey: 'ka2' },
      { id: 'txn-b', accountId: 'acct-b', postedDate: '2026-09-16', amountCents: -2000, direction: 'debit', normalizedMerchant: 'TARGET', sourceRowHash: 'hb', dedupKey: 'kb' },
    ]);
    await db.insert(receipts).values({ id: 'r-a', householdId: 'hh-a', source: 'test', store: 'Corner Market #12', purchasedAt: '2026-09-17', totalCents: 1500 });
  });
  afterEach(() => handle.cleanup());

  it('returns the household’s own charge, named as the queue names it', async () => {
    expect(await fetchChargeSummary(handle.db, { householdId: 'hh-a' }, 'txn-a')).toEqual({
      id: 'txn-a', merchant: 'COSTCO WHSE', displayMerchant: 'Costco', amountCents: -8412, postedDate: '2026-09-16',
    });
    // A store known only from this household's own receipts gets its name too.
    expect((await fetchChargeSummary(handle.db, { householdId: 'hh-a' }, 'txn-a2'))?.displayMerchant).toBe('Corner Market');
  });

  it('returns null for another household’s charge and for an unknown id', async () => {
    expect(await fetchChargeSummary(handle.db, { householdId: 'hh-a' }, 'txn-b')).toBeNull();
    expect(await fetchChargeSummary(handle.db, { householdId: 'hh-a' }, 'nope')).toBeNull();
  });
});
