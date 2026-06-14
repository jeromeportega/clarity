// Route integration tests for POST /api/receipts/upload.
//
// Lives in tests/ (not modules/) so the framework-isolation guard in
// modules/finance/core/receipts does not flag the Next.js route import.
// Pattern mirrors tests/receipts-component.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Module-level mocks (hoisted by vitest) -----------------------------------

vi.mock('../modules/finance/core/receipts/process-receipt', () => ({
  processReceipt: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

// --- Imports after mocks are in place -----------------------------------------

import { mkdir, writeFile } from 'node:fs/promises';
import { processReceipt } from '../modules/finance/core/receipts/process-receipt';
import type { ProcessReceiptResult } from '../modules/finance/core/receipts/process-receipt';
import type { ReceiptItemRecord, ReceiptRecord } from '../modules/finance/core/receipts/store/receipt-store';
import { DEFAULT_MAX_UPLOAD_BYTES } from '../modules/finance/core/receipts/upload';
import { POST } from '../apps/web/app/api/receipts/upload/route';

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

// Build a multipart Request with a File attachment.
function makeRequest(
  bytes: Uint8Array,
  mimeType: string,
  token?: string,
  filename = 'receipt.jpg',
): Request {
  const form = new FormData();
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
// POST /api/receipts/upload — route integration
// =============================================================================

describe('POST /api/receipts/upload', () => {
  const mockProcess = vi.mocked(processReceipt);
  const mockMkdir = vi.mocked(mkdir);
  const mockWriteFile = vi.mocked(writeFile);

  beforeEach(() => {
    mockProcess.mockReset();
    mockMkdir.mockReset();
    mockWriteFile.mockReset();
    mockProcess.mockResolvedValue(cannedResult());
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    process.env.RECONCILE_MUTATION_TOKEN = VALID_TOKEN;
  });

  // -- Token gate ---

  it('returns 401 when x-reconcile-token header is missing', async () => {
    const res = await POST(makeRequest(new Uint8Array([1]), 'image/jpeg'));
    expect(res.status).toBe(401);
    expect(mockProcess).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('returns 401 when x-reconcile-token is wrong', async () => {
    const res = await POST(makeRequest(new Uint8Array([1]), 'image/jpeg', 'bad-token'));
    expect(res.status).toBe(401);
    expect(mockProcess).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
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

  // -- MIME gate (runs BEFORE bytes are read into memory) ---

  it('returns 415 for text/html without calling processReceipt or storing', async () => {
    const res = await POST(makeRequest(new Uint8Array([1]), 'text/html', VALID_TOKEN));
    expect(res.status).toBe(415);
    expect(mockProcess).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('returns 415 for application/zip without calling processReceipt', async () => {
    const res = await POST(makeRequest(new Uint8Array([1]), 'application/zip', VALID_TOKEN));
    expect(res.status).toBe(415);
    expect(mockProcess).not.toHaveBeenCalled();
  });

  it('returns 415 for image/webp (outside vision provider support)', async () => {
    const res = await POST(makeRequest(new Uint8Array([1]), 'image/webp', VALID_TOKEN));
    expect(res.status).toBe(415);
    expect(mockProcess).not.toHaveBeenCalled();
  });

  // -- Filename safety (Security T4) ---

  it('stores asset with a UUID filename, never the client path-traversal name', async () => {
    await POST(
      makeRequest(new Uint8Array([1, 2, 3]), 'image/jpeg', VALID_TOKEN, '../../../etc/passwd'),
    );
    expect(mockWriteFile).toHaveBeenCalledOnce();
    const storedPath = String(mockWriteFile.mock.calls[0]![0]);
    // Client filename must never appear in the stored path
    expect(storedPath).not.toContain('../');
    expect(storedPath).not.toContain('etc');
    expect(storedPath).not.toContain('passwd');
    // Must land under receipts/ with a UUID name
    expect(storedPath).toContain('receipts');
    expect(storedPath).toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
    );
  });

  // -- Size cap (413) ---

  it('returns 413 for a file exceeding DEFAULT_MAX_UPLOAD_BYTES without calling processReceipt', async () => {
    // Allocate a buffer 1 byte over the cap so file.size triggers the route guard.
    const bigBytes = new Uint8Array(DEFAULT_MAX_UPLOAD_BYTES + 1);
    const res = await POST(makeRequest(bigBytes, 'image/jpeg', VALID_TOKEN));
    expect(res.status).toBe(413);
    expect(mockProcess).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  // -- Error handling ---

  it('returns 500 when the H2 pipeline throws', async () => {
    mockProcess.mockRejectedValueOnce(new Error('Vision provider failure'));
    const res = await POST(makeRequest(new Uint8Array([1]), 'image/jpeg', VALID_TOKEN));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Processing failed');
  });

  it('returns 500 when the filesystem write fails', async () => {
    mockWriteFile.mockRejectedValueOnce(new Error('ENOSPC'));
    const res = await POST(makeRequest(new Uint8Array([1]), 'image/jpeg', VALID_TOKEN));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Storage failed');
  });
});
