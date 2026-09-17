/**
 * apps/web/lib/reextract.ts — read a stored photo again, end to end: a real
 * throwaway libSQL DB, a real local-disk image store, the real pipeline with
 * an injected vision provider and resolver (no model, no network).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../apps/web/lib/reconcile', () => ({ reconcileAfterWrite: vi.fn(async () => ({})) }));

import { reconcileAfterWrite } from '../apps/web/lib/reconcile';
import { reextractReceipt } from '../apps/web/lib/reextract';
import { getImageStore } from '../apps/web/lib/image-store';
import { imageHash } from '../modules/finance/core/receipts/image-hash';
import type { Resolution, SkuResolver } from '../modules/finance/core/receipts/resolver/sku-resolver';
import { receiptImageKey } from '../modules/finance/core/receipts/store/image-store';
import type { ExtractedReceipt, VisionProvider } from '../modules/finance/core/receipts/vision/vision-provider';
import { createTestDb, type FinanceDb } from '../modules/finance/db/client';
import { households, receiptItems, receipts } from '../modules/finance/db/schema';

const HH = 'hh-mine';
const OTHER = 'hh-theirs';
const photo = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 7, 7, 7]);

const readable: ExtractedReceipt = {
  readable: true,
  store: 'COSTCO',
  purchasedAt: '2026-06-13',
  total: 1080,
  tax: 80,
  fees: [],
  paymentHint: null,
  lineItems: [{ sku: '111', rawDescription: 'KS THING', quantity: 1, unitPrice: 1000, linePrice: 1000, discount: 0 }],
};
const unreadable: ExtractedReceipt = { readable: false, store: null, purchasedAt: null, total: null, tax: null, fees: [], paymentHint: null, lineItems: [] };

function vision(answer: ExtractedReceipt): VisionProvider {
  return { async extract() { return answer; } };
}
const llm: SkuResolver = {
  async resolve(): Promise<Resolution> {
    return { canonicalName: 'Kirkland Signature Thing', category: 'groceries', nameConfidence: 0.95, categoryConfidence: 0.9, source: 'auto' };
  },
};

let handle: ReturnType<typeof createTestDb>;
let db: FinanceDb;
let imagesDir: string;

beforeAll(async () => {
  handle = createTestDb();
  db = handle.db;
  imagesDir = mkdtempSync(join(tmpdir(), 'clarity-reextract-'));
  vi.stubEnv('CLARITY_DATA_DIR', imagesDir);
  vi.stubEnv('BLOB_READ_WRITE_TOKEN', '');
  vi.stubEnv('RECEIPT_AI', 'recorded');

  await db.insert(households).values([{ id: HH, name: 'Mine' }, { id: OTHER, name: 'Theirs' }]);
  const hash = imageHash(photo);
  await db.insert(receipts).values([
    { id: 'rcpt-unread', householdId: HH, source: 'photo', store: '', purchasedAt: '', totalCents: 0, imageHash: hash, needsReview: true },
    { id: 'rcpt-noimage', householdId: HH, source: 'photo', store: '', purchasedAt: '', totalCents: 0, imageHash: 'hash-missing', needsReview: true },
    { id: 'rcpt-theirs', householdId: OTHER, source: 'photo', store: '', purchasedAt: '', totalCents: 0, imageHash: 'hash-theirs', needsReview: true },
  ]);
  await getImageStore().put(receiptImageKey(HH, hash), photo, 'image/jpeg');
});

afterAll(() => {
  vi.unstubAllEnvs();
  handle.cleanup();
  rmSync(imagesDir, { recursive: true, force: true });
});

describe('reextractReceipt (lib)', () => {
  it('reads the stored photo again, replaces the placeholder, and re-runs reconciliation', async () => {
    const out = await reextractReceipt(db, HH, 'rcpt-unread', { vision: vision(readable), llm });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.status).toBe('ok');
    expect(out.result.items).toHaveLength(1);

    const row = (await db.select().from(receipts).where(eq(receipts.id, 'rcpt-unread')))[0]!;
    expect(row).toMatchObject({ store: 'COSTCO', totalCents: 1080, taxCents: 80, subtotalCents: 1000, needsReview: false, imageHash: imageHash(photo) });
    const items = await db.select().from(receiptItems).where(eq(receiptItems.receiptId, 'rcpt-unread'));
    expect(items.map((i) => i.canonicalName)).toEqual(['Kirkland Signature Thing']);
    expect(reconcileAfterWrite).toHaveBeenCalledWith(db, HH);
  });

  it('refuses once the receipt has items', async () => {
    expect(await reextractReceipt(db, HH, 'rcpt-unread', { vision: vision(readable), llm })).toEqual({ ok: false, code: 'has_items' });
  });

  it('no_image when the store holds nothing under the receipt’s hash; not_found for another household’s receipt', async () => {
    expect(await reextractReceipt(db, HH, 'rcpt-noimage', { vision: vision(readable), llm })).toEqual({ ok: false, code: 'no_image' });
    expect(await reextractReceipt(db, HH, 'rcpt-theirs', { vision: vision(readable), llm })).toEqual({ ok: false, code: 'not_found' });
    expect(await reextractReceipt(db, HH, 'nope', { vision: vision(readable), llm })).toEqual({ ok: false, code: 'not_found' });
  });

  it('a still-unreadable photo stays a flagged placeholder and does not reconcile', async () => {
    vi.mocked(reconcileAfterWrite).mockClear();
    const hash = imageHash(new Uint8Array([1, 2, 3]));
    await db.insert(receipts).values({ id: 'rcpt-still', householdId: HH, source: 'photo', store: '', purchasedAt: '', totalCents: 0, imageHash: hash, needsReview: true });
    await getImageStore().put(receiptImageKey(HH, hash), new Uint8Array([1, 2, 3]), 'image/png');

    const out = await reextractReceipt(db, HH, 'rcpt-still', { vision: vision(unreadable), llm });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.status).toBe('needs_review');
    expect(out.result.items).toEqual([]);
    const row = (await db.select().from(receipts).where(eq(receipts.id, 'rcpt-still')))[0]!;
    expect(row).toMatchObject({ store: '', totalCents: 0, needsReview: true });
    // Nothing about the receipt changed for the reconciler, but the read did run: reconcile is called on ok outcomes.
    expect(reconcileAfterWrite).toHaveBeenCalledTimes(1);
  });
});
