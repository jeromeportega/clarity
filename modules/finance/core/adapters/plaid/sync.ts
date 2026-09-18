import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';

import type { FinanceDb } from '../../../db/client';
import { accounts, matches, plaidItems, transactions } from '../../../db/schema';
import { transactionDedupKey } from '../../idempotency/keys';
import { accountNameFor, accountTypeFor, normalizePlaidTransaction, type NormalizedPlaidTransaction } from './normalize';
import type { PlaidAccount, PlaidClient, PlaidSyncPage } from './plaid-client';

// =============================================================================
// Bank sync through Plaid: one Item (institution login) at a time.
//
//   accountsGet → upsert our `accounts` rows for the Item
//   transactionsSync (cursor) → for every page, in one DB transaction:
//     added     → insert (idempotent on the provider id); a posted transaction
//                 that names the pending one it replaces UPDATES that row in
//                 place, so our id — and every match or decision hanging off
//                 it — survives the pending → posted flip
//     modified  → update the row by provider id (amount, date, name, pending)
//     removed   → delete the row and its matches, unless it was just replaced
//     cursor    → persisted with the page, so a crash resumes from the last
//                 processed page, never re-applies one, never skips one
//
// The core never sees a credential store: the caller hands in the decrypted
// access token for this call only. The core never imports the Plaid SDK — it
// speaks to the `PlaidClient` port.
// =============================================================================

export interface PlaidItemToSync {
  id: string;
  householdId: string;
  /** Decrypted for this call by the app layer. */
  accessToken: string;
  cursor: string | null;
  institutionName: string | null;
}

export interface PlaidSyncSummary {
  accountsCreated: number;
  accountsUpdated: number;
  added: number;
  modified: number;
  removed: number;
  /** Posted transactions that replaced a pending row in place. */
  pendingResolved: number;
  /** Lines for an account this Item did not report — never written. */
  skippedUnknownAccount: number;
  pages: number;
  cursor: string | null;
}

export async function syncPlaidItem(
  db: FinanceDb,
  item: PlaidItemToSync,
  client: PlaidClient,
  opts: { now?: () => Date } = {},
): Promise<PlaidSyncSummary> {
  const now = opts.now ?? (() => new Date());
  const summary: PlaidSyncSummary = {
    accountsCreated: 0,
    accountsUpdated: 0,
    added: 0,
    modified: 0,
    removed: 0,
    pendingResolved: 0,
    skippedUnknownAccount: 0,
    pages: 0,
    cursor: item.cursor,
  };

  try {
    const accountIds = await upsertAccounts(db, item, await client.accountsGet(item.accessToken), summary);

    let cursor = item.cursor;
    let hasMore = true;
    while (hasMore) {
      const page = await client.transactionsSync(item.accessToken, cursor);
      await db.transaction(async (tx) => {
        await applyPage(tx, page, accountIds, summary);
        await tx
          .update(plaidItems)
          .set({ cursor: page.nextCursor, lastSyncedAt: now().toISOString(), status: 'ok', lastError: null })
          .where(eq(plaidItems.id, item.id));
      });
      cursor = page.nextCursor;
      summary.cursor = cursor;
      summary.pages += 1;
      hasMore = page.hasMore;
    }
    return summary;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(plaidItems)
      .set({ status: isLoginRequired(message) ? 'login_required' : 'error', lastError: message.slice(0, 500) })
      .where(eq(plaidItems.id, item.id));
    throw err;
  }
}

// Plaid's ITEM_LOGIN_REQUIRED means the person must re-authenticate at the bank
// through Link; every other failure is ours or transient.
function isLoginRequired(message: string): boolean {
  return /ITEM_LOGIN_REQUIRED/.test(message);
}

type Tx = Parameters<Parameters<FinanceDb['transaction']>[0]>[0];

/** Our account id per Plaid account id, creating or refreshing rows as needed. */
async function upsertAccounts(
  db: FinanceDb,
  item: PlaidItemToSync,
  reported: PlaidAccount[],
  summary: PlaidSyncSummary,
): Promise<Map<string, string>> {
  const existing = await db
    .select({ id: accounts.id, externalId: accounts.externalId })
    .from(accounts)
    .where(eq(accounts.plaidItemId, item.id));
  const byExternal = new Map(existing.map((a) => [a.externalId ?? '', a.id]));

  const ids = new Map<string, string>();
  for (const a of reported) {
    const fields = {
      name: accountNameFor(a),
      type: accountTypeFor(a),
      institution: item.institutionName,
      subtype: a.subtype,
      mask: a.mask,
    };
    const known = byExternal.get(a.accountId);
    if (known) {
      await db.update(accounts).set(fields).where(eq(accounts.id, known));
      ids.set(a.accountId, known);
      summary.accountsUpdated += 1;
      continue;
    }
    const id = randomUUID();
    await db.insert(accounts).values({
      id,
      householdId: item.householdId,
      source: 'plaid',
      plaidItemId: item.id,
      externalId: a.accountId,
      ...fields,
    });
    ids.set(a.accountId, id);
    summary.accountsCreated += 1;
  }
  return ids;
}

