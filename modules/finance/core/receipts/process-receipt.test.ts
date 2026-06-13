import { describe, expect, it, vi } from 'vitest';
import type { Resolution, ResolutionQuery, SkuResolver } from './resolver/sku-resolver';
import { StubReceiptStore } from './store/stub-receipt-store';
import { StubSkuDictionary } from './dictionary/stub-sku-dictionary';
import {
  type ExtractedLineItem,
  type ExtractedReceipt,
  type ReceiptImageInput,
  type VisionProvider,
  unreadableReceipt,
} from './vision/vision-provider';
import { processReceipt, type ReceiptPipelineDeps } from './process-receipt';

// =============================================================================
// Offline, deterministic integration tests of the pipeline. Every seam is a
// recorded/stub double: a FakeVision that replays a canned ExtractedReceipt, a
// FakeResolver that returns canned Resolutions (and records its calls), the real
// StubReceiptStore (spied for write-count assertions) + StubSkuDictionary, and a
// fixed clock. No API key, no network.
// =============================================================================

// --- fixtures / builders ----------------------------------------------------

const FIXED_NOW = 1_700_000_000_000;

const bytes = (data: number[]): ReceiptImageInput => ({
  bytes: new Uint8Array(data),
  mimeType: 'image/png',
});

const line = (overrides: Partial<ExtractedLineItem> = {}): ExtractedLineItem => ({
  sku: null,
  rawDescription: 'ITEM',
  quantity: 1,
  unitPrice: null,
  linePrice: 0,
  discount: 0,
  ...overrides,
});

const extracted = (overrides: Partial<ExtractedReceipt> = {}): ExtractedReceipt => ({
  readable: true,
  store: 'COSTCO',
  purchasedAt: '2026-06-13',
  total: null,
  tax: 0,
  fees: [],
  paymentHint: null,
  lineItems: [],
  ...overrides,
});

const resolution = (overrides: Partial<Resolution> = {}): Resolution => ({
  canonicalName: 'Canonical Product',
  category: 'groceries',
  nameConfidence: 0.95,
  categoryConfidence: 0.9,
  source: 'auto',
  ...overrides,
});

class FakeVision implements VisionProvider {
  constructor(private readonly receipt: ExtractedReceipt) {}
  async extract(): Promise<ExtractedReceipt> {
    return this.receipt;
  }
}

// Returns a canned Resolution per line description (falling back to a default),
// recording every query so wiring order / call-count can be asserted.
class FakeResolver implements SkuResolver {
  public readonly calls: ResolutionQuery[] = [];
  constructor(
    private readonly byDescription: Record<string, Resolution> = {},
    private readonly fallback: Resolution = resolution(),
  ) {}
  async resolve(query: ResolutionQuery): Promise<Resolution> {
    this.calls.push(query);
    return this.byDescription[query.description] ?? this.fallback;
  }
}

interface HarnessOpts {
  receipt: ExtractedReceipt;
  resolver?: FakeResolver;
}

function harness({ receipt, resolver = new FakeResolver() }: HarnessOpts) {
  const store = new StubReceiptStore({ clock: () => FIXED_NOW });
  const insertReceipt = vi.spyOn(store, 'insertReceipt');
  const insertReceiptItems = vi.spyOn(store, 'insertReceiptItems');
  const findReceiptByImageHash = vi.spyOn(store, 'findReceiptByImageHash');
  const deps: ReceiptPipelineDeps = {
    vision: new FakeVision(receipt),
    resolver,
    dictionary: new StubSkuDictionary(),
    store,
    clock: () => FIXED_NOW,
  };
  return { deps, resolver, spies: { insertReceipt, insertReceiptItems, findReceiptByImageHash } };
}

// A receipt that reconciles exactly: two high-confidence items, tax, no fees.
const reconcilingReceipt = (overrides: Partial<ExtractedReceipt> = {}): ExtractedReceipt =>
  extracted({
    lineItems: [
      line({ rawDescription: 'HI-A', linePrice: 1000 }),
      line({ rawDescription: 'HI-B', linePrice: 500 }),
    ],
    tax: 80,
    total: 1580,
    ...overrides,
  });

