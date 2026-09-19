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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { FinanceDb } from '../../db/client';
import { accounts, households, receiptItems, receipts, reviewDecisions, transactions } from '../../db/schema';
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
// Mock gatewayFor so we can inject a spy into the route handlers.
// Route handlers call gatewayFor() internally; mocking it here intercepts that
// call so the same gateway instance is observable from the test.
// ---------------------------------------------------------------------------

vi.mock('../reconciliation/gateway', () => ({
  gatewayFor: vi.fn(),
}));

import * as gatewayModule from '../reconciliation/gateway';

// ---------------------------------------------------------------------------
// Import the actual route handlers (anti-stub requirement)
// ---------------------------------------------------------------------------
// These are the real production route files — not mocks, not wrappers.
// The `[id]` in the path is the Next.js dynamic segment directory name on disk.

import { POST as postCorrect } from '../../../../apps/web/app/api/queue/[id]/correct/route';
import { POST as postConfirm } from '../../../../apps/web/app/api/queue/[id]/confirm/route';
import { POST as postDismiss } from '../../../../apps/web/app/api/queue/[id]/dismiss/route';

// ---------------------------------------------------------------------------
// Null gateway — real assertions are on DB state and call-count.
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

const TEST_TOKEN = 'integration-test-token-secret';

// ---------------------------------------------------------------------------
// State shared across tests within this suite
// ---------------------------------------------------------------------------

let testDbFile: string;
let testDbSubdir: string;
let db: FinanceDb;
let cleanupDb: () => void;
let sharedReceiptId: string;

beforeAll(async () => {
  testDbSubdir = mkdtempSync(join(tmpdir(), 'clarity-integration-test-'));
  testDbFile = join(testDbSubdir, 'integration.db');

  // Use vi.stubEnv so Vitest restores original values after the suite
  vi.stubEnv('TURSO_DATABASE_URL', `file:${testDbFile}`);
  vi.stubEnv('RECONCILE_MUTATION_TOKEN', TEST_TOKEN);
  vi.stubEnv('RECON_BACKEND', 'stub');

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

  // Shared receipt used by per-describe seed helpers
  sharedReceiptId = `receipt-integration-${randomUUID()}`;
  await db.insert(receipts).values({
    id: sharedReceiptId,
    householdId: DEMO_HOUSEHOLD_ID,
    source: 'manual',
    store: 'COSTCO',
    purchasedAt: '2025-01-20',
    totalCents: 2499,
    needsReview: false,
  });
});

