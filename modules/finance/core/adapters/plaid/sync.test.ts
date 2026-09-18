import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type FinanceDb } from '../../../db/client';
import { accounts, households, matches, plaidItems, transactions } from '../../../db/schema';
import type { PlaidAccount, PlaidClient, PlaidSyncPage, PlaidTransaction } from './plaid-client';
import { syncPlaidItem, type PlaidItemToSync } from './sync';

// The sandbox fixtures are real Plaid sandbox output (synthetic data, tokens
// redacted). The fake client replays them page by page; the store is a real
// throwaway libSQL database with every migration applied.
const here = dirname(fileURLToPath(import.meta.url));
const itemFixture = JSON.parse(readFileSync(join(here, '__tests__/fixtures/sandbox-item.json'), 'utf8')) as {
  accounts: Array<{ account_id: string; name: string; official_name: string | null; type: string; subtype: string | null; mask: string | null }>;
};
const syncFixture = JSON.parse(readFileSync(join(here, '__tests__/fixtures/sandbox-sync.json'), 'utf8')) as {
  items: Array<{ added: Array<Record<string, unknown>>; cursor: string }>;
};

const fixtureAccounts: PlaidAccount[] = itemFixture.accounts.map((a) => ({
  accountId: a.account_id,
  name: a.name,
  officialName: a.official_name,
  type: a.type,
  subtype: a.subtype,
  mask: a.mask,
}));

function txFromFixture(t: Record<string, unknown>): PlaidTransaction {
  return {
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
  };
}
const fixtureAdded: PlaidTransaction[] = syncFixture.items[0]!.added.map(txFromFixture);

/** A scripted client: each call to transactionsSync pops the next page. */
class FakePlaid implements PlaidClient {
  public syncCalls: Array<string | null> = [];
  constructor(
    private readonly accountList: PlaidAccount[],
    private readonly pages: PlaidSyncPage[],
  ) {}
  async accountsGet(): Promise<PlaidAccount[]> {
    return this.accountList;
  }
  async transactionsSync(_token: string, cursor: string | null): Promise<PlaidSyncPage> {
    this.syncCalls.push(cursor);
    const page = this.pages.shift();
    if (!page) return { added: [], modified: [], removed: [], nextCursor: cursor ?? 'c-empty', hasMore: false, updateStatus: 'historical' };
    return page;
  }
}

const page = (over: Partial<PlaidSyncPage>): PlaidSyncPage => ({ added: [], modified: [], removed: [], nextCursor: 'c1', hasMore: false, updateStatus: 'historical', ...over });

/** A human's decision on a line, as the queue records one. */
const manualMatch = (id: string, transactionId: string) => ({ id, transactionId, status: 'manual' as const, confidence: 1, method: 'human', rationale: 'test' });

const HH = 'hh-plaid';
let handle: ReturnType<typeof createTestDb>;
let db: FinanceDb;
let item: PlaidItemToSync;

beforeEach(async () => {
  handle = createTestDb();
  db = handle.db;
  await db.insert(households).values({ id: HH, name: 'Plaid household' });
  await db.insert(plaidItems).values({ id: 'pi-1', householdId: HH, itemId: 'item-1', accessToken: 'enc:opaque', institutionId: 'ins_56', institutionName: 'First Platypus Bank' });
  item = { id: 'pi-1', householdId: HH, accessToken: 'access-sandbox-plain', cursor: null, institutionName: 'First Platypus Bank' };
});
afterEach(() => handle.cleanup());

const sample = fixtureAdded[0]!;

