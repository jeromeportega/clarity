/**
 * POST /api/receipts/[receiptId]/reextract — the HTTP contract. The read-again
 * logic itself is exercised in tests/reextract-lib.test.ts against a real DB;
 * here it is mocked so every status mapping is checked in isolation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lib = vi.hoisted(() => ({ reextractReceipt: vi.fn() }));
vi.mock('../apps/web/lib/reextract', () => ({ reextractReceipt: lib.reextractReceipt }));
vi.mock('../modules/finance/db/client', () => ({ createDb: vi.fn(() => ({})) }));

import { POST } from '../apps/web/app/api/receipts/[receiptId]/reextract/route';
import { DEMO_HOUSEHOLD_ID } from '../modules/finance/core/scope';

const TOKEN = 'reextract-test-token';

function post(receiptId: string, withToken = true): Promise<Response> {
  const headers: Record<string, string> = withToken ? { 'x-reconcile-token': TOKEN } : {};
  return POST(new Request(`http://localhost/api/receipts/${receiptId}/reextract`, { method: 'POST', headers }), { params: { receiptId } });
}

describe('POST /api/receipts/[receiptId]/reextract', () => {
  beforeEach(() => {
    lib.reextractReceipt.mockReset();
    vi.stubEnv('RECONCILE_MUTATION_TOKEN', TOKEN);
    vi.stubEnv('PUBLIC_DEMO_MODE', '0');
    vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', '');
    vi.stubEnv('CLERK_SECRET_KEY', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('401 without a writer, before anything is read', async () => {
    const res = await post('rcpt-1', false);
    expect(res.status).toBe(401);
    expect(lib.reextractReceipt).not.toHaveBeenCalled();
  });

  it('400 for an unusable id', async () => {
    expect((await post('')).status).toBe(400);
    expect((await post('x'.repeat(129))).status).toBe(400);
    expect(lib.reextractReceipt).not.toHaveBeenCalled();
  });

  it('runs for the writer’s household and returns the reading', async () => {
    lib.reextractReceipt.mockResolvedValue({
      ok: true,
      result: { status: 'ok', receipt: { id: 'rcpt-1', store: 'COSTCO' }, items: [{ id: 'item-1' }], idempotent: false },
    });
    const res = await post('rcpt-1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', receipt: { id: 'rcpt-1', store: 'COSTCO' }, items: [{ id: 'item-1' }] });
    expect(lib.reextractReceipt).toHaveBeenCalledWith({}, DEMO_HOUSEHOLD_ID, 'rcpt-1');
  });

  it('maps the outcome codes: 404 not_found / no_image, 409 has_items, 422 unsupported_image / still_unreadable, 500 image_mismatch', async () => {
    for (const [code, status] of [
      ['not_found', 404],
      ['no_image', 404],
      ['has_items', 409],
      ['unsupported_image', 422],
      ['still_unreadable', 422],
      ['image_mismatch', 500],
    ] as const) {
      lib.reextractReceipt.mockResolvedValueOnce({ ok: false, code });
      const res = await post('rcpt-1');
      expect(res.status, code).toBe(status);
      expect(await res.json()).toEqual({ error: code });
    }
  });

  it('500 when the pipeline throws (auth to the model, the DB), never a half answer', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    lib.reextractReceipt.mockRejectedValue(new Error('gateway 401'));
    const res = await post('rcpt-1');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Processing failed' });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
