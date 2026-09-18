import { describe, expect, it } from 'vitest';

import { StubSkuDictionary } from './dictionary/stub-sku-dictionary';
import { imageHash } from './image-hash';
import { processReceipt, type ReceiptPipelineDeps } from './process-receipt';
import { reprocessReceipt } from './reprocess-receipt';
import type { Resolution, ResolutionQuery, SkuResolver } from './resolver/sku-resolver';
import { StubReceiptStore } from './store/stub-receipt-store';
import type { ExtractedReceipt, ReceiptImageInput, VisionProvider } from './vision/vision-provider';

// Offline: a scripted vision provider (one answer per call) and a canned
// resolver, over the in-memory store — the same seams the pipeline uses.
class ScriptedVision implements VisionProvider {
  public calls = 0;
  constructor(private readonly answers: ExtractedReceipt[]) {}
  async extract(): Promise<ExtractedReceipt> {
    const next = this.answers[Math.min(this.calls, this.answers.length - 1)]!;
    this.calls += 1;
    return next;
  }
}

const highConfidence: SkuResolver = {
  async resolve(q: ResolutionQuery): Promise<Resolution> {
    return { canonicalName: `Canonical ${q.description}`, category: 'groceries', nameConfidence: 0.95, categoryConfidence: 0.9, source: 'auto' };
  },
};

const unreadable: ExtractedReceipt = {
  readable: false, store: null, purchasedAt: null, total: null, tax: null, fees: [], paymentHint: null, lineItems: [],
};

const readable: ExtractedReceipt = {
  readable: true,
  store: 'COSTCO',
  purchasedAt: '2026-06-13',
  total: 1580,
  tax: 80,
  fees: [],
  paymentHint: { method: 'VISA', last4: '4242' },
  lineItems: [
    { sku: '111', rawDescription: 'HI-A', quantity: 1, unitPrice: 1000, linePrice: 1000, discount: 0 },
    { sku: '222', rawDescription: 'HI-B', quantity: 1, unitPrice: 500, linePrice: 500, discount: 0 },
  ],
};

const photo: ReceiptImageInput = { bytes: new Uint8Array([1, 2, 3, 4]), mimeType: 'image/jpeg' };
const HH = 'hh-1';

function deps(vision: VisionProvider, store = new StubReceiptStore({ householdId: HH })): ReceiptPipelineDeps {
  return { vision, resolver: highConfidence, dictionary: new StubSkuDictionary({ householdId: HH }), store, householdId: HH };
}

describe('reprocessReceipt — reading an unreadable photo again', () => {
  it('replaces the placeholder with the new reading, keeping the row identity and the hash', async () => {
    const vision = new ScriptedVision([unreadable, readable]);
    const d = deps(vision);
    const first = await processReceipt(photo, d);
    expect(first.status).toBe('needs_review');
    expect(first.items).toEqual([]);

    const again = await reprocessReceipt(first.receipt.id, photo, d);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.result.status).toBe('ok');
    expect(again.result.receipt.id).toBe(first.receipt.id);
    expect(again.result.receipt.imageHash).toBe(imageHash(photo.bytes));
    expect(again.result.receipt).toMatchObject({ store: 'COSTCO', totalCents: 1580, taxCents: 80, subtotalCents: 1500, paymentLast4: '4242', needsReview: false });
    expect(again.result.items.map((i) => [i.lineNo, i.receiptId, i.canonicalName])).toEqual([
      [1, first.receipt.id, 'Canonical HI-A'],
      [2, first.receipt.id, 'Canonical HI-B'],
    ]);
    expect(await d.store.listReceiptItems(first.receipt.id)).toHaveLength(2);
    // The same photo is still the same receipt afterwards (idempotency intact).
    const third = await processReceipt(photo, d);
    expect(third.idempotent).toBe(true);
    expect(third.receipt.id).toBe(first.receipt.id);
  });

  it('a second unreadable read writes nothing and says so', async () => {
    const d = deps(new ScriptedVision([unreadable, unreadable]));
    const first = await processReceipt(photo, d);
    expect(await reprocessReceipt(first.receipt.id, photo, d)).toEqual({ ok: false, code: 'still_unreadable' });
    expect(await d.store.getReceiptById(first.receipt.id)).toEqual(first.receipt);
    expect(await d.store.listReceiptItems(first.receipt.id)).toEqual([]);
  });

  it('a failed re-read never erases what the row already says (a total read off a cropped photo)', async () => {
    const partial: ExtractedReceipt = { ...readable, lineItems: [] };
    const d = deps(new ScriptedVision([partial, unreadable]));
    const first = await processReceipt(photo, d);
    expect(first.items).toEqual([]);
    expect(first.receipt).toMatchObject({ store: 'COSTCO', totalCents: 1580 });
    expect(await reprocessReceipt(first.receipt.id, photo, d)).toEqual({ ok: false, code: 'still_unreadable' });
    expect(await d.store.getReceiptById(first.receipt.id)).toMatchObject({ store: 'COSTCO', totalCents: 1580 });
  });

  it('refuses a receipt that already has line items', async () => {
    const d = deps(new ScriptedVision([readable, readable]));
    const first = await processReceipt(photo, d);
    expect(first.items).toHaveLength(2);
    expect(await reprocessReceipt(first.receipt.id, photo, d)).toEqual({ ok: false, code: 'has_items' });
  });

  it('refuses bytes whose hash is not the receipt’s own', async () => {
    const d = deps(new ScriptedVision([unreadable, readable]));
    const first = await processReceipt(photo, d);
    const other: ReceiptImageInput = { bytes: new Uint8Array([9, 9, 9]), mimeType: 'image/jpeg' };
    expect(await reprocessReceipt(first.receipt.id, other, d)).toEqual({ ok: false, code: 'image_mismatch' });
    expect(await d.store.listReceiptItems(first.receipt.id)).toEqual([]);
  });

  it('is not_found for an unknown id (household scoping itself is the store contract’s job — see receipt-store-reextract.test.ts)', async () => {
    const d = deps(new ScriptedVision([unreadable]));
    expect(await reprocessReceipt('nope', photo, d)).toEqual({ ok: false, code: 'not_found' });
  });

  it('does not call vision before the guards pass', async () => {
    const vision = new ScriptedVision([readable]);
    const d = deps(vision);
    await reprocessReceipt('nope', photo, d);
    expect(vision.calls).toBe(0);
  });
});