describe('syncPlaidItem — the sandbox fixture end to end', () => {
  it('creates every reported account and inserts every added transaction, then persists the cursor', async () => {
    const client = new FakePlaid(fixtureAccounts, [page({ added: fixtureAdded, nextCursor: 'cursor-after-1' })]);
    const summary = await syncPlaidItem(db, item, client);

    expect(summary).toMatchObject({ accountsCreated: fixtureAccounts.length, accountsUpdated: 0, added: fixtureAdded.length, modified: 0, removed: 0, pendingResolved: 0, matchesReset: 0, skippedUnknownAccount: 0, pages: 1, cursor: 'cursor-after-1', updateStatus: 'historical' });
    const acctRows = await db.select().from(accounts).where(eq(accounts.householdId, HH));
    expect(acctRows).toHaveLength(fixtureAccounts.length);
    expect(acctRows.every((a) => a.source === 'plaid' && a.plaidItemId === 'pi-1' && a.externalId)).toBe(true);
    expect(acctRows.find((a) => a.externalId === sample.accountId)?.institution).toBe('First Platypus Bank');

    const txRows = await db.select().from(transactions);
    expect(txRows).toHaveLength(fixtureAdded.length);
    const one = txRows.find((t) => t.externalId === sample.transactionId)!;
    expect(one.amountCents).toBe(-Math.round(sample.amount * 100));
    expect(one.direction).toBe(sample.amount > 0 ? 'debit' : 'credit');
    expect(one.pending).toBe(false);

    const stored = (await db.select().from(plaidItems).where(eq(plaidItems.id, 'pi-1')))[0]!;
    expect(stored.cursor).toBe('cursor-after-1');
    expect(stored.status).toBe('ok');
    expect(stored.lastSyncedAt).toBeTruthy();
  });

  it('a second sync from the stored cursor with no changes writes nothing new and refreshes accounts', async () => {
    await syncPlaidItem(db, item, new FakePlaid(fixtureAccounts, [page({ added: fixtureAdded, nextCursor: 'c1' })]));
    const again = await syncPlaidItem(db, { ...item, cursor: 'c1' }, new FakePlaid(fixtureAccounts, [page({ nextCursor: 'c2' })]));
    expect(again).toMatchObject({ accountsCreated: 0, accountsUpdated: fixtureAccounts.length, added: 0, modified: 0, removed: 0, cursor: 'c2' });
    expect(await db.select().from(transactions)).toHaveLength(fixtureAdded.length);
  });

  it('replaying the same page is idempotent on the provider id', async () => {
    const pages = [page({ added: fixtureAdded, nextCursor: 'c1' }), page({ added: fixtureAdded, nextCursor: 'c1' })];
    await syncPlaidItem(db, item, new FakePlaid(fixtureAccounts, [pages[0]!]));
    const second = await syncPlaidItem(db, item, new FakePlaid(fixtureAccounts, [pages[1]!]));
    expect(second.added).toBe(0);
    expect(await db.select().from(transactions)).toHaveLength(fixtureAdded.length);
  });

  it('walks every page while hasMore, persisting the cursor after each', async () => {
    const [a, b, ...rest] = fixtureAdded;
    const client = new FakePlaid(fixtureAccounts, [
      page({ added: [a!], nextCursor: 'p1', hasMore: true }),
      page({ added: [b!], nextCursor: 'p2', hasMore: true }),
      page({ added: rest, nextCursor: 'p3', hasMore: false }),
    ]);
    const summary = await syncPlaidItem(db, item, client);
    expect(summary.pages).toBe(3);
    expect(summary.added).toBe(fixtureAdded.length);
    expect(client.syncCalls).toEqual([null, 'p1', 'p2']);
    expect((await db.select().from(plaidItems))[0]!.cursor).toBe('p3');
  });
});

