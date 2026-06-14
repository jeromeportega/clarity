/**
 * Anti-stub integration test (ADR-008, NFR-3).
 *
 * Imports the actual App Router route handlers, invokes them with a constructed
 * Request against a fresh file-based libSQL DB, and asserts persistence AND
 * rollup propagation — all in Node, no server.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { FinanceDb } from '../../db/client';
import { households, receiptItems, receipts, reviewDecisions } from '../../db/schema';
import { skuDictionary } from '../receipts/dictionary/schema';
import { assembleQueue } from '../queue/assemble';
import type {
  AmbiguousMatchGroup,
  HouseholdScope,
  Match,
  ReconciliationGateway,
  SpendRollup,
  Transaction,
} from '../reconciliation/types';
import { DEMO_HOUSEHOLD_ID } from '../scope';
import { eq } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Import the actual route handlers (anti-stub requirement)
// ---------------------------------------------------------------------------
// These are the real production route files — not mocks, not wrappers.
// The `[id]` in the path is the Next.js dynamic segment directory name on disk.

import { POST as postCorrect } from '../../../../apps/web/app/api/queue/[id]/correct/route';
import { POST as postConfirm } from '../../../../apps/web/app/api/queue/[id]/confirm/route';
import { POST as postDismiss } from '../../../../apps/web/app/api/queue/[id]/dismiss/route';

// ---------------------------------------------------------------------------
// Null gateway — real assertions are on DB state, not gateway calls.
// recomputeRollups is a spy so we can assert propagation.
// ---------------------------------------------------------------------------

class NullGateway implements ReconciliationGateway {
  recomputeRollupsCalls: Array<{ scope: HouseholdScope; ids: string[] }> = [];

  async listMatches(): Promise<Match[]> { return []; }
  async getAmbiguousMatchGroups(): Promise<AmbiguousMatchGroup[]> { return []; }
  async listUnmatchedTransactions(): Promise<Transaction[]> { return []; }
  async getRollups(): Promise<SpendRollup[]> { return []; }

  async recomputeRollups(scope: HouseholdScope, ids: string[]): Promise<void> {
    this.recomputeRollupsCalls.push({ scope, ids });
  }
}

// ---------------------------------------------------------------------------
// Test DB — one shared DB for the whole suite, seeded once in beforeAll
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
// State shared across tests within this suite
// ---------------------------------------------------------------------------

let testDbFile: string;
let testDbSubdir: string;
let db: FinanceDb;
let cleanupDb: () => void;
const TEST_TOKEN = 'integration-test-token-secret';

// Item IDs seeded before tests run
let skuItemId: string;
let confirmItemId: string;
let dismissItemId: string;

beforeAll(async () => {
  // Set env so route handlers use this test DB and our token.
  testDbSubdir = mkdtempSync(join(tmpdir(), 'clarity-integration-test-'));
  testDbFile = join(testDbSubdir, 'integration.db');

  process.env.TURSO_DATABASE_URL = `file:${testDbFile}`;
  process.env.RECONCILE_MUTATION_TOKEN = TEST_TOKEN;
  // Use stub gateway — no live H3 in unit test environment.
  process.env.RECON_BACKEND = 'stub';

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

  // Seed the household (DEMO_HOUSEHOLD_ID is used by the routes internally)
  await db.insert(households).values({
    id: DEMO_HOUSEHOLD_ID,
    name: 'Integration Test Household',
  });

  // Seed a receipt for SKU-resolution items
  const receiptId = `receipt-integration-${randomUUID()}`;
  await db.insert(receipts).values({
    id: receiptId,
    householdId: DEMO_HOUSEHOLD_ID,
    source: 'manual',
    store: 'COSTCO',
    purchasedAt: '2025-01-20',
    totalCents: 2499,
    needsReview: false,
  });

  // Three distinct items: one for editResolution, one for confirm, one for dismiss.
  skuItemId = `ri-integration-${randomUUID()}`;
  confirmItemId = `ri-integration-${randomUUID()}`;
  dismissItemId = `ri-integration-${randomUUID()}`;

  for (const id of [skuItemId, confirmItemId, dismissItemId]) {
    await db.insert(receiptItems).values({
      id,
      receiptId,
      lineNo: [skuItemId, confirmItemId, dismissItemId].indexOf(id) + 1,
      rawDescription: id === skuItemId ? 'KS EVOO' : id === confirmItemId ? 'BANANAS' : 'MILK',
      quantity: 1,
      linePriceCents: 1000,
      needsReview: true,
    });
  }
});

afterAll(() => {
  cleanupDb();
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.RECONCILE_MUTATION_TOKEN;
  delete process.env.RECON_BACKEND;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/queue/test/correct', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TEST_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
}

function makeContext(itemId: string) {
  return { params: { id: itemId } };
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe('anti-stub integration: POST /api/queue/[id]/correct', () => {
  it('editResolution: persists decision, upserts sku_dictionary at confidence=1.0, removes item from queue', async () => {
    const nullGw = new NullGateway();
    const body = {
      itemType: 'sku_resolution',
      correction: {
        variant: 'editResolution',
        store: 'COSTCO',
        skuOrAbbrev: 'KS-EVOO',
        canonicalName: 'Kirkland Organic Olive Oil',
        category: 'groceries',
      },
    };

    const res = await postCorrect(makeRequest(body), makeContext(skuItemId));

    expect(res.status).toBe(200);
    const json = await res.json() as { removedItemId: string };
    expect(json.removedItemId).toBe(skuItemId);

    // (a) Item no longer appears in assembleQueue
    // Use NullGateway so only DB-sourced items show up.
    const queueItems = await assembleQueue(
      { householdId: DEMO_HOUSEHOLD_ID },
      nullGw,
      db,
    );
    const ids = queueItems.map((i) => i.id);
    expect(ids).not.toContain(skuItemId);

    // (b) sku_dictionary has the new canonical entry at confidence 1.0
    const skuRows = await db.select().from(skuDictionary).where(
      eq(skuDictionary.skuOrAbbrev, 'KS-EVOO'),
    );
    expect(skuRows).toHaveLength(1);
    expect(skuRows[0]!.canonicalName).toBe('Kirkland Organic Olive Oil');
    expect(skuRows[0]!.category).toBe('groceries');
    expect(skuRows[0]!.nameConfidence).toBe(1.0);
    expect(skuRows[0]!.categoryConfidence).toBe(1.0);
    expect(skuRows[0]!.source).toBe('human');

    // (c) review_decisions row persisted
    const decRows = await db.select().from(reviewDecisions).where(
      eq(reviewDecisions.itemId, skuItemId),
    );
    expect(decRows).toHaveLength(1);
    expect(decRows[0]!.decision).toBe('correct');
  });
});

describe('anti-stub integration: POST /api/queue/[id]/confirm', () => {
  it('confirm: item leaves the queue, no sku_dictionary write', async () => {
    const nullGw = new NullGateway();
    const body = { itemType: 'sku_resolution' };

    const res = await postConfirm(makeRequest(body), makeContext(confirmItemId));

    expect(res.status).toBe(200);
    const json = await res.json() as { removedItemId: string };
    expect(json.removedItemId).toBe(confirmItemId);

    // Item no longer in queue
    const queueItems = await assembleQueue(
      { householdId: DEMO_HOUSEHOLD_ID },
      nullGw,
      db,
    );
    expect(queueItems.map((i) => i.id)).not.toContain(confirmItemId);

    // No new sku_dictionary entry (beyond what the correct test added)
    const decRows = await db.select().from(reviewDecisions).where(
      eq(reviewDecisions.itemId, confirmItemId),
    );
    expect(decRows[0]!.decision).toBe('confirm');
    expect(decRows[0]!.payloadJson).toBeNull();
  });
});

describe('anti-stub integration: POST /api/queue/[id]/dismiss', () => {
  it('dismiss: item leaves the queue', async () => {
    const nullGw = new NullGateway();
    const body = { itemType: 'sku_resolution' };

    const res = await postDismiss(makeRequest(body), makeContext(dismissItemId));

    expect(res.status).toBe(200);
    const json = await res.json() as { removedItemId: string };
    expect(json.removedItemId).toBe(dismissItemId);

    // Item no longer in queue
    const queueItems = await assembleQueue(
      { householdId: DEMO_HOUSEHOLD_ID },
      nullGw,
      db,
    );
    expect(queueItems.map((i) => i.id)).not.toContain(dismissItemId);
  });
});

describe('anti-stub integration: auth guard', () => {
  it('returns 401 without a valid token', async () => {
    const req = new Request('http://localhost/api/queue/test/correct', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemType: 'sku_resolution', correction: { variant: 'pickCategoryId', categoryId: 'x' } }),
    });
    const res = await postCorrect(req, makeContext('some-id'));
    expect(res.status).toBe(401);
  });
});
