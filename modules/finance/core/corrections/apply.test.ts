import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FinanceDb } from '../../db/client';
import { households, receiptItems, receipts, reviewDecisions } from '../../db/schema';
import { skuDictionary } from '../receipts/dictionary/schema';
import type {
  AmbiguousMatchGroup,
  HouseholdScope,
  Match,
  ReconciliationGateway,
  SpendRollup,
  Transaction,
} from '../reconciliation/types';
import type { QueueItem } from '../queue/types';
import { applyCorrection } from './apply';
import { eq } from 'drizzle-orm';

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

async function createCorrectionTestDb(): Promise<{ db: FinanceDb; cleanup: () => void }> {
  const subdir = mkdtempSync(join(tmpdir(), 'clarity-corrections-test-'));
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
// Controlled gateway
// ---------------------------------------------------------------------------

class SpyGateway implements ReconciliationGateway {
  recomputeRollupsCalls: Array<{ scope: HouseholdScope; ids: string[] }> = [];
  recomputeError: Error | null = null;

  async listMatches(): Promise<Match[]> { return []; }
  async getAmbiguousMatchGroups(): Promise<AmbiguousMatchGroup[]> { return []; }
  async listUnmatchedTransactions(): Promise<Transaction[]> { return []; }
  async getRollups(): Promise<SpendRollup[]> { return []; }

  async recomputeRollups(scope: HouseholdScope, ids: string[]): Promise<void> {
    this.recomputeRollupsCalls.push({ scope, ids });
    if (this.recomputeError) throw this.recomputeError;
  }
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

const HH = 'test-household-corrections';
const SCOPE: HouseholdScope = { householdId: HH };

async function seedHousehold(db: FinanceDb): Promise<void> {
  await db.insert(households).values({ id: HH, name: 'Test Household' });
}

async function seedReceiptItem(
  db: FinanceDb,
  opts: { needsReview?: boolean } = {},
): Promise<{ receiptId: string; itemId: string }> {
  const receiptId = `receipt-${randomUUID()}`;
  const itemId = `ri-${randomUUID()}`;
  await db.insert(receipts).values({
    id: receiptId,
    householdId: HH,
    source: 'manual',
    store: 'COSTCO',
    purchasedAt: '2025-01-15',
    totalCents: 1000,
    needsReview: false,
  });
  await db.insert(receiptItems).values({
    id: itemId,
    receiptId,
    lineNo: 1,
    rawDescription: 'KS EVOO',
    quantity: 1,
    linePriceCents: 1000,
    needsReview: opts.needsReview ?? false,
  });
  return { receiptId, itemId };
}

function makeSkuResolutionItem(id: string): QueueItem {
  return { id, type: 'sku_resolution', reason: 'test', amountCents: 1000 };
}

function makeUnmatchedTxnItem(id: string): QueueItem {
  return { id, type: 'unmatched_txn', reason: 'test', amountCents: 5000 };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('applyCorrection', () => {
  let db: FinanceDb;
  let cleanup: () => void;
  let gw: SpyGateway;

  beforeEach(async () => {
    ({ db, cleanup } = await createCorrectionTestDb());
    await seedHousehold(db);
    gw = new SpyGateway();
  });

  afterEach(() => cleanup());

  // -------------------------------------------------------------------------
  // confirm
  // -------------------------------------------------------------------------

  describe('confirm', () => {
    it('writes review_decisions row with decision=confirm, payloadJson=null', async () => {
      const { itemId } = await seedReceiptItem(db, { needsReview: true });
      const item = makeSkuResolutionItem(itemId);

      const result = await applyCorrection(SCOPE, item, { type: 'confirm' }, gw, db);

      expect(result.removedItemId).toBe(itemId);

      const rows = await db.select().from(reviewDecisions).where(
        eq(reviewDecisions.itemId, itemId),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.decision).toBe('confirm');
      expect(rows[0]!.payloadJson).toBeNull();
      expect(rows[0]!.householdId).toBe(HH);
    });

    it('does NOT upsert sku_dictionary', async () => {
      const { itemId } = await seedReceiptItem(db, { needsReview: true });
      const item = makeSkuResolutionItem(itemId);

      await applyCorrection(SCOPE, item, { type: 'confirm' }, gw, db);

      const rows = await db.select().from(skuDictionary);
      expect(rows).toHaveLength(0);
    });

    it('calls recomputeRollups with [item.id]', async () => {
      const { itemId } = await seedReceiptItem(db, { needsReview: true });
      const item = makeSkuResolutionItem(itemId);

      await applyCorrection(SCOPE, item, { type: 'confirm' }, gw, db);

      expect(gw.recomputeRollupsCalls).toHaveLength(1);
      expect(gw.recomputeRollupsCalls[0]!.ids).toEqual([itemId]);
    });
  });

  // -------------------------------------------------------------------------
  // dismiss
  // -------------------------------------------------------------------------

  describe('dismiss', () => {
    it('writes review_decisions row with decision=dismiss, does NOT mutate sku_dictionary', async () => {
      const { itemId } = await seedReceiptItem(db, { needsReview: true });
      const item = makeSkuResolutionItem(itemId);

      const result = await applyCorrection(SCOPE, item, { type: 'dismiss' }, gw, db);

      expect(result.removedItemId).toBe(itemId);

      const decRows = await db.select().from(reviewDecisions).where(
        eq(reviewDecisions.itemId, itemId),
      );
      expect(decRows).toHaveLength(1);
      expect(decRows[0]!.decision).toBe('dismiss');

      const skuRows = await db.select().from(skuDictionary);
      expect(skuRows).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // correct — pickCategoryId
  // -------------------------------------------------------------------------

  describe('correct → pickCategoryId', () => {
    it('persists payload but does NOT upsert sku_dictionary', async () => {
      const { itemId } = await seedReceiptItem(db, { needsReview: true });
      const item = makeSkuResolutionItem(itemId);
      const action = {
        type: 'correct' as const,
        correction: { variant: 'pickCategoryId' as const, categoryId: 'cat-groceries' },
      };

      await applyCorrection(SCOPE, item, action, gw, db);

      const decRows = await db.select().from(reviewDecisions).where(
        eq(reviewDecisions.itemId, itemId),
      );
      expect(decRows).toHaveLength(1);
      expect(decRows[0]!.decision).toBe('correct');
      expect(JSON.parse(decRows[0]!.payloadJson!)).toEqual(action.correction);

      const skuRows = await db.select().from(skuDictionary);
      expect(skuRows).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // correct — pickMatchCandidateId
  // -------------------------------------------------------------------------

  describe('correct → pickMatchCandidateId', () => {
    it('persists payload but does NOT upsert sku_dictionary', async () => {
      const itemId = `txn-${randomUUID()}`;
      const item = makeUnmatchedTxnItem(itemId);
      const action = {
        type: 'correct' as const,
        correction: { variant: 'pickMatchCandidateId' as const, candidateId: 'match-abc' },
      };

      await applyCorrection(SCOPE, item, action, gw, db);

      const decRows = await db.select().from(reviewDecisions).where(
        eq(reviewDecisions.itemId, itemId),
      );
      expect(decRows).toHaveLength(1);
      expect(decRows[0]!.decision).toBe('correct');
      expect(JSON.parse(decRows[0]!.payloadJson!)).toEqual(action.correction);

      const skuRows = await db.select().from(skuDictionary);
      expect(skuRows).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // correct — editResolution
  // -------------------------------------------------------------------------

  describe('correct → editResolution', () => {
    it('persists payload AND upserts sku_dictionary with confidence=1.0 source=human', async () => {
      const { itemId } = await seedReceiptItem(db, { needsReview: true });
      const item = makeSkuResolutionItem(itemId);
      const action = {
        type: 'correct' as const,
        correction: {
          variant: 'editResolution' as const,
          store: 'COSTCO',
          skuOrAbbrev: 'KS-EVOO',
          canonicalName: 'Kirkland Organic Olive Oil',
          category: 'groceries',
        },
      };

      await applyCorrection(SCOPE, item, action, gw, db);

      const decRows = await db.select().from(reviewDecisions).where(
        eq(reviewDecisions.itemId, itemId),
      );
      expect(decRows).toHaveLength(1);
      expect(decRows[0]!.decision).toBe('correct');

      const skuRows = await db.select().from(skuDictionary);
      expect(skuRows).toHaveLength(1);
      expect(skuRows[0]!.canonicalName).toBe('Kirkland Organic Olive Oil');
      expect(skuRows[0]!.category).toBe('groceries');
      expect(skuRows[0]!.nameConfidence).toBe(1.0);
      expect(skuRows[0]!.categoryConfidence).toBe(1.0);
      expect(skuRows[0]!.source).toBe('human');
    });

    it('overwrites existing auto sku_dictionary entry on conflict', async () => {
      const { itemId } = await seedReceiptItem(db, { needsReview: true });
      const item = makeSkuResolutionItem(itemId);
      const action = {
        type: 'correct' as const,
        correction: {
          variant: 'editResolution' as const,
          store: 'COSTCO',
          skuOrAbbrev: 'KS-EVOO',
          canonicalName: 'Updated Name',
          category: 'household',
        },
      };

      // Pre-seed an existing auto entry
      await db.insert(skuDictionary).values({
        store: 'COSTCO',
        skuOrAbbrev: 'KS-EVOO',
        canonicalName: 'Old Name',
        category: 'groceries',
        nameConfidence: 0.7,
        categoryConfidence: 0.6,
        source: 'auto',
        updatedAt: 1000,
      });

      await applyCorrection(SCOPE, item, action, gw, db);

      const skuRows = await db.select().from(skuDictionary);
      expect(skuRows).toHaveLength(1);
      expect(skuRows[0]!.canonicalName).toBe('Updated Name');
      expect(skuRows[0]!.category).toBe('household');
      expect(skuRows[0]!.source).toBe('human');
    });

    it('overwrites existing human sku_dictionary entry on conflict (human-over-human always wins)', async () => {
      const { itemId } = await seedReceiptItem(db, { needsReview: true });
      const item = makeSkuResolutionItem(itemId);

      // Pre-seed an earlier human entry
      await db.insert(skuDictionary).values({
        store: 'WALMART',
        skuOrAbbrev: 'GV-BREAD',
        canonicalName: 'Great Value White Bread',
        category: 'groceries',
        nameConfidence: 1.0,
        categoryConfidence: 1.0,
        source: 'human',
        updatedAt: 1000,
      });

      const action = {
        type: 'correct' as const,
        correction: {
          variant: 'editResolution' as const,
          store: 'WALMART',
          skuOrAbbrev: 'GV-BREAD',
          canonicalName: 'Great Value Wheat Bread',
          category: 'groceries',
        },
      };

      await applyCorrection(SCOPE, item, action, gw, db);

      const skuRows = await db.select().from(skuDictionary).where(
        eq(skuDictionary.skuOrAbbrev, 'GV-BREAD'),
      );
      expect(skuRows).toHaveLength(1);
      expect(skuRows[0]!.canonicalName).toBe('Great Value Wheat Bread');
      expect(skuRows[0]!.source).toBe('human');
    });
  });

  // -------------------------------------------------------------------------
  // Atomicity: recomputeRollups throwing rolls back writes
  // -------------------------------------------------------------------------

  describe('atomicity', () => {
    it('rolls back review_decisions and sku_dictionary if recomputeRollups throws', async () => {
      const { itemId } = await seedReceiptItem(db, { needsReview: true });
      const item = makeSkuResolutionItem(itemId);
      const action = {
        type: 'correct' as const,
        correction: {
          variant: 'editResolution' as const,
          store: 'WALMART',
          skuOrAbbrev: 'GV-MILK',
          canonicalName: 'Great Value Milk',
          category: 'groceries',
        },
      };

      gw.recomputeError = new Error('rollup engine down');

      await expect(
        applyCorrection(SCOPE, item, action, gw, db),
      ).rejects.toThrow('rollup engine down');

      // Decision row must NOT exist
      const decRows = await db.select().from(reviewDecisions).where(
        eq(reviewDecisions.itemId, itemId),
      );
      expect(decRows).toHaveLength(0);

      // sku_dictionary must NOT have been written
      const skuRows = await db.select().from(skuDictionary);
      expect(skuRows).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Idempotency / UNIQUE constraint
  // -------------------------------------------------------------------------

  describe('idempotency', () => {
    it('second terminal decision on same (itemType, itemId) is rejected by UNIQUE constraint', async () => {
      const { itemId } = await seedReceiptItem(db, { needsReview: true });
      const item = makeSkuResolutionItem(itemId);

      await applyCorrection(SCOPE, item, { type: 'confirm' }, gw, db);

      await expect(
        applyCorrection(SCOPE, item, { type: 'dismiss' }, gw, db),
      ).rejects.toThrow();

      // Still only one row
      const rows = await db.select().from(reviewDecisions).where(
        eq(reviewDecisions.itemId, itemId),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.decision).toBe('confirm');
    });
  });

  // -------------------------------------------------------------------------
  // Bounded recompute
  // -------------------------------------------------------------------------

  describe('bounded recompute', () => {
    it('recomputeRollups receives only [item.id], not all household items', async () => {
      const { itemId: id1 } = await seedReceiptItem(db, { needsReview: true });
      const { itemId: id2 } = await seedReceiptItem(db, { needsReview: true });
      const item = makeSkuResolutionItem(id1);

      await applyCorrection(SCOPE, item, { type: 'confirm' }, gw, db);

      expect(gw.recomputeRollupsCalls).toHaveLength(1);
      const call = gw.recomputeRollupsCalls[0]!;
      expect(call.ids).toEqual([id1]);
      expect(call.ids).not.toContain(id2);
    });
  });
});
