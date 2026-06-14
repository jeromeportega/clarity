import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FinanceDb } from '../../db/client';
import {
  accounts,
  categories,
  households,
  matches,
  orderItems,
  orders,
  receiptItems,
  receipts,
  transactions,
} from '../../db/schema';
import type {
  AmbiguousMatchGroup,
  HouseholdScope,
  Match,
  ReconciliationGateway,
  SpendRollup,
  Transaction,
} from '../reconciliation/types';
import { assembleBreakdown } from './assemble';

// ---------------------------------------------------------------------------
// Test DB helpers
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
    const sqlText = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    if (sqlText.trim().length > 0) {
      await client.executeMultiple(sqlText);
    }
  }
}

async function createTrueSpendTestDb(): Promise<{ db: FinanceDb; cleanup: () => void }> {
  const subdir = mkdtempSync(join(tmpdir(), 'clarity-truespend-test-'));
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
// Controllable gateway — mutable rollups for testing correction propagation
// ---------------------------------------------------------------------------

class ControllableGateway implements ReconciliationGateway {
  private rollups: SpendRollup[];

  constructor(rollups: SpendRollup[] = []) {
    this.rollups = [...rollups];
  }

  setRollups(rollups: SpendRollup[]): void {
    this.rollups = [...rollups];
  }

  async getRollups(scope: HouseholdScope, opts?: { month?: string }): Promise<SpendRollup[]> {
    const all = this.rollups.filter((r) => r.key.householdId === scope.householdId);
    return opts?.month ? all.filter((r) => r.key.month === opts.month) : all;
  }

  async recomputeRollups(scope: HouseholdScope, affectedIds: string[]): Promise<void> {
    // Simulate a correction updating the groceries rollup by -100 cents per affected item
    for (const id of affectedIds) {
      const idx = this.rollups.findIndex(
        (r) => r.key.householdId === scope.householdId && r.key.category === 'groceries',
      );
      if (idx >= 0) {
        this.rollups[idx] = { ...this.rollups[idx]!, netCents: this.rollups[idx]!.netCents - 100 };
      }
    }
  }

  async listMatches(): Promise<Match[]> { return []; }
  async getAmbiguousMatchGroups(): Promise<AmbiguousMatchGroup[]> { return []; }
  async listUnmatchedTransactions(): Promise<Transaction[]> { return []; }
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const HOUSEHOLD_ID = 'test-household-ts-00000000-0000-0000-0000-000000000001';
const SCOPE: HouseholdScope = { householdId: HOUSEHOLD_ID };

async function seedHousehold(db: FinanceDb): Promise<void> {
  await db.insert(households).values({ id: HOUSEHOLD_ID, name: 'TrueSpend Test HH' });
}

async function seedCategory(db: FinanceDb, name: string): Promise<string> {
  const id = randomUUID();
  await db.insert(categories).values({ id, name });
  return id;
}

async function seedReceipt(db: FinanceDb, month: string): Promise<string> {
  const id = randomUUID();
  await db.insert(receipts).values({
    id,
    householdId: HOUSEHOLD_ID,
    source: 'manual',
    store: 'STORE',
    purchasedAt: `${month}-15`,
    totalCents: 0,
    needsReview: false,
  });
  return id;
}

async function seedReceiptItem(
  db: FinanceDb,
  receiptId: string,
  categoryId: string,
  lineNo: number,
  amountCents: number,
  description: string,
): Promise<string> {
  const id = randomUUID();
  await db.insert(receiptItems).values({
    id,
    receiptId,
    lineNo,
    rawDescription: description,
    canonicalName: description,
    categoryId,
    quantity: 1,
    linePriceCents: amountCents,
    needsReview: false,
  });
  return id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('assembleBreakdown', () => {
  let db: FinanceDb;
  let cleanup: () => void;

  beforeEach(async () => {
    ({ db, cleanup } = await createTrueSpendTestDb());
    await seedHousehold(db);
  });

  afterEach(() => cleanup());

  // -------------------------------------------------------------------------
  // Month filter boundary: empty month returns empty breakdown, not an error
  // -------------------------------------------------------------------------

  it('month with no spend returns empty breakdown, not an error', async () => {
    const gw = new ControllableGateway([]);
    const result = await assembleBreakdown(SCOPE, gw, db, '2025-03');
    expect(result.month).toBe('2025-03');
    expect(result.categories).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Month format validation: invalid month is treated as absent
  // -------------------------------------------------------------------------

  it('invalid month format is treated as absent (returns all months)', async () => {
    const rollup: SpendRollup = {
      key: { householdId: HOUSEHOLD_ID, category: 'groceries', month: '2025-01' },
      netCents: -500,
    };
    const gw = new ControllableGateway([rollup]);

    // A wildcard-like month should NOT expand to all rows; it is treated as absent
    const result = await assembleBreakdown(SCOPE, gw, db, '%');
    // Gateway is called without month filter → returns all rollups
    expect(result.categories.length).toBeGreaterThanOrEqual(1);
    // No LIKE wildcard abuse: the returned month is empty string (no valid month provided)
    expect(result.month).toBe('');
  });

  it('well-formed month is preserved in the result', async () => {
    const gw = new ControllableGateway([]);
    const result = await assembleBreakdown(SCOPE, gw, db, '2025-07');
    expect(result.month).toBe('2025-07');
  });

  // -------------------------------------------------------------------------
  // Totals come from gw.getRollups — NOT recomputed from DB items
  // -------------------------------------------------------------------------

  it('totals come from gw.getRollups, not recomputed from DB items', async () => {
    const rollup: SpendRollup = {
      key: { householdId: HOUSEHOLD_ID, category: 'groceries', month: '2025-01' },
      netCents: -5000,
    };
    const gw = new ControllableGateway([rollup]);

    // DB has no receipt_items at all — but totals still come from gw
    const result = await assembleBreakdown(SCOPE, gw, db, '2025-01');

    expect(result.categories).toHaveLength(1);
    expect(result.categories[0]!.category).toBe('groceries');
    expect(result.categories[0]!.netCents).toBe(-5000);
    // DB has no items, so items array is empty
    expect(result.categories[0]!.items).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Category drill-down: items resolved from DB receipt_items
  // -------------------------------------------------------------------------

  it('category resolves to its contributing receipt items', async () => {
    const groceryCatId = await seedCategory(db, 'groceries');
    const receiptId = await seedReceipt(db, '2025-01');
    const itemId = await seedReceiptItem(db, receiptId, groceryCatId, 1, -399, 'Organic Apples');

    const rollup: SpendRollup = {
      key: { householdId: HOUSEHOLD_ID, category: 'groceries', month: '2025-01' },
      netCents: -399,
    };
    const gw = new ControllableGateway([rollup]);

    const result = await assembleBreakdown(SCOPE, gw, db, '2025-01');

    expect(result.categories).toHaveLength(1);
    const cat = result.categories[0]!;
    expect(cat.category).toBe('groceries');
    expect(cat.netCents).toBe(-399);
    expect(cat.items).toHaveLength(1);
    expect(cat.items[0]!.id).toBe(itemId);
    expect(cat.items[0]!.description).toBe('Organic Apples');
    expect(cat.items[0]!.amountCents).toBe(-399);
  });

  // -------------------------------------------------------------------------
  // Category drill-down: order items via matches → receipt_items → categories
  // -------------------------------------------------------------------------

  it('order items appear in drill-down when matched to a categorised receipt item', async () => {
    const groceryCatId = await seedCategory(db, 'groceries');
    const receiptId = await seedReceipt(db, '2025-01');
    const riId = await seedReceiptItem(db, receiptId, groceryCatId, 1, -399, 'Olive Oil');

    // Seed account + transaction (required for matches.transactionId FK)
    const acctId = randomUUID();
    await db.insert(accounts).values({ id: acctId, householdId: HOUSEHOLD_ID, name: 'Checking' });
    const txnId = randomUUID();
    await db.insert(transactions).values({
      id: txnId,
      accountId: acctId,
      postedDate: '2025-01-10',
      amountCents: -4999,
      direction: 'debit',
      normalizedMerchant: 'AMAZON',
      sourceRowHash: `hash-${randomUUID()}`,
      dedupKey: `dedup-${randomUUID()}`,
    });

    // Seed order + order item
    const orderId = randomUUID();
    await db.insert(orders).values({
      id: orderId,
      householdId: HOUSEHOLD_ID,
      source: 'amazon',
      externalOrderId: `AMZ-${randomUUID()}`,
      orderDate: '2025-01-10',
      currency: 'USD',
    });
    const oiId = randomUUID();
    await db.insert(orderItems).values({
      id: oiId,
      orderId,
      shipmentId: 'SHIP-001',
      itemSeq: 1,
      description: 'Echo Dot',
      quantity: 1,
      amountCents: -4999,
      sourceRowHash: `hash-${randomUUID()}`,
    });

    // Seed match linking order item to receipt item (provides the category)
    await db.insert(matches).values({
      id: randomUUID(),
      transactionId: txnId,
      orderItemId: oiId,
      receiptItemId: riId,
      status: 'matched',
    });

    const rollups: SpendRollup[] = [
      { key: { householdId: HOUSEHOLD_ID, category: 'groceries', month: '2025-01' }, netCents: -5398 },
    ];
    const gw = new ControllableGateway(rollups);

    const result = await assembleBreakdown(SCOPE, gw, db, '2025-01');
    const grocery = result.categories.find((c) => c.category === 'groceries');
    expect(grocery).toBeDefined();

    const orderItem = grocery!.items.find((i) => i.id === oiId);
    expect(orderItem).toBeDefined();
    expect(orderItem!.description).toBe('Echo Dot');
    expect(orderItem!.amountCents).toBe(-4999);
    expect(orderItem!.category).toBe('groceries');
  });

  // -------------------------------------------------------------------------
  // Category drill-down: transactions via matches → receipt_items → categories
  // -------------------------------------------------------------------------

  it('transactions appear in drill-down when matched to a categorised receipt item', async () => {
    const groceryCatId = await seedCategory(db, 'groceries');
    const receiptId = await seedReceipt(db, '2025-01');
    const riId = await seedReceiptItem(db, receiptId, groceryCatId, 1, -399, 'Olive Oil');

    // Seed account + transaction
    const acctId = randomUUID();
    await db.insert(accounts).values({ id: acctId, householdId: HOUSEHOLD_ID, name: 'Checking' });
    const txnId = randomUUID();
    await db.insert(transactions).values({
      id: txnId,
      accountId: acctId,
      postedDate: '2025-01-20',
      amountCents: -8750,
      direction: 'debit',
      normalizedMerchant: 'WHOLE FOODS',
      sourceRowHash: `hash-${randomUUID()}`,
      dedupKey: `dedup-${randomUUID()}`,
    });

    // Seed match linking transaction to receipt item (provides the category)
    await db.insert(matches).values({
      id: randomUUID(),
      transactionId: txnId,
      orderItemId: null,
      receiptItemId: riId,
      status: 'matched',
    });

    const rollups: SpendRollup[] = [
      { key: { householdId: HOUSEHOLD_ID, category: 'groceries', month: '2025-01' }, netCents: -9149 },
    ];
    const gw = new ControllableGateway(rollups);

    const result = await assembleBreakdown(SCOPE, gw, db, '2025-01');
    const grocery = result.categories.find((c) => c.category === 'groceries');
    expect(grocery).toBeDefined();

    const txnItem = grocery!.items.find((i) => i.id === txnId);
    expect(txnItem).toBeDefined();
    expect(txnItem!.description).toBe('WHOLE FOODS');
    expect(txnItem!.amountCents).toBe(-8750);
    expect(txnItem!.category).toBe('groceries');
  });

  // -------------------------------------------------------------------------
  // Month filter: items from wrong month are excluded
  // -------------------------------------------------------------------------

  it('month filter excludes items from other months', async () => {
    const groceryCatId = await seedCategory(db, 'groceries');
    const jan = await seedReceipt(db, '2025-01');
    const feb = await seedReceipt(db, '2025-02');
    await seedReceiptItem(db, jan, groceryCatId, 1, -399, 'Jan Item');
    await seedReceiptItem(db, feb, groceryCatId, 1, -599, 'Feb Item');

    const rollup: SpendRollup = {
      key: { householdId: HOUSEHOLD_ID, category: 'groceries', month: '2025-01' },
      netCents: -399,
    };
    const gw = new ControllableGateway([rollup]);

    const result = await assembleBreakdown(SCOPE, gw, db, '2025-01');
    const items = result.categories[0]!.items;
    expect(items).toHaveLength(1);
    expect(items[0]!.description).toBe('Jan Item');
  });

  // -------------------------------------------------------------------------
  // Correction propagation: totals update when gw rollups update
  // -------------------------------------------------------------------------

  it('totals reflect corrections: updated rollup is returned after recomputeRollups', async () => {
    const initialRollup: SpendRollup = {
      key: { householdId: HOUSEHOLD_ID, category: 'groceries', month: '2025-01' },
      netCents: -1200,
    };
    const gw = new ControllableGateway([initialRollup]);

    const before = await assembleBreakdown(SCOPE, gw, db, '2025-01');
    expect(before.categories[0]!.netCents).toBe(-1200);

    // Simulate a correction: recomputeRollups adjusts the rollup
    await gw.recomputeRollups(SCOPE, ['some-item-id']);

    const after = await assembleBreakdown(SCOPE, gw, db, '2025-01');
    // The total has changed because gw updated its rollups (not because we recomputed from DB)
    expect(after.categories[0]!.netCents).toBe(-1300);
  });

  // -------------------------------------------------------------------------
  // Multiple categories in one month
  // -------------------------------------------------------------------------

  it('multiple categories in one month are all returned', async () => {
    const groceryCatId = await seedCategory(db, 'groceries');
    const electronicsCatId = await seedCategory(db, 'electronics');
    const receiptId = await seedReceipt(db, '2025-01');
    await seedReceiptItem(db, receiptId, groceryCatId, 1, -1200, 'Milk');
    await seedReceiptItem(db, receiptId, electronicsCatId, 2, -4999, 'Headphones');

    const rollups: SpendRollup[] = [
      { key: { householdId: HOUSEHOLD_ID, category: 'groceries', month: '2025-01' }, netCents: -1200 },
      { key: { householdId: HOUSEHOLD_ID, category: 'electronics', month: '2025-01' }, netCents: -4999 },
    ];
    const gw = new ControllableGateway(rollups);

    const result = await assembleBreakdown(SCOPE, gw, db, '2025-01');
    expect(result.categories).toHaveLength(2);
    const grocery = result.categories.find((c) => c.category === 'groceries');
    const electronics = result.categories.find((c) => c.category === 'electronics');
    expect(grocery?.netCents).toBe(-1200);
    expect(grocery?.items).toHaveLength(1);
    expect(electronics?.netCents).toBe(-4999);
    expect(electronics?.items).toHaveLength(1);
  });
});