// --- happy path -------------------------------------------------------------

describe('processReceipt — happy path', () => {
  it('returns status ok, per-field confidence, and writes once each', async () => {
    const { deps, spies } = harness({ receipt: reconcilingReceipt() });
    const out = await processReceipt(bytes([1, 2, 3]), deps);

    expect(out.status).toBe('ok');
    expect(out.idempotent).toBe(false);
    expect(out.receipt.needsReview).toBe(false);
    expect(out.items).toHaveLength(2);

    expect(out.items[0]).toMatchObject({
      rawDescription: 'HI-A',
      lineNo: 1,
      canonicalName: 'Canonical Product',
      categoryId: 'groceries',
      linePriceCents: 1000,
      nameConfidence: 0.95,
      categoryConfidence: 0.9,
      needsReview: false,
    });
    expect(out.items[1]).toMatchObject({ lineNo: 2, linePriceCents: 500, needsReview: false });

    expect(spies.insertReceipt).toHaveBeenCalledTimes(1);
    expect(spies.insertReceiptItems).toHaveBeenCalledTimes(1);
  });

  it('persists receipt-level fields (totals, tax, subtotal, image hash)', async () => {
    const { deps } = harness({ receipt: reconcilingReceipt() });
    const out = await processReceipt(bytes([9, 9]), deps);
    expect(out.receipt).toMatchObject({
      store: 'COSTCO',
      totalCents: 1580,
      taxCents: 80,
      subtotalCents: 1500,
      needsReview: false,
    });
    expect(out.receipt.imageHash).toHaveLength(64); // sha-256 hex
  });
});

// --- below-threshold item (FR-14) ------------------------------------------

describe('processReceipt — below-threshold item (FR-14)', () => {
  it('flags only the weak item and the whole receipt, leaving siblings clean', async () => {
    const resolver = new FakeResolver({
      'HI-A': resolution({ nameConfidence: 0.95, categoryConfidence: 0.9 }),
      'HI-B': resolution({ nameConfidence: 0.5, categoryConfidence: 0.9 }), // weak name axis
    });
    const { deps } = harness({ receipt: reconcilingReceipt(), resolver });
    const out = await processReceipt(bytes([4, 2]), deps);

    expect(out.status).toBe('needs_review');
    expect(out.receipt.needsReview).toBe(true);
    expect(out.items[0].needsReview).toBe(false); // sibling unaffected
    expect(out.items[1].needsReview).toBe(true);
  });
});

// --- reconciliation mismatch (FR-15) ---------------------------------------

describe('processReceipt — reconciliation mismatch (FR-15)', () => {
  it('flags the whole receipt even when every item is high-confidence', async () => {
    // computed = 1000 + 80 = 1080; printed 2000 => off by 920 (> tolerance).
    const receipt = extracted({
      lineItems: [line({ rawDescription: 'HI-A', linePrice: 1000 })],
      tax: 80,
      total: 2000,
    });
    const { deps } = harness({ receipt });
    const out = await processReceipt(bytes([7]), deps);

    expect(out.status).toBe('needs_review');
    expect(out.receipt.needsReview).toBe(true);
    expect(out.items[0].needsReview).toBe(false); // item itself is fine
  });
});

// --- unreadable extraction (FR-6) ------------------------------------------

describe('processReceipt — unreadable extraction (FR-6)', () => {
  it('persists a zero-item needs_review record and resolves nothing', async () => {
    const { deps, resolver, spies } = harness({ receipt: unreadableReceipt() });
    const out = await processReceipt(bytes([0, 0, 0]), deps);

    expect(out.status).toBe('needs_review');
    expect(out.receipt.needsReview).toBe(true);
    expect(out.items).toEqual([]);
    expect(resolver.calls).toHaveLength(0); // no fabricated items
    expect(spies.insertReceipt).toHaveBeenCalledTimes(1);
    expect(spies.insertReceiptItems).not.toHaveBeenCalled();
  });
});

// --- idempotency (FR-2) -----------------------------------------------------