async function applyPage(tx: Tx, page: PlaidSyncPage, accountIds: Map<string, string>, summary: PlaidSyncSummary): Promise<void> {
  // Pending ids consumed by a posted replacement in THIS page: their `removed`
  // entry (Plaid sends both) must not delete the row we just updated.
  const replaced = new Set<string>();

  for (const raw of page.added) {
    const accountId = accountIds.get(raw.accountId);
    if (!accountId) {
      summary.skippedUnknownAccount += 1;
      continue;
    }
    const n = normalizePlaidTransaction(raw);

    if (n.pendingExternalId) {
      const pendingRow = await findByExternalId(tx, accountId, n.pendingExternalId);
      if (pendingRow) {
        await tx.update(transactions).set(rowFields(accountId, n)).where(eq(transactions.id, pendingRow.id));
        replaced.add(n.pendingExternalId);
        summary.pendingResolved += 1;
        continue;
      }
    }

    const res = await tx
      .insert(transactions)
      .values({ id: randomUUID(), ...rowFields(accountId, n) })
      .onConflictDoNothing();
    if (rowsAffected(res) > 0) summary.added += 1;
  }

  for (const raw of page.modified) {
    const accountId = accountIds.get(raw.accountId);
    if (!accountId) {
      summary.skippedUnknownAccount += 1;
      continue;
    }
    const n = normalizePlaidTransaction(raw);
    const row = await findByExternalId(tx, accountId, n.externalId);
    if (row) {
      await tx.update(transactions).set(rowFields(accountId, n)).where(eq(transactions.id, row.id));
      summary.modified += 1;
    } else {
      // A modification for something we never saw: it is new to us.
      const res = await tx
        .insert(transactions)
        .values({ id: randomUUID(), ...rowFields(accountId, n) })
        .onConflictDoNothing();
      if (rowsAffected(res) > 0) summary.added += 1;
    }
  }

  for (const gone of page.removed) {
    if (replaced.has(gone.transactionId)) continue;
    const accountId = accountIds.get(gone.accountId);
    const row = accountId ? await findByExternalId(tx, accountId, gone.transactionId) : await findByExternalIdAnyAccount(tx, gone.transactionId);
    if (!row) continue;
    // The bank no longer shows this line, so nothing can be matched to it.
    await tx.delete(matches).where(eq(matches.transactionId, row.id));
    await tx.delete(transactions).where(eq(transactions.id, row.id));
    summary.removed += 1;
  }
}

function rowFields(accountId: string, n: NormalizedPlaidTransaction) {
  return {
    accountId,
    postedDate: n.postedDate,
    amountCents: n.amountCents,
    direction: n.direction,
    rawMerchant: n.rawMerchant ?? null,
    normalizedMerchant: n.normalizedMerchant,
    sourceRowHash: n.sourceRowHash,
    dedupKey: transactionDedupKey({
      accountId,
      postedDate: n.postedDate,
      amountCents: n.amountCents,
      normalizedMerchant: n.normalizedMerchant,
      sourceRowHash: n.sourceRowHash,
    }),
    externalId: n.externalId,
    pending: n.pending,
    pendingExternalId: n.pendingExternalId,
    categoryHint: n.categoryHint,
  };
}

async function findByExternalId(tx: Tx, accountId: string, externalId: string): Promise<{ id: string } | undefined> {
  const rows = await tx
    .select({ id: transactions.id })
    .from(transactions)
    .where(and(eq(transactions.accountId, accountId), eq(transactions.externalId, externalId)))
    .limit(1);
  return rows[0];
}

async function findByExternalIdAnyAccount(tx: Tx, externalId: string): Promise<{ id: string } | undefined> {
  const rows = await tx.select({ id: transactions.id }).from(transactions).where(eq(transactions.externalId, externalId)).limit(1);
  return rows[0];
}

function rowsAffected(res: unknown): number {
  const r = res as { rowsAffected?: number; changes?: number };
  return r.rowsAffected ?? r.changes ?? 0;
}
