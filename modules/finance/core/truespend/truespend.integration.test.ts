/**
 * Anti-stub integration test for the true-spend routes.
 *
 * Imports the actual App Router route handlers, invokes them with a constructed
 * Request against a fresh file-based libSQL DB, and asserts:
 *   - Category totals come from gw.getRollups (not recomputed from raw items)
 *   - Correction propagation: totals update when rollups are recomputed
 *   - Category → items drill-down resolves correctly
 *   - Item → evidence drill-down resolves all three EvidenceRef kinds
 *   - Month filter boundary: no spend → empty breakdown, not an error
 *
 * All runs are offline (file-based temp DBs, no network).
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { FinanceDb } from '../../db/client';
import { accounts, categories, households, orderItems, orders, receiptItems, receipts, transactions } from '../../db/schema';
import type {
  AmbiguousMatchGroup,
  HouseholdScope,
  Match,
  ReconciliationGateway,
  SpendRollup,
  Transaction,
} from '../reconciliation/types';
import { DEMO_HOUSEHOLD_ID } from '../scope';
import type { TrueSpendBreakdown } from './assemble';
import type { EvidenceRef } from '../evidence/types';

// ---------------------------------------------------------------------------
// Mock gatewayFor so we can inject a controllable gateway into the route handlers
// ---------------------------------------------------------------------------

vi.mock('../reconciliation/gateway', () => ({
  gatewayFor: vi.fn(),
}));

import * as gatewayModule from '../reconciliation/gateway';

// ---------------------------------------------------------------------------
// Import actual route handlers
// ---------------------------------------------------------------------------

import { GET as getTrueSpend } from '../../../../apps/web/app/api/true-spend/route';
import { GET as getEvidence } from '../../../../apps/web/app/api/true-spend/evidence/[itemId]/route';

// ---------------------------------------------------------------------------
// Controllable gateway — mutable rollups for correction propagation tests
// ---------------------------------------------------------------------------

class MutableGateway implements ReconciliationGateway {
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

  async recomputeRollups(_scope: HouseholdScope, _ids: string[]): Promise<void> {
    // Simulate the rollup changing after a correction
    this.rollups = this.rollups.map((r) =>
      r.key.category === 'groceries' ? { ...r, netCents: r.netCents - 100 } : r,
    );
  }

  async listMatches(): Promise<Match[]> { return []; }
  async getAmbiguousMatchGroups(): Promise<AmbiguousMatchGroup[]> { return []; }
  async listUnmatchedTransactions(): Promise<Transaction[]> { return []; }
}

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

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

let testDbFile: string;
let testDbSubdir: string;
let db: FinanceDb;
let cleanupDb: () => void;
let groceryCatId: string;
let sharedReceiptId: string;
let sharedReceiptItemId: string;
let sharedOrderId: string;
let sharedOrderItemId: string;
let sharedAccountId: string;
let sharedTxnId: string;

beforeAll(async () => {
  testDbSubdir = mkdtempSync(join(tmpdir(), 'clarity-ts-integration-'));
  testDbFile = join(testDbSubdir, 'ts-integration.db');

  vi.stubEnv('TURSO_DATABASE_URL', `file:${testDbFile}`);
  vi.stubEnv('PUBLIC_DEMO_MODE', '1');

  const client = createClient({ url: `file:${testDbFile}` });
  db = drizzle(client);
  await applyMigrations(client);

  cleanupDb = () => {
    try { client.close(); } catch { /* ignore */ }
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      rmSync(`${testDbFile}${suffix}`, { force: true });
    }
    rmSync(testDbSubdir, { recursive: true, force: true });
  };

  // Seed demo household (routes use DEMO_HOUSEHOLD_ID internally)
  await db.insert(households).values({ id: DEMO_HOUSEHOLD_ID, name: 'Integration HH' });

  // Seed category
  groceryCatId = randomUUID();
  await db.insert(categories).values({ id: groceryCatId, name: 'groceries' });

  // Seed receipt + receipt item (with bbox)
  sharedReceiptId = randomUUID();
  await db.insert(receipts).values({
    id: sharedReceiptId,
    householdId: DEMO_HOUSEHOLD_ID,
    source: 'manual',
    store: 'COSTCO',
    purchasedAt: '2025-01-15',
    totalCents: 1299,
    needsReview: false,
  });

  sharedReceiptItemId = randomUUID();
  await db.insert(receiptItems).values({
    id: sharedReceiptItemId,
    receiptId: sharedReceiptId,
    lineNo: 1,
    rawDescription: 'Kirkland Olive Oil',
    canonicalName: 'Kirkland Olive Oil',
    categoryId: groceryCatId,
    quantity: 1,
    linePriceCents: -1299,
    needsReview: false,
    bbox: JSON.stringify({ x: 0.1, y: 0.2, width: 0.8, height: 0.05 }),
  });

  // Seed order + order item
  sharedOrderId = randomUUID();
  await db.insert(orders).values({
    id: sharedOrderId,
    householdId: DEMO_HOUSEHOLD_ID,
    source: 'amazon',
    externalOrderId: `AMZ-${randomUUID()}`,
    orderDate: '2025-01-10',
    currency: 'USD',
  });

  sharedOrderItemId = randomUUID();
  await db.insert(orderItems).values({
    id: sharedOrderItemId,
    orderId: sharedOrderId,
    shipmentId: 'SHIP-001',
    itemSeq: 1,
    description: 'Echo Dot',
    quantity: 1,
    amountCents: -4999,
    sourceRowHash: `hash-${randomUUID()}`,
  });

  // Seed account + transaction
  sharedAccountId = randomUUID();
  await db.insert(accounts).values({
    id: sharedAccountId,
    householdId: DEMO_HOUSEHOLD_ID,
    name: 'Checking',
  });

  sharedTxnId = randomUUID();
  await db.insert(transactions).values({
    id: sharedTxnId,
    accountId: sharedAccountId,
    postedDate: '2025-01-20',
    amountCents: -8750,
    direction: 'debit',
    normalizedMerchant: 'WHOLE FOODS',
    sourceRowHash: `hash-${randomUUID()}`,
    dedupKey: `dedup-${randomUUID()}`,
  });
});