describe('processReceipt — idempotency (FR-2)', () => {
  it('re-submitting identical bytes is a no-op that links the existing record', async () => {
    const { deps, spies } = harness({ receipt: reconcilingReceipt() });
    const photo = bytes([5, 5, 5, 5]);

    const first = await processReceipt(photo, deps);
    expect(first.idempotent).toBe(false);

    const second = await processReceipt(photo, deps);
    expect(second.idempotent).toBe(true);
    expect(second.receipt.id).toBe(first.receipt.id);
    expect(second.receipt.imageHash).toBe(first.receipt.imageHash);
    expect(second.status).toBe('ok');

    // ZERO new writes on the second submit.
    expect(spies.insertReceipt).toHaveBeenCalledTimes(1);
    expect(spies.insertReceiptItems).toHaveBeenCalledTimes(1);
    expect(spies.findReceiptByImageHash).toHaveBeenCalledTimes(2);
  });

  it('a one-byte change is a distinct receipt (writes again)', async () => {
    const { deps, spies } = harness({ receipt: reconcilingReceipt() });
    await processReceipt(bytes([1, 2, 3]), deps);
    const other = await processReceipt(bytes([1, 2, 4]), deps);
    expect(other.idempotent).toBe(false);
    expect(spies.insertReceipt).toHaveBeenCalledTimes(2);
  });
});

// --- configurability (NFR-3) -----------------------------------------------

describe('processReceipt — configurability (NFR-3)', () => {
  it('arithmeticToleranceCents: 0 turns a 1¢ delta into needs_review', async () => {
    // computed 1000, printed 1001 => 1¢ off.
    const receipt = extracted({
      lineItems: [line({ rawDescription: 'HI-A', linePrice: 1000 })],
      tax: 0,
      total: 1001,
    });

    const ok = await processReceipt(bytes([1]), harness({ receipt }).deps);
    expect(ok.status).toBe('ok'); // default tolerance 2 absorbs 1¢

    const strict = await processReceipt(bytes([1]), harness({ receipt }).deps, {
      arithmeticToleranceCents: 0,
    });
    expect(strict.status).toBe('needs_review');
  });

  it('confidenceThreshold: 0.9 flags an item that passed at 0.8', async () => {
    const resolver = () =>
      new FakeResolver({
        'HI-A': resolution({ nameConfidence: 0.85, categoryConfidence: 0.95 }),
      });
    const receipt = extracted({
      lineItems: [line({ rawDescription: 'HI-A', linePrice: 1000 })],
      tax: 0,
      total: 1000,
    });

    const lenient = await processReceipt(bytes([2]), harness({ receipt, resolver: resolver() }).deps);
    expect(lenient.items[0].needsReview).toBe(false);
    expect(lenient.status).toBe('ok');

    const strict = await processReceipt(
      bytes([2]),
      harness({ receipt, resolver: resolver() }).deps,
      { confidenceThreshold: 0.9 },
    );
    expect(strict.items[0].needsReview).toBe(true);
    expect(strict.status).toBe('needs_review');
  });
});

// --- wiring order -----------------------------------------------------------

describe('processReceipt — wiring', () => {
  it('invokes the resolver exactly once per line item, in order', async () => {
    const resolver = new FakeResolver();
    const receipt = extracted({
      lineItems: [
        line({ rawDescription: 'A', linePrice: 100 }),
        line({ rawDescription: 'B', linePrice: 200 }),
        line({ rawDescription: 'C', linePrice: 300 }),
      ],
      tax: 0,
      total: 600,
    });
    const { deps } = harness({ receipt, resolver });
    await processReceipt(bytes([3, 3]), deps);

    expect(resolver.calls.map((q) => q.description)).toEqual(['A', 'B', 'C']);
    expect(resolver.calls.every((q) => q.store === 'COSTCO')).toBe(true);
  });

  it('passes the store taxonomy through to each resolve() call', async () => {
    const resolver = new FakeResolver();
    const { deps } = harness({ receipt: reconcilingReceipt(), resolver });
    await processReceipt(bytes([6, 6]), deps);
    expect(resolver.calls[0].categories).toContain('groceries');
  });
});
