import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Module-level mocks (hoisted by vitest) -----------------------------------

vi.mock('./process-receipt', () => ({
  processReceipt: vi.fn(),
}));

// --- Imports after mocks are in place -----------------------------------------

import type { ProcessReceiptResult } from './process-receipt';
import { processReceipt } from './process-receipt';
import type { ReceiptItemRecord, ReceiptRecord } from './store/receipt-store';
import {
  DEFAULT_MAX_UPLOAD_BYTES,
  handleReceiptUpload,
  isAcceptedUploadMime,
} from './upload';

// --- Fixture builders ---------------------------------------------------------

function makeReceipt(overrides: Partial<ReceiptRecord> = {}): ReceiptRecord {
  return {
    id: 'receipt-1',
    householdId: 'demo-household-00000000-0000-0000-0000-000000000001',
    source: 'photo',
    store: 'COSTCO',
    purchasedAt: '2026-06-13',
    subtotalCents: 1799,
    taxCents: 224,
    totalCents: 2023,
    paymentLast4: '5454',
    imageHash: 'abc123',
    needsReview: false,
    createdAt: '2026-06-13T00:00:00.000Z',
    ...overrides,
  };
}

function makeItem(overrides: Partial<ReceiptItemRecord> = {}): ReceiptItemRecord {
  return {
    id: 'item-1',
    receiptId: 'receipt-1',
    lineNo: 1,
    sku: '0011223',
    rawDescription: 'KS AA BATTRY 48',
    canonicalName: 'Kirkland AA Batteries 48-pack',
    categoryId: 'household',
    quantity: 1,
    unitPriceCents: 1799,
    linePriceCents: 1799,
    discountCents: 0,
    nameConfidence: 0.95,
    categoryConfidence: 0.9,
    refundDestination: null,
    needsReview: false,
    createdAt: '2026-06-13T00:00:00.000Z',
    ...overrides,
  };
}

function cannedResult(items: ReceiptItemRecord[] = [makeItem()]): ProcessReceiptResult {
  return { receipt: makeReceipt(), items, status: 'ok', idempotent: false };
}

// Minimal stub for handleReceiptUpload's deps arg — the mock makes processReceipt
// never use them, so an empty object suffices.
const stubDeps = {} as Parameters<typeof handleReceiptUpload>[2];

// =============================================================================
// MIME gate — isAcceptedUploadMime
// =============================================================================

describe('isAcceptedUploadMime', () => {
  it('accepts image/jpeg', () => expect(isAcceptedUploadMime('image/jpeg')).toBe(true));
  it('accepts image/png', () => expect(isAcceptedUploadMime('image/png')).toBe(true));
  it('accepts application/pdf', () => expect(isAcceptedUploadMime('application/pdf')).toBe(true));
  it('rejects image/webp (outside vision provider support)', () => expect(isAcceptedUploadMime('image/webp')).toBe(false));
  it('rejects image/svg+xml (script-capable format)', () => expect(isAcceptedUploadMime('image/svg+xml')).toBe(false));
  it('rejects image/heic', () => expect(isAcceptedUploadMime('image/heic')).toBe(false));
  it('rejects text/html', () => expect(isAcceptedUploadMime('text/html')).toBe(false));
  it('rejects application/zip', () => expect(isAcceptedUploadMime('application/zip')).toBe(false));
  it('rejects application/octet-stream', () => expect(isAcceptedUploadMime('application/octet-stream')).toBe(false));
  it('rejects empty string', () => expect(isAcceptedUploadMime('')).toBe(false));
});

// =============================================================================
// handleReceiptUpload — validation + H2 invocation
// =============================================================================

describe('handleReceiptUpload', () => {
  const mockProcess = vi.mocked(processReceipt);

  beforeEach(() => {
    mockProcess.mockReset();
    mockProcess.mockResolvedValue(cannedResult());
  });

  it('happy path: image/jpeg passes and returns pipeline result', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const outcome = await handleReceiptUpload(bytes, 'image/jpeg', stubDeps);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.items).toHaveLength(1);
    expect(outcome.result.items[0]!.rawDescription).toBe('KS AA BATTRY 48');
  });

  it('invokes H2 pipeline (processReceipt) with the original bytes and mimeType', async () => {
    const bytes = new Uint8Array([7, 8, 9]);
    await handleReceiptUpload(bytes, 'image/jpeg', stubDeps);
    expect(mockProcess).toHaveBeenCalledOnce();
    const [input] = mockProcess.mock.calls[0]!;
    expect(input.bytes).toEqual(bytes);
    expect(input.mimeType).toBe('image/jpeg');
  });

  it('PDF passes the MIME gate', async () => {
    const outcome = await handleReceiptUpload(new Uint8Array([5]), 'application/pdf', stubDeps);
    expect(outcome.ok).toBe(true);
    expect(mockProcess).toHaveBeenCalledOnce();
  });

  it('rejects text/html before calling processReceipt', async () => {
    const outcome = await handleReceiptUpload(new Uint8Array([1]), 'text/html', stubDeps);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe('MIME_REJECTED');
    expect(mockProcess).not.toHaveBeenCalled();
  });

  it('rejects application/zip before calling processReceipt', async () => {
    const outcome = await handleReceiptUpload(new Uint8Array([1]), 'application/zip', stubDeps);
    expect(outcome.ok).toBe(false);
    expect(mockProcess).not.toHaveBeenCalled();
  });

  it('rejects image/webp (not in vision provider support set) before calling processReceipt', async () => {
    const outcome = await handleReceiptUpload(new Uint8Array([1]), 'image/webp', stubDeps);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe('MIME_REJECTED');
    expect(mockProcess).not.toHaveBeenCalled();
  });

  it('rejects file exceeding size cap before calling processReceipt', async () => {
    const bigBytes = new Uint8Array(101);
    const outcome = await handleReceiptUpload(bigBytes, 'image/jpeg', stubDeps, {
      maxSizeBytes: 100,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe('SIZE_EXCEEDED');
    expect(mockProcess).not.toHaveBeenCalled();
  });

  it('accepts file exactly at the size cap', async () => {
    const outcome = await handleReceiptUpload(new Uint8Array(100), 'image/png', stubDeps, {
      maxSizeBytes: 100,
    });
    expect(outcome.ok).toBe(true);
    expect(mockProcess).toHaveBeenCalledOnce();
  });

  it('rejects file one byte over the size cap', async () => {
    const outcome = await handleReceiptUpload(new Uint8Array(101), 'image/png', stubDeps, {
      maxSizeBytes: 100,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe('SIZE_EXCEEDED');
    expect(mockProcess).not.toHaveBeenCalled();
  });

  it('DEFAULT_MAX_UPLOAD_BYTES is 20 MiB', () => {
    expect(DEFAULT_MAX_UPLOAD_BYTES).toBe(20 * 1024 * 1024);
  });
});
