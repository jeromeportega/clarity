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
  orderItems,
  orders,
  receiptItems,
  receipts,
  transactions,
} from '../../db/schema';
import { resolveEvidence } from './resolve';

// ---------------------------------------------------------------------------
// Test DB helpers (apply migrations from disk, same pattern as apply.test.ts)
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

async function createEvidenceTestDb(): Promise<{ db: FinanceDb; cleanup: () => void }> {
  const subdir = mkdtempSync(join(tmpdir(), 'clarity-evidence-test-'));
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
// Shared test fixtures
// ---------------------------------------------------------------------------

const HOUSEHOLD_ID = 'test-household-00000000-0000-0000-0000-000000000001';

async function seedHousehold(db: FinanceDb): Promise<void> {
  await db.insert(households).values({ id: HOUSEHOLD_ID, name: 'Test Household' });
}

async function seedCategory(db: FinanceDb, name = 'groceries'): Promise<string> {
  const id = randomUUID();
  await db.insert(categories).values({ id, name });
  return id;
}

async function seedReceipt(db: FinanceDb, receiptId: string): Promise<void> {
  await db.insert(receipts).values({
    id: receiptId,
    householdId: HOUSEHOLD_ID,
    source: 'manual',
    store: 'TEST STORE',
    purchasedAt: '2025-01-15',
    totalCents: 1000,
    needsReview: false,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveEvidence', () => {
  let db: FinanceDb;
  let cleanup: () => void;

  beforeEach(async () => {
    ({ db, cleanup } = await createEvidenceTestDb());
    await seedHousehold(db);
  });

  afterEach(() => cleanup());

  // -------------------------------------------------------------------------
  // Receipt region — WITH bbox
  // -------------------------------------------------------------------------

  it('receipt region WITH bbox: returns receipt_region with bbox populated', async () => {
    const receiptId = randomUUID();
    await seedReceipt(db, receiptId);
    const itemId = randomUUID();
    const bbox = { x: 0.1, y: 0.2, width: 0.8, height: 0.05 };
    await db.insert(receiptItems).values({
      id: itemId,
      receiptId,
      lineNo: 1,
      rawDescription: 'Organic Apples',
      quantity: 1,
      linePriceCents: -399,
      needsReview: false,
      bbox: JSON.stringify(bbox),
    });

    const result = await resolveEvidence(itemId, db);

    expect(result.kind).toBe('receipt_region');
    if (result.kind !== 'receipt_region') throw new Error('wrong kind');
    expect(result.receiptId).toBe(receiptId);
    expect(result.imageUrl).toBe(`/api/receipts/image/${receiptId}`);
    expect(result.bbox).toEqual(bbox);
  });

  // -------------------------------------------------------------------------
  // Receipt region — WITHOUT bbox (FR-8 / ADR-007 graceful-degradation)
  // -------------------------------------------------------------------------

  it('receipt region WITHOUT bbox: returns receipt_region with imageUrl, bbox omitted', async () => {
    const receiptId = randomUUID();
    await seedReceipt(db, receiptId);
    const itemId = randomUUID();
    await db.insert(receiptItems).values({
      id: itemId,
      receiptId,
      lineNo: 1,
      rawDescription: 'Kirkland Olive Oil',
      quantity: 1,
      linePriceCents: -1299,
      needsReview: false,
      // bbox deliberately omitted — NULL in DB
    });

    const result = await resolveEvidence(itemId, db);

    expect(result.kind).toBe('receipt_region');
    if (result.kind !== 'receipt_region') throw new Error('wrong kind');
    expect(result.receiptId).toBe(receiptId);
    expect(result.imageUrl).toBe(`/api/receipts/image/${receiptId}`);
    expect('bbox' in result).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Amazon order row
  // -------------------------------------------------------------------------

  it('amazon order row: returns amazon_order_row with orderId and orderItemId', async () => {
    const orderId = randomUUID();
    await db.insert(orders).values({
      id: orderId,
      householdId: HOUSEHOLD_ID,
      source: 'amazon',
      externalOrderId: 'AMZ-12345',
      orderDate: '2025-01-10',
      currency: 'USD',
    });
    const itemId = randomUUID();
    await db.insert(orderItems).values({
      id: itemId,
      orderId,
      shipmentId: 'SHIP-001',
      itemSeq: 1,
      description: 'Echo Dot',
      quantity: 1,
      amountCents: -4999,
      sourceRowHash: 'test-hash-001',
    });

    const result = await resolveEvidence(itemId, db);

    expect(result.kind).toBe('amazon_order_row');
    if (result.kind !== 'amazon_order_row') throw new Error('wrong kind');
    expect(result.orderId).toBe(orderId);
    expect(result.orderItemId).toBe(itemId);
  });

  // -------------------------------------------------------------------------
  // Bank line
  // -------------------------------------------------------------------------

  it('bank line: returns bank_line with transactionId', async () => {
    const accountId = randomUUID();
    await db.insert(accounts).values({
      id: accountId,
      householdId: HOUSEHOLD_ID,
      name: 'Checking',
    });
    const txnId = randomUUID();
    await db.insert(transactions).values({
      id: txnId,
      accountId,
      postedDate: '2025-01-20',
      amountCents: -8750,
      direction: 'debit',
      normalizedMerchant: 'WHOLE FOODS',
      sourceRowHash: 'test-hash-txn-001',
      dedupKey: `dedup-${randomUUID()}`,
    });

    const result = await resolveEvidence(txnId, db);

    expect(result.kind).toBe('bank_line');
    if (result.kind !== 'bank_line') throw new Error('wrong kind');
    expect(result.transactionId).toBe(txnId);
  });

  // -------------------------------------------------------------------------
  // Boundary: unknown item ID
  // -------------------------------------------------------------------------

  it('unknown itemId: returns not_found without crashing', async () => {
    const result = await resolveEvidence('nonexistent-id-xyz', db);

    expect(result.kind).toBe('not_found');
    if (result.kind !== 'not_found') throw new Error('wrong kind');
    expect(result.itemId).toBe('nonexistent-id-xyz');
  });

  it('empty string itemId: returns not_found without crashing', async () => {
    const result = await resolveEvidence('', db);
    expect(result.kind).toBe('not_found');
  });
});
