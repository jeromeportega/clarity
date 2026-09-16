/**
 * The upload composition root persists for real: an uploaded receipt lands
 * in `receipts` / `receipt_items`, confident resolutions land in
 * `sku_dictionary`, and a re-upload of the same bytes is a no-op — across
 * requests, against a real (throwaway) libSQL database.
 *
 * Lives in tests/ because it imports the app-layer factory
 * (apps/web/lib/receipt-pipeline.ts); the vision and LLM seams are injected
 * so no key or network is involved.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

process.env.TMPDIR = mkdtempSync(join(tmpdir(), 'clarity-pipeline-persist-'));

import { buildReceiptPipelineDeps } from '../apps/web/lib/receipt-pipeline';
import { skuDictionary } from '../modules/finance/core/receipts/dictionary/schema';
import { imageHash } from '../modules/finance/core/receipts/image-hash';
import type { Resolution, ResolutionQuery, SkuResolver } from '../modules/finance/core/receipts/resolver/sku-resolver';
import { LibSqlReceiptStore } from '../modules/finance/core/receipts/store/libsql-receipt-store';
import { StubReceiptStore } from '../modules/finance/core/receipts/store/stub-receipt-store';
import { handleReceiptUpload } from '../modules/finance/core/receipts/upload';
import type { ExtractedReceipt, VisionProvider } from '../modules/finance/core/receipts/vision/vision-provider';
import { createTestDb, type FinanceDb } from '../modules/finance/db/client';
import { receiptItems, receipts } from '../modules/finance/db/schema';
import { DEMO_HOUSEHOLD_ID, seed } from '../modules/finance/scripts/seed';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const recordedDir = join(repoRoot, 'modules/finance/core/receipts/fixtures/eval/recorded');

function loadFixture(name: string): ExtractedReceipt {
  return JSON.parse(readFileSync(join(recordedDir, `${name}.json`), 'utf8')) as ExtractedReceipt;
}

/** Replays a recorded extraction regardless of the bytes (the fixture is the recording). */
class StaticVision implements VisionProvider {
  calls = 0;
  constructor(private readonly receipt: ExtractedReceipt) {}
  async extract(): Promise<ExtractedReceipt> {
    this.calls += 1;
    return this.receipt;
  }
}

/** High-confidence resolver: every line gets a name + the first allowed category. */
class ConfidentResolver implements SkuResolver {
  calls = 0;
  async resolve(query: ResolutionQuery): Promise<Resolution> {
    this.calls += 1;
    return {
      canonicalName: `Canonical ${query.description}`,
      category: query.categories[0]!,
      nameConfidence: 0.95,
      categoryConfidence: 0.95,
      source: 'auto',
    };
  }
}

const UNREADABLE: ExtractedReceipt = {
  readable: false,
  store: null,
  purchasedAt: null,
  total: null,
  tax: null,
  fees: [],
  paymentHint: null,
  lineItems: [],
};