describe('syncPlaidItem — changes after the first sync', () => {
  async function seeded(): Promise<void> {
    await syncPlaidItem(db, item, new FakePlaid(fixtureAccounts, [page({ added: fixtureAdded, nextCursor: 'c1' })]));
  }

  it('a modified transaction updates the existing row in place (amount, date, description)', async () => {
    await seeded();
    const before = (await db.select().from(transactions).where(eq(transactions.externalId, sample.transactionId)))[0]!;
    const changed: PlaidTransaction = { ...sample, amount: sample.amount + 1, date: '2026-09-12', name: 'RENAMED BY THE BANK' };
    const summary = await syncPlaidItem(db, { ...item, cursor: 'c1' }, new FakePlaid(fixtureAccounts, [page({ modified: [changed], nextCursor: 'c2' })]));
    expect(summary.modified).toBe(1);
    const after = (await db.select().from(transactions).where(eq(transactions.externalId, sample.transactionId)))[0]!;
    expect(after.id).toBe(before.id);
    expect(after.amountCents).toBe(-Math.round((sample.amount + 1) * 100));
    expect(after.postedDate).toBe('2026-09-12');
    expect(await db.select().from(transactions)).toHaveLength(fixtureAdded.length);
  });

  it('a pending transaction that posts keeps our row id — and the match hanging off it', async () => {
    const pending: PlaidTransaction = { ...sample, transactionId: 'pending-1', pending: true, amount: 40, date: '2026-09-15' };
    await syncPlaidItem(db, item, new FakePlaid(fixtureAccounts, [page({ added: [pending], nextCursor: 'c1' })]));
    const row = (await db.select().from(transactions).where(eq(transactions.externalId, 'pending-1')))[0]!;
    expect(row.pending).toBe(true);
    await db.insert(matches).values(manualMatch('m-1', row.id));

    const posted: PlaidTransaction = { ...pending, transactionId: 'posted-1', pending: false, pendingTransactionId: 'pending-1', amount: 41.5, date: '2026-09-16' };
    const summary = await syncPlaidItem(db, { ...item, cursor: 'c1' }, new FakePlaid(fixtureAccounts, [
      page({ added: [posted], removed: [{ transactionId: 'pending-1', accountId: pending.accountId }], nextCursor: 'c2' }),
    ]));
    expect(summary).toMatchObject({ pendingResolved: 1, added: 0, removed: 0 });

    const rows = await db.select().from(transactions).where(eq(transactions.accountId, row.accountId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: row.id, externalId: 'posted-1', pendingExternalId: 'pending-1', pending: false, amountCents: -4150, postedDate: '2026-09-16' });
    expect(await db.select().from(matches).where(eq(matches.transactionId, row.id))).toHaveLength(1);
  });

  it('a removed transaction (no replacement) is deleted together with its matches', async () => {
    await seeded();
    const row = (await db.select().from(transactions).where(eq(transactions.externalId, sample.transactionId)))[0]!;
    await db.insert(matches).values(manualMatch('m-gone', row.id));
    const summary = await syncPlaidItem(db, { ...item, cursor: 'c1' }, new FakePlaid(fixtureAccounts, [
      page({ removed: [{ transactionId: sample.transactionId, accountId: sample.accountId }], nextCursor: 'c2' }),
    ]));
    expect(summary.removed).toBe(1);
    expect(await db.select().from(transactions).where(eq(transactions.externalId, sample.transactionId))).toHaveLength(0);
    expect(await db.select().from(matches).where(eq(matches.id, 'm-gone'))).toHaveLength(0);
    expect(await db.select().from(transactions)).toHaveLength(fixtureAdded.length - 1);
  });

  it('a line for an account the Item did not report is skipped, never written to another household', async () => {
    const stranger: PlaidTransaction = { ...sample, transactionId: 'x-1', accountId: 'acct-not-in-item' };
    const summary = await syncPlaidItem(db, item, new FakePlaid(fixtureAccounts, [page({ added: [stranger], nextCursor: 'c1' })]));
    expect(summary).toMatchObject({ added: 0, skippedUnknownAccount: 1 });
    expect(await db.select().from(transactions)).toHaveLength(0);
  });

  it('a Plaid failure marks the Item and rethrows; ITEM_LOGIN_REQUIRED is its own status', async () => {
    const failing: PlaidClient = {
      async accountsGet() { return fixtureAccounts; },
      async transactionsSync() { throw new Error('ITEM_LOGIN_REQUIRED: the login details of this item have changed'); },
    };
    await expect(syncPlaidItem(db, item, failing)).rejects.toThrow(/ITEM_LOGIN_REQUIRED/);
    const stored = (await db.select().from(plaidItems))[0]!;
    expect(stored.status).toBe('login_required');
    expect(stored.lastError).toMatch(/ITEM_LOGIN_REQUIRED/);
    expect(stored.cursor).toBeNull();

    const broken: PlaidClient = { async accountsGet() { throw new Error('RATE_LIMIT_EXCEEDED'); }, async transactionsSync() { return page({}); } };
    await expect(syncPlaidItem(db, item, broken)).rejects.toThrow(/RATE_LIMIT/);
    expect((await db.select().from(plaidItems))[0]!.status).toBe('error');
  });

  it('replaying the page that folded a pending line into its posted one is a no-op — no duplicate, no UNIQUE error', async () => {
    const pending: PlaidTransaction = { ...sample, transactionId: 'pending-2', pending: true, amount: 40, date: '2026-09-15' };
    await syncPlaidItem(db, item, new FakePlaid(fixtureAccounts, [page({ added: [pending], nextCursor: 'c1' })]));
    const posted: PlaidTransaction = { ...pending, transactionId: 'posted-2', pending: false, pendingTransactionId: 'pending-2', amount: 41.5, date: '2026-09-16' };
    const collapse = () => page({ added: [posted], removed: [{ transactionId: 'pending-2', accountId: pending.accountId }], nextCursor: 'c2' });

    await syncPlaidItem(db, { ...item, cursor: 'c1' }, new FakePlaid(fixtureAccounts, [collapse()]));
    // A crash after the page was applied but before the cursor persisted would replay it —
    // and so would a provider that resends the pending line itself.
    const replay = await syncPlaidItem(db, { ...item, cursor: 'c1' }, new FakePlaid(fixtureAccounts, [collapse()]));
    const resend = await syncPlaidItem(db, { ...item, cursor: 'c1' }, new FakePlaid(fixtureAccounts, [page({ added: [pending, posted], nextCursor: 'c3' })]));

    expect(replay).toMatchObject({ added: 0, pendingResolved: 0, removed: 0 });
    expect(resend).toMatchObject({ added: 0, pendingResolved: 0, removed: 0 });
    const rows = await db.select().from(transactions).where(eq(transactions.accountId, (await db.select().from(accounts).where(eq(accounts.externalId, pending.accountId)))[0]!.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ externalId: 'posted-2', pendingExternalId: 'pending-2', pending: false, amountCents: -4150 });
  });

  it('a removed entry for an account this Item did not report touches nothing — not even a same-id line in another household', async () => {
    await seeded();
    await db.insert(households).values({ id: 'hh-other', name: 'Other household' });
    await db.insert(accounts).values({ id: 'acct-other', householdId: 'hh-other', name: 'Their checking', type: 'checking', source: 'file' });
    await db.insert(transactions).values({
      id: 'tx-other', accountId: 'acct-other', postedDate: '2026-09-01', amountCents: -100, direction: 'debit', normalizedMerchant: 'x', sourceRowHash: 'h', dedupKey: 'k', externalId: sample.transactionId,
    });

    const summary = await syncPlaidItem(db, { ...item, cursor: 'c1' }, new FakePlaid(fixtureAccounts, [
      page({ removed: [{ transactionId: sample.transactionId, accountId: null }, { transactionId: sample.transactionId, accountId: 'acct-not-in-item' }], nextCursor: 'c2' }),
    ]));
    expect(summary).toMatchObject({ removed: 0, skippedUnknownAccount: 2 });
    expect(await db.select().from(transactions).where(eq(transactions.id, 'tx-other'))).toHaveLength(1);
    expect(await db.select().from(transactions).where(eq(transactions.externalId, sample.transactionId))).toHaveLength(2);
  });

  it('a modified line whose amount changed withdraws the human’s manual match; a reworded line keeps it', async () => {
    await seeded();
    const row = (await db.select().from(transactions).where(eq(transactions.externalId, sample.transactionId)))[0]!;
    await db.insert(matches).values(manualMatch('m-keep', row.id));

    const reworded = await syncPlaidItem(db, { ...item, cursor: 'c1' }, new FakePlaid(fixtureAccounts, [page({ modified: [{ ...sample, name: 'SAME MONEY, NEW WORDS' }], nextCursor: 'c2' })]));
    expect(reworded).toMatchObject({ modified: 1, matchesReset: 0 });
    expect(await db.select().from(matches).where(eq(matches.id, 'm-keep'))).toHaveLength(1);

    const repriced = await syncPlaidItem(db, { ...item, cursor: 'c2' }, new FakePlaid(fixtureAccounts, [page({ modified: [{ ...sample, amount: sample.amount + 5 }], nextCursor: 'c3' })]));
    expect(repriced).toMatchObject({ modified: 1, matchesReset: 1 });
    expect(await db.select().from(matches).where(eq(matches.id, 'm-keep'))).toHaveLength(0);
    expect((await db.select().from(transactions).where(eq(transactions.id, row.id)))[0]!.amountCents).toBe(-Math.round((sample.amount + 5) * 100));
  });

  it('a page that claims more but does not move the cursor stops the sync instead of looping', async () => {
    const stuck: PlaidClient = {
      async accountsGet() { return fixtureAccounts; },
      async transactionsSync(_t, cursor) { return page({ added: [], nextCursor: cursor ?? 'same', hasMore: true }); },
    };
    await expect(syncPlaidItem(db, { ...item, cursor: 'same' }, stuck)).rejects.toThrow(/did not advance/);
    expect((await db.select().from(plaidItems))[0]!.status).toBe('error');
  });

  it('a provider that never stops saying "more" is cut off at the page cap, keeping the last cursor', async () => {
    let n = 0;
    const endless: PlaidClient = {
      async accountsGet() { return fixtureAccounts; },
      async transactionsSync() { n += 1; return page({ nextCursor: `p${n}`, hasMore: true }); },
    };
    await expect(syncPlaidItem(db, item, endless)).rejects.toThrow(/200 pages/);
    expect(n).toBe(200);
    expect((await db.select().from(plaidItems))[0]!.cursor).toBe('p200');
  });

  it('surfaces Plaid’s update status so a fresh Item’s empty first page reads as "not ready", not "no activity"', async () => {
    const summary = await syncPlaidItem(db, item, new FakePlaid(fixtureAccounts, [page({ nextCursor: 'c1', updateStatus: 'not_ready' })]));
    expect(summary).toMatchObject({ added: 0, updateStatus: 'not_ready', cursor: 'c1' });
  });

  it('accounts are created for the Item’s household only and renamed on later syncs', async () => {
    await seeded();
    const renamed = fixtureAccounts.map((a) => (a.accountId === sample.accountId ? { ...a, officialName: 'Renamed Checking' } : a));
    await syncPlaidItem(db, { ...item, cursor: 'c1' }, new FakePlaid(renamed, [page({ nextCursor: 'c2' })]));
    const row = (await db.select().from(accounts).where(eq(accounts.externalId, sample.accountId)))[0]!;
    expect(row.name.startsWith('Renamed Checking')).toBe(true);
    expect(row.householdId).toBe(HH);
  });
});
