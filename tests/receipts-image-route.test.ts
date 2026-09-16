/**
 * GET /api/receipts/image/[receiptId] — the photographed receipt behind a
 * row, served only inside the caller's household.
 *
 * Real route handler, real throwaway libSQL DB, real local-disk image store
 * (the Blob store is chosen only when its token is configured).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The route opens its database through createDb(); hand it a fresh test DB.
const harness = vi.hoisted(() => ({ handle: null as null | { db: unknown; cleanup: () => void } }));
vi.mock('../modules/finance/db/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../modules/finance/db/client')>();
  harness.handle = actual.createTestDb();
  return { ...actual, createDb: () => harness.handle!.db };
});

import { GET } from '../apps/web/app/api/receipts/image/[receiptId]/route';
import { getImageStore } from '../apps/web/lib/image-store';
import { receiptImageKey } from '../modules/finance/core/receipts/store/image-store';
import { DEMO_HOUSEHOLD_ID } from '../modules/finance/core/scope';
import type { FinanceDb } from '../modules/finance/db/client';
import { households, receipts } from '../modules/finance/db/schema';

const OTHER = 'hh-someone-else';
let db: FinanceDb;
let imagesDir: string;

function request(receiptId: string): [Request, { params: { receiptId: string } }] {
  return [new Request(`http://localhost/api/receipts/image/${receiptId}`), { params: { receiptId } }];
}

beforeAll(async () => {
  db = harness.handle!.db as FinanceDb;
  imagesDir = mkdtempSync(join(tmpdir(), 'clarity-image-route-'));
  vi.stubEnv('CLARITY_DATA_DIR', imagesDir);
  vi.stubEnv('BLOB_READ_WRITE_TOKEN', '');
  vi.stubEnv('PUBLIC_DEMO_MODE', '1');

  await db.insert(households).values([{ id: DEMO_HOUSEHOLD_ID, name: 'Demo' }, { id: OTHER, name: 'Other' }]);
  await db.insert(receipts).values([
    { id: 'rcpt-photo', householdId: DEMO_HOUSEHOLD_ID, source: 'photo', store: 'COSTCO', purchasedAt: '2025-03-02', totalCents: 2599, imageHash: 'hash-photo' },
    { id: 'rcpt-digital', householdId: DEMO_HOUSEHOLD_ID, source: 'costco_digital', store: 'COSTCO WHSE', purchasedAt: '2025-03-03', totalCents: 1000, imageHash: 'costco:barcode' },
    { id: 'rcpt-theirs', householdId: OTHER, source: 'photo', store: 'TARGET', purchasedAt: '2025-03-04', totalCents: 500, imageHash: 'hash-theirs' },
  ]);
  const store = getImageStore();
  await store.put(receiptImageKey(DEMO_HOUSEHOLD_ID, 'hash-photo'), new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg');
  await store.put(receiptImageKey(OTHER, 'hash-theirs'), new Uint8Array([1, 2, 3]), 'image/png');
});

afterAll(() => {
  vi.unstubAllEnvs();
  harness.handle?.cleanup();
  rmSync(imagesDir, { recursive: true, force: true });
});

describe('GET /api/receipts/image/[receiptId]', () => {
  it('serves the stored image for a receipt in the caller’s household, uncacheable, with its content type', async () => {
    const res = await GET(...request('rcpt-photo'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]));
  });

  it('another household’s receipt is not found — its id reveals nothing', async () => {
    const res = await GET(...request('rcpt-theirs'));
    expect(res.status).toBe(404);
  });

  it('a receipt with no stored image (a digital import) is not found, with a plain message', async () => {
    const res = await GET(...request('rcpt-digital'));
    expect(res.status).toBe(404);
    expect(await res.text()).toMatch(/no image/i);
  });

  it('an unknown receipt is not found', async () => {
    expect((await GET(...request('rcpt-nope'))).status).toBe(404);
  });

  it('is forbidden without a read scope', async () => {
    vi.stubEnv('PUBLIC_DEMO_MODE', '0');
    try {
      expect((await GET(...request('rcpt-photo'))).status).toBe(403);
    } finally {
      vi.stubEnv('PUBLIC_DEMO_MODE', '1');
    }
  });
});