describe('receipt upload persistence (real libSQL store + dictionary)', () => {
  let db: FinanceDb;
  let cleanup: () => void;

  beforeEach(async () => {
    const handle = createTestDb();
    db = handle.db;
    cleanup = handle.cleanup;
    await db.run(sql`PRAGMA foreign_keys = ON`);
    await seed(db);
  });

  afterEach(() => cleanup());

  async function count(table: string): Promise<number> {
    const r = await db.run(sql.raw(`SELECT count(*) AS c FROM ${table}`));
    return Number(r.rows[0]?.c);
  }

  it('persists the receipt, its line items, and the learned SKUs', async () => {
    const vision = new StaticVision(loadFixture('clean-fees'));
    const llm = new ConfidentResolver();
    const deps = buildReceiptPipelineDeps(db, DEMO_HOUSEHOLD_ID, { vision, llm, env: {} });
    const bytes = new Uint8Array([1, 2, 3, 4]);

    const outcome = await handleReceiptUpload(bytes, 'image/png', deps);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.idempotent).toBe(false);
    expect(outcome.result.items.length).toBeGreaterThan(0);

    expect(await count('receipts')).toBe(1);
    expect(await count('receipt_items')).toBe(outcome.result.items.length);
    const row = (await db.select().from(receipts))[0]!;
    expect(row.householdId).toBe(DEMO_HOUSEHOLD_ID);
    expect(row.source).toBe('photo');
    expect(row.imageHash).toBe(imageHash(bytes));

    const items = await db.select().from(receiptItems).where(eq(receiptItems.receiptId, row.id));
    expect(items.every((i) => i.canonicalName?.startsWith('Canonical '))).toBe(true);
    expect(items.every((i) => i.categoryId !== null)).toBe(true);

    // Confident resolutions were written back to the persistent dictionary.
    const learned = await db.select().from(skuDictionary);
    expect(learned.length).toBe(outcome.result.items.length);
    expect(learned.every((d) => d.source === 'auto')).toBe(true);
  });

  it('a re-upload of the same bytes is idempotent across requests: no new rows, no model calls', async () => {
    const vision = new StaticVision(loadFixture('clean-fees'));
    const llm = new ConfidentResolver();
    const bytes = new Uint8Array([9, 9, 9]);

    // Two separate composition roots, as two HTTP requests would build.
    const first = await handleReceiptUpload(bytes, 'image/png', buildReceiptPipelineDeps(db, DEMO_HOUSEHOLD_ID, { vision, llm, env: {} }));
    const second = await handleReceiptUpload(bytes, 'image/png', buildReceiptPipelineDeps(db, DEMO_HOUSEHOLD_ID, { vision, llm, env: {} }));
    expect(first.ok && !first.result.idempotent).toBe(true);
    expect(second.ok && second.result.idempotent).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.result.receipt.id).toBe(first.result.receipt.id);

    expect(vision.calls).toBe(1);
    expect(await count('receipts')).toBe(1);
  });

  it('the dictionary is consulted on the next receipt: a learned SKU costs no resolver call', async () => {
    const vision = new StaticVision(loadFixture('clean-fees'));
    const llm = new ConfidentResolver();
    await handleReceiptUpload(new Uint8Array([1]), 'image/png', buildReceiptPipelineDeps(db, DEMO_HOUSEHOLD_ID, { vision, llm, env: {} }));
    const callsAfterFirst = llm.calls;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Different bytes (a new photo of the same kind of receipt) → same SKUs hit the dictionary.
    await handleReceiptUpload(new Uint8Array([2]), 'image/png', buildReceiptPipelineDeps(db, DEMO_HOUSEHOLD_ID, { vision, llm, env: {} }));
    expect(llm.calls).toBe(callsAfterFirst);
    expect(await count('receipts')).toBe(2);
  });

  it('an unreadable photo is persisted as a flagged placeholder, never lost', async () => {
    const deps = buildReceiptPipelineDeps(db, DEMO_HOUSEHOLD_ID, { vision: new StaticVision(UNREADABLE), llm: new ConfidentResolver(), env: {} });
    const outcome = await handleReceiptUpload(new Uint8Array([7]), 'image/jpeg', deps);
    expect(outcome.ok && outcome.result.status === 'needs_review').toBe(true);
    const row = (await db.select().from(receipts))[0]!;
    expect(row.needsReview).toBe(true);
    expect(row.totalCents).toBe(0);
    expect(await count('receipt_items')).toBe(0);
  });

  it('idempotency is scoped to the household: another household keeps its own copy', async () => {
    await db.run(sql`INSERT INTO households (id, name) VALUES ('hh-2', 'Other')`);
    const vision = new StaticVision(loadFixture('clean-fees'));
    const llm = new ConfidentResolver();
    const bytes = new Uint8Array([5, 5]);
    await handleReceiptUpload(bytes, 'image/png', buildReceiptPipelineDeps(db, DEMO_HOUSEHOLD_ID, { vision, llm, env: {} }));
    const other = await handleReceiptUpload(bytes, 'image/png', buildReceiptPipelineDeps(db, 'hh-2', { vision, llm, env: {} }));
    expect(other.ok && !other.result.idempotent).toBe(true);
    expect(await count('receipts')).toBe(2);
  });

  it('refuses an injected store scoped to a different household than the pipeline', () => {
    const foreign = new LibSqlReceiptStore(db, { householdId: 'hh-2' });
    expect(() => buildReceiptPipelineDeps(db, DEMO_HOUSEHOLD_ID, { store: foreign, env: {} }))
      .toThrow(/scoped to household hh-2/);

    // A store scoped to the same household, or one with no scope at all, is fine.
    const same = new LibSqlReceiptStore(db, { householdId: DEMO_HOUSEHOLD_ID });
    expect(() => buildReceiptPipelineDeps(db, DEMO_HOUSEHOLD_ID, { store: same, env: {} })).not.toThrow();
    expect(() => buildReceiptPipelineDeps(db, DEMO_HOUSEHOLD_ID, { store: new StubReceiptStore(), env: {} })).not.toThrow();
  });
});
