import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Module-level mocks (hoisted by vitest) -----------------------------------

vi.mock('./process-receipt', () => ({
  processReceipt: vi.fn(),
}));

vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

// --- Imports after mocks are in place -----------------------------------------

import { mkdirSync, writeFileSync } from 'node:fs';

import type { ProcessReceiptResult } from './process-receipt';
import { processReceipt } from './process-receipt';
import type { ReceiptItemRecord, ReceiptRecord } from './store/receipt-store';
import {
  DEFAULT_MAX_UPLOAD_BYTES,
  handleReceiptUpload,
  isAcceptedUploadMime,
} from './upload';

// The route import crosses workspace roots. Vitest resolves it via the monorepo's
// node_modules hoisting; no alias config is needed.
import { POST } from '../../../../apps/web/app/api/receipts/upload/route';

// --- Fixture builders ---------------------------------------------------------

const VALID_TOKEN = 'test-token-xyz';

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

// Build a multipart Request with a File attachment. Use ArrayBuffer (not
// Uint8Array) as the BlobPart to satisfy TypeScript's File constructor types.
function makeRequest(
  bytes: Uint8Array,
  mimeType: string,
  token?: string,
  filename = 'receipt.jpg',
): Request {
  const form = new FormData();
  // Slice to a plain ArrayBuffer so the File constructor is happy (BlobPart
  // requires ArrayBuffer, not the wider ArrayBufferLike). Cast is safe: slice()
  // on a Uint8Array's buffer always returns an ArrayBuffer (never SharedArrayBuffer).
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  form.append('file', new File([buf], filename, { type: mimeType }));
  const headers: Record<string, string> = {};
  if (token !== undefined) headers['x-reconcile-token'] = token;
  return new Request('http://localhost/api/receipts/upload', {
    method: 'POST',
    headers,
    body: form,
  });
}

// =============================================================================
// MIME gate — isAcceptedUploadMime
// =============================================================================

describe('isAcceptedUploadMime', () => {
  it('accepts image/jpeg', () => expect(isAcceptedUploadMime('image/jpeg')).toBe(true));
  it('accepts image/png', () => expect(isAcceptedUploadMime('image/png')).toBe(true));
  it('accepts image/webp (broad image/* gate)', () => expect(isAcceptedUploadMime('image/webp')).toBe(true));
  it('accepts application/pdf', () => expect(isAcceptedUploadMime('application/pdf')).toBe(true));
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

// =============================================================================
// POST /api/receipts/upload — route integration
// =============================================================================

describe('POST /api/receipts/upload', () => {
  const mockProcess = vi.mocked(processReceipt);
  const mockMkdir = vi.mocked(mkdirSync);
  const mockWrite = vi.mocked(writeFileSync);

  beforeEach(() => {
    mockProcess.mockReset();
    mockMkdir.mockReset();
    mockWrite.mockReset();
    mockProcess.mockResolvedValue(cannedResult());
    process.env.RECONCILE_MUTATION_TOKEN = VALID_TOKEN;
  });

  // -- Token gate ---

  it('returns 401 when x-reconcile-token header is missing', async () => {
    const res = await POST(makeRequest(new Uint8Array([1]), 'image/jpeg'));
    expect(res.status).toBe(401);
    expect(mockProcess).not.toHaveBeenCalled();
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('returns 401 when x-reconcile-token is wrong', async () => {
    const res = await POST(makeRequest(new Uint8Array([1]), 'image/jpeg', 'bad-token'));
    expect(res.status).toBe(401);
    expect(mockProcess).not.toHaveBeenCalled();
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('returns 401 when RECONCILE_MUTATION_TOKEN env var is absent', async () => {
    delete process.env.RECONCILE_MUTATION_TOKEN;
    const res = await POST(makeRequest(new Uint8Array([1]), 'image/jpeg', VALID_TOKEN));
    expect(res.status).toBe(401);
  });

  // -- Happy path ---

  it('happy path: valid token + image/jpeg returns receipt items', async () => {
    const res = await POST(makeRequest(new Uint8Array([10, 20, 30]), 'image/jpeg', VALID_TOKEN));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: ReceiptItemRecord[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.rawDescription).toBe('KS AA BATTRY 48');
  });

  it('delegates to H2 pipeline (processReceipt) — not a re-implementation', async () => {
    const bytes = new Uint8Array([10, 20, 30]);
    await POST(makeRequest(bytes, 'image/jpeg', VALID_TOKEN));
    expect(mockProcess).toHaveBeenCalledOnce();
    const [input] = mockProcess.mock.calls[0]!;
    expect(input.bytes).toEqual(bytes);
    expect(input.mimeType).toBe('image/jpeg');
  });

  it('accepts application/pdf', async () => {
    const res = await POST(
      makeRequest(new Uint8Array([1]), 'application/pdf', VALID_TOKEN, 'receipt.pdf'),
    );
    expect(res.status).toBe(200);
    expect(mockProcess).toHaveBeenCalledOnce();
  });

  // -- MIME gate ---

  it('returns 415 for text/html without calling processReceipt or storing', async () => {
    const res = await POST(makeRequest(new Uint8Array([1]), 'text/html', VALID_TOKEN));
    expect(res.status).toBe(415);
    expect(mockProcess).not.toHaveBeenCalled();
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('returns 415 for application/zip without calling processReceipt', async () => {
    const res = await POST(makeRequest(new Uint8Array([1]), 'application/zip', VALID_TOKEN));
    expect(res.status).toBe(415);
    expect(mockProcess).not.toHaveBeenCalled();
  });

  // -- Filename safety (Security T4) ---

  it('stores asset with a UUID filename, never the client path-traversal name', async () => {
    await POST(
      makeRequest(new Uint8Array([1, 2, 3]), 'image/jpeg', VALID_TOKEN, '../../../etc/passwd'),
    );
    expect(mockWrite).toHaveBeenCalledOnce();
    const storedPath = String(mockWrite.mock.calls[0]![0]);
    // Client filename must never appear in the stored path
    expect(storedPath).not.toContain('../');
    expect(storedPath).not.toContain('etc');
    expect(storedPath).not.toContain('passwd');
    // Must land under data/receipts/ with a UUID name
    expect(storedPath).toContain('receipts');
    expect(storedPath).toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
    );
  });
});