afterAll(() => {
  vi.unstubAllEnvs();
  cleanupDb();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedReceiptItem(
  lineNo: number,
  opts: { sku?: string; canonicalName?: string; nameConfidence?: number; needsReview?: boolean } = {},
): Promise<string> {
  const id = `ri-integration-${randomUUID()}`;
  await db.insert(receiptItems).values({
    id,
    receiptId: sharedReceiptId,
    lineNo,
    sku: opts.sku ?? null,
    rawDescription: 'KS EVOO',
    canonicalName: opts.canonicalName ?? null,
    quantity: 1,
    linePriceCents: 1000,
    nameConfidence: opts.nameConfidence ?? null,
    needsReview: opts.needsReview ?? true,
  });
  return id;
}

let lineNoCounter = 1;
function nextLineNo(): number {
  return lineNoCounter++;
}

function makeRequest(
  body: unknown,
  action: 'confirm' | 'correct' | 'dismiss' = 'correct',
): Request {
  return new Request(`http://localhost/api/queue/test/${action}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-reconcile-token': TEST_TOKEN,
    },
    body: JSON.stringify(body),
  });
}

function makeContext(itemId: string) {
  return { params: { id: itemId } };
}

// ---------------------------------------------------------------------------
// Integration tests — each describe seeds its own fresh item
// ---------------------------------------------------------------------------

describe('anti-stub integration: POST /api/queue/[id]/correct (editResolution)', () => {
  let skuItemId: string;
  let routeGw: NullGateway;

  beforeAll(async () => {
    skuItemId = await seedReceiptItem(nextLineNo());
    routeGw = new NullGateway();
    vi.mocked(gatewayModule.gatewayFor).mockReturnValue(routeGw);
  });

  it('persists decision, upserts sku_dictionary at confidence=1.0, removes item from queue, propagates rollup', async () => {
    const body = {
      itemType: 'sku_resolution',
      correction: {
        variant: 'editResolution',
        canonicalName: 'Kirkland Organic Olive Oil',
        category: 'groceries',
      },
    };

    const res = await postCorrect(makeRequest(body, 'correct'), makeContext(skuItemId));

    expect(res.status).toBe(200);
    const json = await res.json() as { removedItemId: string };
    expect(json.removedItemId).toBe(skuItemId);

    // (a) Item no longer appears in assembleQueue
    const queueItems = await assembleQueue({ householdId: DEMO_HOUSEHOLD_ID }, new NullGateway(), db);
    expect(queueItems.map((i) => i.id)).not.toContain(skuItemId);

    // (b) sku_dictionary has the new canonical entry at confidence 1.0, keyed
    //     by the item (receipt store + raw description, since it has no sku)
    const skuRows = await db.select().from(skuDictionary).where(
      eq(skuDictionary.skuOrAbbrev, 'KS EVOO'),
    );
    expect(skuRows).toHaveLength(1);
    expect(skuRows[0]!.store).toBe('COSTCO');
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

    // (d) the ITEM itself carries the human's answer — the correction applied,
    //     not merely logged.
    const itemRows = await db.select().from(receiptItems).where(
      eq(receiptItems.id, skuItemId),
    );
    expect(itemRows[0]!.canonicalName).toBe('Kirkland Organic Olive Oil');
    expect(itemRows[0]!.categoryId).toBe('groceries');
    expect(itemRows[0]!.nameConfidence).toBe(1);
    expect(itemRows[0]!.categoryConfidence).toBe(1);
    expect(itemRows[0]!.needsReview).toBe(false);

    // (e) rollup propagation: route handler called recomputeRollups with [skuItemId]
    expect(routeGw.recomputeRollupsCalls).toHaveLength(1);
    expect(routeGw.recomputeRollupsCalls[0]!.ids).toEqual([skuItemId]);
  });
});

describe('anti-stub integration: POST /api/queue/[id]/correct (pickCategoryId)', () => {
  let pickItemId: string;

  beforeAll(async () => {
    pickItemId = await seedReceiptItem(nextLineNo(), {
      sku: 'KS-TP-30',
      canonicalName: 'Kirkland Bath Tissue 30-pack',
      nameConfidence: 0.55,
    });
    vi.mocked(gatewayModule.gatewayFor).mockReturnValue(new NullGateway());
  });

  it('re-categorises the item, clears its flag, and teaches the dictionary the category (not a new name)', async () => {
    const body = {
      itemType: 'sku_resolution',
      correction: { variant: 'pickCategoryId', categoryId: 'Health & Medical' },
    };

    const res = await postCorrect(makeRequest(body, 'correct'), makeContext(pickItemId));
    expect(res.status).toBe(200);

    const itemRows = await db.select().from(receiptItems).where(
      eq(receiptItems.id, pickItemId),
    );
    expect(itemRows[0]!.categoryId).toBe('health-medical');
    expect(itemRows[0]!.categoryConfidence).toBe(1);
    expect(itemRows[0]!.needsReview).toBe(false);

    // Learned for next time, under the receipt's store and the item's key,
    // with the item's own name at the item's own confidence.
    const skuRows = await db.select().from(skuDictionary).where(
      eq(skuDictionary.skuOrAbbrev, 'KS-TP-30'),
    );
    expect(skuRows).toHaveLength(1);
    expect(skuRows[0]!.store).toBe('COSTCO');
    expect(skuRows[0]!.category).toBe('health-medical');
    expect(skuRows[0]!.categoryConfidence).toBe(1);
    expect(skuRows[0]!.canonicalName).toBe('Kirkland Bath Tissue 30-pack');
    expect(skuRows[0]!.nameConfidence).toBe(0.55);
    expect(skuRows[0]!.source).toBe('human');

    // And it is gone from the queue.
    const queueItems = await assembleQueue({ householdId: DEMO_HOUSEHOLD_ID }, new NullGateway(), db);
    expect(queueItems.map((i) => i.id)).not.toContain(pickItemId);
  });
});

describe('anti-stub integration: CorrectionError → 400 with the code in the body', () => {
  beforeAll(() => {
    vi.mocked(gatewayModule.gatewayFor).mockReturnValue(new NullGateway());
  });

  it('unknown category → 400 unknown_category, and the item is untouched', async () => {
    const itemId = await seedReceiptItem(nextLineNo());
    const res = await postCorrect(
      makeRequest(
        {
          itemType: 'sku_resolution',
          correction: { variant: 'pickCategoryId', categoryId: 'snacks' },
        },
        'correct',
      ),
      makeContext(itemId),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'unknown_category' });

    const itemRows = await db.select().from(receiptItems).where(eq(receiptItems.id, itemId));
    expect(itemRows[0]!.needsReview).toBe(true);
    const decRows = await db.select().from(reviewDecisions).where(
      eq(reviewDecisions.itemId, itemId),
    );
    expect(decRows).toHaveLength(0);
  });

  it('pickCategoryId on a non-sku item → 400 invalid_variant', async () => {
    const res = await postCorrect(
      makeRequest(
        {
          itemType: 'missing_receipt',
          correction: { variant: 'pickCategoryId', categoryId: 'groceries' },
        },
        'correct',
      ),
      makeContext(`txn-nonexistent-${randomUUID()}`),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_variant' });
  });

  it('unknown match candidate on a real transaction → 400 candidate_mismatch', async () => {
    const accountId = `acct-integration-${randomUUID()}`;
    await db.insert(accounts).values({ id: accountId, householdId: DEMO_HOUSEHOLD_ID, name: 'Checking' });
    const txnId = `txn-integration-${randomUUID()}`;
    await db.insert(transactions).values({
      id: txnId,
      accountId,
      postedDate: '2025-01-21',
      amountCents: -2499,
      direction: 'debit',
      normalizedMerchant: 'COSTCO',
      sourceRowHash: txnId,
      dedupKey: txnId,
    });

    const res = await postCorrect(
      makeRequest(
        {
          itemType: 'ambiguous_match',
          correction: { variant: 'pickMatchCandidateId', candidateId: 'no-such-match' },
        },
        'correct',
      ),
      makeContext(txnId),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'candidate_mismatch' });
  });

  it('a transaction outside the household → 400 not_found, before any candidate check', async () => {
    const res = await postCorrect(
      makeRequest(
        {
          itemType: 'ambiguous_match',
          correction: { variant: 'pickMatchCandidateId', candidateId: 'no-such-match' },
        },
        'correct',
      ),
      makeContext(`txn-nonexistent-${randomUUID()}`),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'not_found' });
  });

  it('confirm on an item outside the household → 400 not_found', async () => {
    const res = await postConfirm(
      makeRequest({ itemType: 'sku_resolution' }, 'confirm'),
      makeContext(`ri-nonexistent-${randomUUID()}`),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'not_found' });
  });

  it('dismiss on a receipt outside the household → 400 not_found', async () => {
    const res = await postDismiss(
      makeRequest({ itemType: 'flagged_receipt' }, 'dismiss'),
      makeContext(`receipt-nonexistent-${randomUUID()}`),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'not_found' });
  });
});

describe('anti-stub integration: POST /api/queue/[id]/confirm', () => {
  let confirmItemId: string;

  beforeAll(async () => {
    confirmItemId = await seedReceiptItem(nextLineNo());
    vi.mocked(gatewayModule.gatewayFor).mockReturnValue(new NullGateway());
  });

  it('item leaves the queue; decision row written, no sku_dictionary write', async () => {
    const body = { itemType: 'sku_resolution' };

    const res = await postConfirm(makeRequest(body, 'confirm'), makeContext(confirmItemId));

    expect(res.status).toBe(200);
    const json = await res.json() as { removedItemId: string };
    expect(json.removedItemId).toBe(confirmItemId);

    // Item no longer in queue
    const queueItems = await assembleQueue({ householdId: DEMO_HOUSEHOLD_ID }, new NullGateway(), db);
    expect(queueItems.map((i) => i.id)).not.toContain(confirmItemId);

    // Decision row
    const decRows = await db.select().from(reviewDecisions).where(
      eq(reviewDecisions.itemId, confirmItemId),
    );
    expect(decRows[0]!.decision).toBe('confirm');
    expect(decRows[0]!.payloadJson).toBeNull();
  });
});

describe('anti-stub integration: POST /api/queue/[id]/dismiss', () => {
  let dismissItemId: string;

  beforeAll(async () => {
    dismissItemId = await seedReceiptItem(nextLineNo());
    vi.mocked(gatewayModule.gatewayFor).mockReturnValue(new NullGateway());
  });

  it('item leaves the queue', async () => {
    const body = { itemType: 'sku_resolution' };

    const res = await postDismiss(makeRequest(body, 'dismiss'), makeContext(dismissItemId));

    expect(res.status).toBe(200);
    const json = await res.json() as { removedItemId: string };
    expect(json.removedItemId).toBe(dismissItemId);

    const queueItems = await assembleQueue({ householdId: DEMO_HOUSEHOLD_ID }, new NullGateway(), db);
    expect(queueItems.map((i) => i.id)).not.toContain(dismissItemId);
  });
});

describe('anti-stub integration: auth guard', () => {
  beforeAll(() => {
    vi.mocked(gatewayModule.gatewayFor).mockReturnValue(new NullGateway());
  });

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

describe('anti-stub integration: input validation', () => {
  beforeAll(() => {
    vi.mocked(gatewayModule.gatewayFor).mockReturnValue(new NullGateway());
  });

  it('returns 400 for invalid itemType', async () => {
    const res = await postConfirm(
      new Request('http://localhost', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-reconcile-token': TEST_TOKEN },
        body: JSON.stringify({ itemType: 'not_a_real_type' }),
      }),
      makeContext('some-id'),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid correction variant', async () => {
    const res = await postCorrect(
      new Request('http://localhost', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-reconcile-token': TEST_TOKEN },
        body: JSON.stringify({ itemType: 'sku_resolution', correction: { variant: 'notAVariant' } }),
      }),
      makeContext('some-id'),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for editResolution with missing canonicalName', async () => {
    const res = await postCorrect(
      new Request('http://localhost', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-reconcile-token': TEST_TOKEN },
        body: JSON.stringify({
          itemType: 'sku_resolution',
          correction: { variant: 'editResolution', category: 'groceries' },
        }),
      }),
      makeContext('some-id'),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for pickCategoryId with missing categoryId', async () => {
    const res = await postCorrect(
      new Request('http://localhost', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-reconcile-token': TEST_TOKEN },
        body: JSON.stringify({ itemType: 'sku_resolution', correction: { variant: 'pickCategoryId' } }),
      }),
      makeContext('some-id'),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for pickMatchCandidateId with missing candidateId', async () => {
    const res = await postCorrect(
      new Request('http://localhost', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-reconcile-token': TEST_TOKEN },
        body: JSON.stringify({ itemType: 'sku_resolution', correction: { variant: 'pickMatchCandidateId' } }),
      }),
      makeContext('some-id'),
    );
    expect(res.status).toBe(400);
  });
});

describe('anti-stub integration: repeat and off-queue decisions', () => {
  beforeAll(() => {
    vi.mocked(gatewayModule.gatewayFor).mockReturnValue(new NullGateway());
  });

  it('a second decision on the same item is 409 and leaves the first decision as the only one', async () => {
    const itemId = await seedReceiptItem(nextLineNo());

    const first = await postConfirm(makeRequest({ itemType: 'sku_resolution' }, 'confirm'), makeContext(itemId));
    expect(first.status).toBe(200);

    // The item is no longer queued after the first decision, but the decision
    // row is written first — so the UNIQUE violation is what the caller sees.
    const second = await postDismiss(makeRequest({ itemType: 'sku_resolution' }, 'dismiss'), makeContext(itemId));
    expect(second.status).toBe(409);

    const decRows = await db.select().from(reviewDecisions).where(eq(reviewDecisions.itemId, itemId));
    expect(decRows).toHaveLength(1);
    expect(decRows[0]!.decision).toBe('confirm');
  });

  it('a decision on an item that is not in the queue is 400 not_queued and rewrites nothing', async () => {
    const itemId = await seedReceiptItem(nextLineNo(), {
      needsReview: false,
      canonicalName: 'Kirkland Olive Oil',
      nameConfidence: 0.7,
    });

    const res = await postConfirm(makeRequest({ itemType: 'sku_resolution' }, 'confirm'), makeContext(itemId));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'not_queued' });

    const itemRows = await db.select().from(receiptItems).where(eq(receiptItems.id, itemId));
    expect(itemRows[0]!.nameConfidence).toBe(0.7);
    const decRows = await db.select().from(reviewDecisions).where(eq(reviewDecisions.itemId, itemId));
    expect(decRows).toHaveLength(0);
  });
});