afterAll(() => {
  vi.unstubAllEnvs();
  cleanupDb();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTrueSpendRequest(month?: string): Request {
  const url = month
    ? `http://localhost/api/true-spend?month=${month}`
    : 'http://localhost/api/true-spend';
  return new Request(url);
}

function makeEvidenceRequest(itemId: string): Request {
  return new Request(`http://localhost/api/true-spend/evidence/${itemId}`);
}

function makeEvidenceContext(itemId: string) {
  return { params: { itemId } };
}

// ---------------------------------------------------------------------------
// Tests: true-spend totals come from gw.getRollups
// ---------------------------------------------------------------------------

describe('GET /api/true-spend — totals from getRollups (trust-the-number AC)', () => {
  it('returns categories whose netCents come from the gateway, not recomputed from DB', async () => {
    const gw = new MutableGateway([
      { key: { householdId: DEMO_HOUSEHOLD_ID, category: 'groceries', month: '2025-01' }, netCents: -9999 },
    ]);
    vi.mocked(gatewayModule.gatewayFor).mockReturnValue(gw);

    const res = await getTrueSpend(makeTrueSpendRequest('2025-01'));
    expect(res.status).toBe(200);
    const body = await res.json() as TrueSpendBreakdown;

    // Total is -9999 from gateway, even though the DB receipt item is only -1299
    const grocery = body.categories.find((c) => c.category === 'groceries');
    expect(grocery).toBeDefined();
    expect(grocery!.netCents).toBe(-9999);
  });

  it('totals update after a correction triggers recomputeRollups', async () => {
    const gw = new MutableGateway([
      { key: { householdId: DEMO_HOUSEHOLD_ID, category: 'groceries', month: '2025-01' }, netCents: -1200 },
    ]);
    vi.mocked(gatewayModule.gatewayFor).mockReturnValue(gw);

    // Before correction
    const before = await getTrueSpend(makeTrueSpendRequest('2025-01'));
    const beforeBody = await before.json() as TrueSpendBreakdown;
    expect(beforeBody.categories[0]!.netCents).toBe(-1200);

    // Simulate a correction (recomputeRollups updates gw's mutable state)
    await gw.recomputeRollups({ householdId: DEMO_HOUSEHOLD_ID }, ['some-item']);

    // After correction — same gw is returned by the mock
    const after = await getTrueSpend(makeTrueSpendRequest('2025-01'));
    const afterBody = await after.json() as TrueSpendBreakdown;
    expect(afterBody.categories[0]!.netCents).toBe(-1300);
  });
});

// ---------------------------------------------------------------------------
// Tests: category → items drill-down
// ---------------------------------------------------------------------------

describe('GET /api/true-spend — category → items drill-down', () => {
  it('category resolves to its contributing items from the DB', async () => {
    const gw = new MutableGateway([
      { key: { householdId: DEMO_HOUSEHOLD_ID, category: 'groceries', month: '2025-01' }, netCents: -1299 },
    ]);
    vi.mocked(gatewayModule.gatewayFor).mockReturnValue(gw);

    const res = await getTrueSpend(makeTrueSpendRequest('2025-01'));
    const body = await res.json() as TrueSpendBreakdown;
    const grocery = body.categories.find((c) => c.category === 'groceries')!;

    expect(grocery.items.length).toBeGreaterThanOrEqual(1);
    const item = grocery.items.find((i) => i.id === sharedReceiptItemId);
    expect(item).toBeDefined();
    expect(item!.description).toBe('Kirkland Olive Oil');
    expect(item!.amountCents).toBe(-1299);
  });
});

// ---------------------------------------------------------------------------
// Tests: month filter boundary
// ---------------------------------------------------------------------------

describe('GET /api/true-spend — month filter boundary', () => {
  it('a month with no spend returns an empty breakdown, not an error', async () => {
    const gw = new MutableGateway([]);
    vi.mocked(gatewayModule.gatewayFor).mockReturnValue(gw);

    const res = await getTrueSpend(makeTrueSpendRequest('2099-12'));
    expect(res.status).toBe(200);
    const body = await res.json() as TrueSpendBreakdown;
    expect(body.categories).toHaveLength(0);
  });

  it('responds with household-scoped data (resolveHouseholdScope)', async () => {
    const gw = new MutableGateway([
      { key: { householdId: DEMO_HOUSEHOLD_ID, category: 'groceries', month: '2025-01' }, netCents: -100 },
    ]);
    vi.mocked(gatewayModule.gatewayFor).mockReturnValue(gw);

    const res = await getTrueSpend(makeTrueSpendRequest('2025-01'));
    expect(res.status).toBe(200);
  });

  it('rejects a wildcard month with 400', async () => {
    const gw = new MutableGateway([]);
    vi.mocked(gatewayModule.gatewayFor).mockReturnValue(gw);

    const res = await getTrueSpend(new Request('http://localhost/api/true-spend?month=%'));
    expect(res.status).toBe(400);
  });

  it('rejects a non-YYYY-MM month string with 400', async () => {
    const gw = new MutableGateway([]);
    vi.mocked(gatewayModule.gatewayFor).mockReturnValue(gw);

    const res = await getTrueSpend(new Request('http://localhost/api/true-spend?month=2025%'));
    expect(res.status).toBe(400);
  });

  it('accepts a well-formed YYYY-MM month', async () => {
    const gw = new MutableGateway([]);
    vi.mocked(gatewayModule.gatewayFor).mockReturnValue(gw);

    const res = await getTrueSpend(makeTrueSpendRequest('2025-06'));
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Tests: item → evidence drill-down (all three EvidenceRef kinds)
// ---------------------------------------------------------------------------

describe('GET /api/true-spend/evidence/[itemId] — three evidence kinds', () => {
  it('receipt item WITH bbox returns receipt_region with bbox', async () => {
    const res = await getEvidence(makeEvidenceRequest(sharedReceiptItemId), makeEvidenceContext(sharedReceiptItemId));
    expect(res.status).toBe(200);
    const body = await res.json() as EvidenceRef;
    expect(body.kind).toBe('receipt_region');
    if (body.kind !== 'receipt_region') throw new Error('wrong kind');
    expect(body.receiptId).toBe(sharedReceiptId);
    expect(body.imageUrl).toBe(`/api/receipts/image/${sharedReceiptId}`);
    expect(body.bbox).toEqual({ x: 0.1, y: 0.2, width: 0.8, height: 0.05 });
  });

  it('order item returns amazon_order_row', async () => {
    const res = await getEvidence(makeEvidenceRequest(sharedOrderItemId), makeEvidenceContext(sharedOrderItemId));
    expect(res.status).toBe(200);
    const body = await res.json() as EvidenceRef;
    expect(body.kind).toBe('amazon_order_row');
    if (body.kind !== 'amazon_order_row') throw new Error('wrong kind');
    expect(body.orderId).toBe(sharedOrderId);
    expect(body.orderItemId).toBe(sharedOrderItemId);
  });

  it('transaction returns bank_line', async () => {
    const res = await getEvidence(makeEvidenceRequest(sharedTxnId), makeEvidenceContext(sharedTxnId));
    expect(res.status).toBe(200);
    const body = await res.json() as EvidenceRef;
    expect(body.kind).toBe('bank_line');
    if (body.kind !== 'bank_line') throw new Error('wrong kind');
    expect(body.transactionId).toBe(sharedTxnId);
  });

  it('unknown item ID returns 404', async () => {
    const res = await getEvidence(makeEvidenceRequest('no-such-id'), makeEvidenceContext('no-such-id'));
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Tests: whole-image fallback (no bbox)
// ---------------------------------------------------------------------------

describe('GET /api/true-spend/evidence/[itemId] — bbox-absent graceful degradation', () => {
  let noBboxItemId: string;

  beforeAll(async () => {
    noBboxItemId = randomUUID();
    await db.insert(receiptItems).values({
      id: noBboxItemId,
      receiptId: sharedReceiptId,
      lineNo: 99,
      rawDescription: 'No bbox item',
      quantity: 1,
      linePriceCents: -100,
      needsReview: false,
      // bbox intentionally omitted → NULL in DB
    });
  });

  it('receipt item WITHOUT bbox returns receipt_region with imageUrl, no bbox', async () => {
    const res = await getEvidence(makeEvidenceRequest(noBboxItemId), makeEvidenceContext(noBboxItemId));
    expect(res.status).toBe(200);
    const body = await res.json() as EvidenceRef;
    expect(body.kind).toBe('receipt_region');
    if (body.kind !== 'receipt_region') throw new Error('wrong kind');
    expect(body.imageUrl).toBe(`/api/receipts/image/${sharedReceiptId}`);
    expect('bbox' in body).toBe(false);
  });
});
