import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FinanceDb } from '../../db/client';
import { households, receiptItems, receipts, reviewDecisions } from '../../db/schema';
import type {
  AmbiguousMatchGroup,
  HouseholdScope,
  Match,
  ReconciliationGateway,
  SpendRollup,
  Transaction,
} from '../reconciliation/types';
import { assembleQueue } from './assemble';

// ---------------------------------------------------------------------------
// Isolated test DB helper
//
// Uses a SUBDIRECTORY of tmpdir (not the top-level) so the `readdirSync(tmpdir())`
// scan in modules/finance/db/client.test.ts does not count these files and
// cannot cause that test's "cleanup() removes the temp file with no leak"
// assertion to fail under parallel test execution.
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../db/migrations',
);

async function applyMigrations(client: ReturnType<typeof createClient>): Promise<void> {
  if (!existsSync(MIGRATIONS_DIR)) return;
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    if (sql.trim().length > 0) {
      await client.executeMultiple(sql);
    }
  }
}

async function createQueueTestDb(): Promise<{ db: FinanceDb; cleanup: () => void }> {
  const subdir = mkdtempSync(join(tmpdir(), 'clarity-queue-test-'));
  const file = join(subdir, 'test.db');
  const client = createClient({ url: `file:${file}` });
  const db = drizzle(client);
  await applyMigrations(client);

  const cleanup = (): void => {
    try { client.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      rmSync(`${file}${suffix}`, { force: true });
    }
    rmSync(subdir, { recursive: true, force: true });
  };

  return { db, cleanup };
}

// ---------------------------------------------------------------------------
// Stub gateway — injected per-test with controlled data
// ---------------------------------------------------------------------------

class ControlledGateway implements ReconciliationGateway {
  constructor(
    private readonly ambiguousGroups: AmbiguousMatchGroup[] = [],
    private readonly unmatchedTxns: Transaction[] = [],
  ) {}

