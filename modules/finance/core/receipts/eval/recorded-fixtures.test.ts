import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { StubSkuDictionary } from '../dictionary/stub-sku-dictionary';
import { processReceipt, type ReceiptPipelineDeps } from '../process-receipt';
import { reconcile } from '../reconcile';
import type { Resolution, ResolutionQuery, SkuResolver } from '../resolver/sku-resolver';
import { StubReceiptStore } from '../store/stub-receipt-store';
import type { ExtractedReceipt, ReceiptImageInput, VisionProvider } from '../vision/vision-provider';

// =============================================================================
// Default-gate (offline, no key) reconciliation checks over committed recorded
// fixtures (operator guidance: the integration gate must exercise arithmetic-to-
// total without a key or network). Each fixture is a recorded ExtractedReceipt
// replayed through `processReceipt`; a high-confidence stub resolver ensures the
// ONLY driver of needs_review is reconciliation, so these tests isolate FR-15.
//   - clean-fees:     a fee-bearing receipt (CRV + bag) reconciles within ±2¢.
//   - clean-multibuy: a multi-buy + instant-discount receipt reconciles within ±2¢.
//   - corrupted-total: a deliberately wrong printed total flags needs_review.
// =============================================================================

const recordedDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'eval', 'recorded');
const FIXED_NOW = 1_700_000_000_000;

function loadFixture(name: string): ExtractedReceipt {
  return JSON.parse(readFileSync(join(recordedDir, `${name}.json`), 'utf8')) as ExtractedReceipt;
}

// Replays a recorded extraction, ignoring the image bytes (the fixture IS the
// recording). Offline counterpart of the live vision call.
class StaticVision implements VisionProvider {
  constructor(private readonly receipt: ExtractedReceipt) {}
  async extract(): Promise<ExtractedReceipt> {
    return this.receipt;
  }
}

// Always returns a high-confidence resolution, so per-item review never fires
// and reconciliation is the sole determinant of the receipt's status.
class HighConfidenceResolver implements SkuResolver {
  async resolve(query: ResolutionQuery): Promise<Resolution> {
    return {
      canonicalName: query.description,
      category: query.categories[0] ?? 'groceries',
      nameConfidence: 0.99,
      categoryConfidence: 0.99,
      source: 'auto',
    };
  }
}

function depsFor(receipt: ExtractedReceipt): ReceiptPipelineDeps {
  return {
    vision: new StaticVision(receipt),
    resolver: new HighConfidenceResolver(),
    dictionary: new StubSkuDictionary(),
    store: new StubReceiptStore({ clock: () => FIXED_NOW }),
    clock: () => FIXED_NOW,
  };
}

const image: ReceiptImageInput = { bytes: new Uint8Array([1, 2, 3, 4]), mimeType: 'image/png' };

describe('recorded fixtures — clean receipts reconcile within ±$0.02 (FR-15)', () => {
  it('clean-fees: a fee-bearing receipt reconciles and is status ok', async () => {
    const receipt = loadFixture('clean-fees');

    const recon = reconcile(receipt, 2);
    expect(recon.ok).toBe(true);
    expect(Math.abs(recon.deltaCents)).toBeLessThanOrEqual(2);

    const out = await processReceipt(image, depsFor(receipt));
    expect(out.status).toBe('ok');
    expect(out.receipt.needsReview).toBe(false);
    expect(out.items).toHaveLength(2);
  });

  it('clean-multibuy: a multi-buy + instant-discount receipt reconciles within tolerance', async () => {
    const receipt = loadFixture('clean-multibuy');

    const recon = reconcile(receipt, 2);
    expect(recon.ok).toBe(true);
    expect(Math.abs(recon.deltaCents)).toBeLessThanOrEqual(2);
    expect(recon.deltaCents).not.toBe(0); // a real (sub-tolerance) rounding gap

    const out = await processReceipt(image, depsFor(receipt));
    expect(out.status).toBe('ok');
    expect(out.receipt.needsReview).toBe(false);
  });
});

describe('recorded fixtures — a corrupted fixture flags needs_review (FR-15)', () => {
  it('corrupted-total: a wrong printed total fails reconciliation and flags the receipt', async () => {
    const receipt = loadFixture('corrupted-total');

    const recon = reconcile(receipt, 2);
    expect(recon.ok).toBe(false);
    expect(Math.abs(recon.deltaCents)).toBeGreaterThan(2);

    const out = await processReceipt(image, depsFor(receipt));
    expect(out.status).toBe('needs_review');
    expect(out.receipt.needsReview).toBe(true);
    // Items themselves are high-confidence — only the arithmetic mismatch flags it.
    expect(out.items.every((i) => i.needsReview === false)).toBe(true);
  });
});