  async listMatches(): Promise<Match[]> { return []; }
  async getAmbiguousMatchGroups(): Promise<AmbiguousMatchGroup[]> {
    return this.ambiguousGroups;
  }
  async listUnmatchedTransactions(): Promise<Transaction[]> {
    return this.unmatchedTxns;
  }
  async getRollups(): Promise<SpendRollup[]> { return []; }
  async recomputeRollups(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

const HOUSEHOLD_A = 'test-household-aaaa';
const HOUSEHOLD_B = 'test-household-bbbb';

async function seedHousehold(db: FinanceDb, id: string): Promise<void> {
  await db.insert(households).values({ id, name: `Household ${id}` });
}

async function seedReceipt(
  db: FinanceDb,
  householdId: string,
  opts: { id?: string; needsReview?: boolean; store?: string; totalCents?: number } = {},
): Promise<string> {
  const id = opts.id ?? randomUUID();
  await db.insert(receipts).values({
    id,
    householdId,
    source: 'test',
    store: opts.store ?? 'Test Store',
    purchasedAt: '2025-01-15',
    totalCents: opts.totalCents ?? 1000,
    needsReview: opts.needsReview ?? false,
  });
  return id;
}

async function seedReceiptItem(
  db: FinanceDb,
  receiptId: string,
  opts: {
    id?: string;
    needsReview?: boolean;
    rawDescription?: string;
    linePriceCents?: number;
  } = {},
): Promise<string> {
  const id = opts.id ?? randomUUID();
  await db.insert(receiptItems).values({
    id,
    receiptId,
    lineNo: 1,
    rawDescription: opts.rawDescription ?? 'TEST ITEM',
    quantity: 1,
    linePriceCents: opts.linePriceCents ?? 500,
    needsReview: opts.needsReview ?? false,
  });
  return id;
}

async function seedDecision(
  db: FinanceDb,
  householdId: string,
  itemType: string,
  itemId: string,
  decision: 'confirm' | 'correct' | 'dismiss' = 'confirm',
): Promise<void> {
  await db.insert(reviewDecisions).values({
    id: randomUUID(),
    householdId,
    itemType,
    itemId,
    decision,
  });
}

function makeTxn(id: string, householdId: string, merchant = 'ACME STORE'): Transaction {
  return {
    id,
    householdId,
    accountId: 'acct-test-001',
    postedDate: '2025-01-10',
    amountCents: -1500,
    direction: 'debit',
    normalizedMerchant: merchant,
  };
}

function makeGroup(transactionId: string): AmbiguousMatchGroup {
  const candidates: Match[] = [
    {
      id: `match-${transactionId}-a`,
      transactionId,
      orderItemId: 'oi-001',
      receiptItemId: null,
      status: 'ambiguous',
      confidence: 0.7,
      method: 'fuzzy_merchant',
    },
    {
      id: `match-${transactionId}-b`,
      transactionId,
      orderItemId: null,
      receiptItemId: 'ri-001',
      status: 'ambiguous',
      confidence: 0.6,
      method: 'fuzzy_merchant',
    },
  ];
  return { transactionId, candidates };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('assembleQueue', () => {
  let db: FinanceDb;
  let cleanup: () => void;

  beforeEach(async () => {
    const handle = await createQueueTestDb();
    db = handle.db;
    cleanup = handle.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  // -------------------------------------------------------------------------
  // All-four-sources coverage (headline AC)
  // -------------------------------------------------------------------------

  it('returns one item per source when one qualifying row exists in each', async () => {
    const scope: HouseholdScope = { householdId: HOUSEHOLD_A };
    await seedHousehold(db, HOUSEHOLD_A);

    const receiptId = await seedReceipt(db, HOUSEHOLD_A);
    await seedReceiptItem(db, receiptId, { needsReview: true, rawDescription: 'MILK 1GAL' });

    const txnId1 = randomUUID();
    const txnId2 = randomUUID();
    const gw = new ControlledGateway([makeGroup(txnId1)], [makeTxn(txnId2, HOUSEHOLD_A)]);

    await seedReceipt(db, HOUSEHOLD_A, { needsReview: true, store: 'Costco' });

    const items = await assembleQueue(scope, gw, db);

    const types = items.map((i) => i.type);
    expect(types).toContain('sku_resolution');
    expect(types).toContain('ambiguous_match');
    expect(types).toContain('unmatched_txn');
    expect(types).toContain('flagged_receipt');
  });

  it('each item has a non-empty reason string', async () => {
    const scope: HouseholdScope = { householdId: HOUSEHOLD_A };
    await seedHousehold(db, HOUSEHOLD_A);

    const receiptId = await seedReceipt(db, HOUSEHOLD_A);
    await seedReceiptItem(db, receiptId, { needsReview: true });

    const txnId1 = randomUUID();
    const txnId2 = randomUUID();
    const gw = new ControlledGateway([makeGroup(txnId1)], [makeTxn(txnId2, HOUSEHOLD_A)]);
    await seedReceipt(db, HOUSEHOLD_A, { needsReview: true });

    const items = await assembleQueue(scope, gw, db);
    for (const item of items) {
      expect(item.reason.length).toBeGreaterThan(0);
    }
  });

  // -------------------------------------------------------------------------
  // 100%-membership — N rows → N items, no drops, no duplicates
  // -------------------------------------------------------------------------

  it('surfaces all N sku_resolution items when N qualifying receipt_items exist', async () => {
    const scope: HouseholdScope = { householdId: HOUSEHOLD_A };
    await seedHousehold(db, HOUSEHOLD_A);

    const receiptId = await seedReceipt(db, HOUSEHOLD_A);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await seedReceiptItem(db, receiptId, { needsReview: true }));
    }

    const items = await assembleQueue(scope, new ControlledGateway(), db);
    const skuItems = items.filter((i) => i.type === 'sku_resolution');
    expect(skuItems).toHaveLength(5);
    expect(skuItems.map((i) => i.id).sort()).toEqual([...ids].sort());
  });

  it('surfaces all N flagged_receipt items when N qualifying receipts exist', async () => {
    const scope: HouseholdScope = { householdId: HOUSEHOLD_A };
    await seedHousehold(db, HOUSEHOLD_A);

    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push(await seedReceipt(db, HOUSEHOLD_A, { needsReview: true }));
    }

    const items = await assembleQueue(scope, new ControlledGateway(), db);
    const flagged = items.filter((i) => i.type === 'flagged_receipt');
    expect(flagged).toHaveLength(4);
    expect(flagged.map((i) => i.id).sort()).toEqual([...ids].sort());
  });

  it('surfaces all N ambiguous_match items from the gateway', async () => {
    const scope: HouseholdScope = { householdId: HOUSEHOLD_A };
    await seedHousehold(db, HOUSEHOLD_A);

    const txnIds = [randomUUID(), randomUUID(), randomUUID()];
    const gw = new ControlledGateway(txnIds.map(makeGroup), []);

    const items = await assembleQueue(scope, gw, db);
    const ambiguous = items.filter((i) => i.type === 'ambiguous_match');
    expect(ambiguous).toHaveLength(3);
    expect(ambiguous.map((i) => i.id).sort()).toEqual([...txnIds].sort());
  });

  it('surfaces all N unmatched_txn items from the gateway', async () => {
    const scope: HouseholdScope = { householdId: HOUSEHOLD_A };
    await seedHousehold(db, HOUSEHOLD_A);

    const txns = [
      makeTxn(randomUUID(), HOUSEHOLD_A, 'WHOLE FOODS'),
      makeTxn(randomUUID(), HOUSEHOLD_A, 'TARGET'),
      makeTxn(randomUUID(), HOUSEHOLD_A, 'COSTCO'),
    ];
    const gw = new ControlledGateway([], txns);

    const items = await assembleQueue(scope, gw, db);
    const unmatched = items.filter((i) => i.type === 'unmatched_txn');
    expect(unmatched).toHaveLength(3);
    expect(unmatched.map((i) => i.id).sort()).toEqual(txns.map((t) => t.id).sort());
  });

  // -------------------------------------------------------------------------
  // Anti-join correctness
  // -------------------------------------------------------------------------

  it('excludes a decided sku_resolution item while its siblings remain', async () => {
    const scope: HouseholdScope = { householdId: HOUSEHOLD_A };
    await seedHousehold(db, HOUSEHOLD_A);

    const receiptId = await seedReceipt(db, HOUSEHOLD_A);
    const [idA, idB, idC] = await Promise.all([
      seedReceiptItem(db, receiptId, { needsReview: true }),
      seedReceiptItem(db, receiptId, { needsReview: true }),
      seedReceiptItem(db, receiptId, { needsReview: true }),
    ]);

    await seedDecision(db, HOUSEHOLD_A, 'sku_resolution', idA);

    const items = await assembleQueue(scope, new ControlledGateway(), db);
    const skuIds = items.filter((i) => i.type === 'sku_resolution').map((i) => i.id);
    expect(skuIds).not.toContain(idA);
    expect(skuIds).toContain(idB);
    expect(skuIds).toContain(idC);
  });

  it('excludes a decided unmatched_txn while other items remain', async () => {
    const scope: HouseholdScope = { householdId: HOUSEHOLD_A };
    await seedHousehold(db, HOUSEHOLD_A);

    const txnA = makeTxn(randomUUID(), HOUSEHOLD_A);
    const txnB = makeTxn(randomUUID(), HOUSEHOLD_A);
    const gw = new ControlledGateway([], [txnA, txnB]);

    await seedDecision(db, HOUSEHOLD_A, 'unmatched_txn', txnA.id);

    const items = await assembleQueue(scope, gw, db);
    const unmatchedIds = items.filter((i) => i.type === 'unmatched_txn').map((i) => i.id);
    expect(unmatchedIds).not.toContain(txnA.id);
    expect(unmatchedIds).toContain(txnB.id);
  });

  it('does NOT filter an item whose item_id matches but item_type differs (anti-join is type+id)', async () => {
    const scope: HouseholdScope = { householdId: HOUSEHOLD_A };
    await seedHousehold(db, HOUSEHOLD_A);

    const txnId = randomUUID();
    const gw = new ControlledGateway([makeGroup(txnId)], [makeTxn(txnId, HOUSEHOLD_A)]);

    // Decide only under unmatched_txn; the same id under ambiguous_match must survive
    await seedDecision(db, HOUSEHOLD_A, 'unmatched_txn', txnId);

    const items = await assembleQueue(scope, gw, db);
    const ambiguous = items.filter((i) => i.type === 'ambiguous_match');
    const unmatched = items.filter((i) => i.type === 'unmatched_txn');

    expect(ambiguous.map((i) => i.id)).toContain(txnId);   // NOT filtered
    expect(unmatched.map((i) => i.id)).not.toContain(txnId); // filtered
  });

  // -------------------------------------------------------------------------
  // Negative / boundary cases
  // -------------------------------------------------------------------------

  it('returns an empty array when the DB has no qualifying rows and gateway returns empty', async () => {
    const scope: HouseholdScope = { householdId: HOUSEHOLD_A };
    await seedHousehold(db, HOUSEHOLD_A);

    const items = await assembleQueue(scope, new ControlledGateway(), db);
    expect(items).toEqual([]);
  });

  it('does not surface receipt_items with needs_review=0', async () => {
    const scope: HouseholdScope = { householdId: HOUSEHOLD_A };
    await seedHousehold(db, HOUSEHOLD_A);

    const receiptId = await seedReceipt(db, HOUSEHOLD_A);
    await seedReceiptItem(db, receiptId, { needsReview: false });

    const items = await assembleQueue(scope, new ControlledGateway(), db);
    expect(items.filter((i) => i.type === 'sku_resolution')).toHaveLength(0);
  });

  it('does not surface receipts with needs_review=0 as flagged_receipt', async () => {
    const scope: HouseholdScope = { householdId: HOUSEHOLD_A };
    await seedHousehold(db, HOUSEHOLD_A);

    await seedReceipt(db, HOUSEHOLD_A, { needsReview: false });

    const items = await assembleQueue(scope, new ControlledGateway(), db);
    expect(items.filter((i) => i.type === 'flagged_receipt')).toHaveLength(0);
  });

  it('sku_resolution items carry amountCents from linePriceCents', async () => {
    const scope: HouseholdScope = { householdId: HOUSEHOLD_A };
    await seedHousehold(db, HOUSEHOLD_A);

    const receiptId = await seedReceipt(db, HOUSEHOLD_A);
    await seedReceiptItem(db, receiptId, { needsReview: true, linePriceCents: -399 });

    const items = await assembleQueue(scope, new ControlledGateway(), db);
    const skuItem = items.find((i) => i.type === 'sku_resolution');
    expect(skuItem?.amountCents).toBe(-399);
  });

  it('unmatched_txn items carry amountCents from the transaction', async () => {
    const scope: HouseholdScope = { householdId: HOUSEHOLD_A };
    await seedHousehold(db, HOUSEHOLD_A);

    const txn = makeTxn(randomUUID(), HOUSEHOLD_A);
    const gw = new ControlledGateway([], [txn]);

    const items = await assembleQueue(scope, gw, db);
    const unmatchedItem = items.find((i) => i.type === 'unmatched_txn');
    expect(unmatchedItem?.amountCents).toBe(txn.amountCents);
  });

  it('flagged_receipt items carry amountCents from totalCents', async () => {
    const scope: HouseholdScope = { householdId: HOUSEHOLD_A };
    await seedHousehold(db, HOUSEHOLD_A);

    await seedReceipt(db, HOUSEHOLD_A, { needsReview: true, totalCents: 5499 });

    const items = await assembleQueue(scope, new ControlledGateway(), db);
    const flaggedItem = items.find((i) => i.type === 'flagged_receipt');
    expect(flaggedItem?.amountCents).toBe(5499);
  });

  it('ambiguous_match items do not carry amountCents (gateway has no amount)', async () => {
    const scope: HouseholdScope = { householdId: HOUSEHOLD_A };
    await seedHousehold(db, HOUSEHOLD_A);

    const txnId = randomUUID();
    const gw = new ControlledGateway([makeGroup(txnId)], []);

    const items = await assembleQueue(scope, gw, db);
    const ambiguousItem = items.find((i) => i.type === 'ambiguous_match');
    expect(ambiguousItem?.amountCents).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Scope isolation
  // -------------------------------------------------------------------------

  it('returns only items belonging to the requested householdId', async () => {
    await seedHousehold(db, HOUSEHOLD_A);
    await seedHousehold(db, HOUSEHOLD_B);

    const receiptIdA = await seedReceipt(db, HOUSEHOLD_A);
    const itemIdA = await seedReceiptItem(db, receiptIdA, { needsReview: true });
    await seedReceipt(db, HOUSEHOLD_A, { needsReview: true });

    // Household B data — must NOT appear in A's queue
    const receiptIdB = await seedReceipt(db, HOUSEHOLD_B);
    await seedReceiptItem(db, receiptIdB, { needsReview: true });
    await seedReceipt(db, HOUSEHOLD_B, { needsReview: true });

    const scopeA: HouseholdScope = { householdId: HOUSEHOLD_A };
    const items = await assembleQueue(scopeA, new ControlledGateway(), db);

    const skuItems = items.filter((i) => i.type === 'sku_resolution');
    const flaggedItems = items.filter((i) => i.type === 'flagged_receipt');

    expect(skuItems.map((i) => i.id)).toContain(itemIdA);
    expect(skuItems).toHaveLength(1);
    expect(flaggedItems).toHaveLength(1);
  });

  it('drops unmatched_txn items the gateway returned for the wrong household (defense-in-depth)', async () => {
    await seedHousehold(db, HOUSEHOLD_A);
    await seedHousehold(db, HOUSEHOLD_B);

    // Gateway returns txns attributed to HOUSEHOLD_B; we query HOUSEHOLD_A
    const txnB = makeTxn(randomUUID(), HOUSEHOLD_B);
    const gw = new ControlledGateway([], [txnB]);

    const items = await assembleQueue({ householdId: HOUSEHOLD_A }, gw, db);
    expect(items.filter((i) => i.type === 'unmatched_txn')).toHaveLength(0);
  });

  it('returns an empty array for an unknown householdId (no data, no crash)', async () => {
    const scope: HouseholdScope = { householdId: 'nonexistent-household' };
    await seedHousehold(db, HOUSEHOLD_A);

    const receiptId = await seedReceipt(db, HOUSEHOLD_A);
    await seedReceiptItem(db, receiptId, { needsReview: true });

    const items = await assembleQueue(scope, new ControlledGateway(), db);
    expect(items).toEqual([]);
  });
});
