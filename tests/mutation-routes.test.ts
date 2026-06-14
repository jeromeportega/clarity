/**
 * Enumerated mutation-route token gate (FR-13, NFR-7).
 *
 * Iterates the complete mutation-route table and asserts:
 *   - Every route returns 401 with no token present.
 *   - Every route returns non-401 with a valid token present.
 *
 * Adding a new mutation route to the table without gating it will cause
 * the second assertion to fail, making the gate self-enforcing.
 *
 * Note: story-004-005 will add POST /api/receipts/upload; wire it into
 * MUTATION_ROUTES below once that story is implemented.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { POST as postConfirm } from '../apps/web/app/api/queue/[id]/confirm/route';
import { POST as postCorrect } from '../apps/web/app/api/queue/[id]/correct/route';
import { POST as postDismiss } from '../apps/web/app/api/queue/[id]/dismiss/route';

type RouteHandler = (
  req: Request,
  ctx: { params: { id: string } },
) => Promise<Response>;

const MUTATION_ROUTES: Array<{ name: string; handler: RouteHandler }> = [
  { name: 'POST /api/queue/[id]/confirm', handler: postConfirm },
  { name: 'POST /api/queue/[id]/correct', handler: postCorrect },
  { name: 'POST /api/queue/[id]/dismiss', handler: postDismiss },
  // TODO(story-004-005): add { name: 'POST /api/receipts/upload', handler: postUpload }
  // once story-004-005 ships; importing its route handler here enforces the gate.
];

const TEST_TOKEN = 'mutation-gate-test-secret-123';
const ITEM_CTX = { params: { id: 'test-item-id' } };

function makeReq(withToken: boolean): Request {
  const headers: Record<string, string> = {};
  if (withToken) {
    headers['x-reconcile-token'] = TEST_TOKEN;
  }
  return new Request('http://test/api/queue/test-item-id/action', {
    method: 'POST',
    headers,
    // No body — routes return 400 (bad request) after auth passes, which is non-401.
  });
}

beforeAll(() => {
  vi.stubEnv('RECONCILE_MUTATION_TOKEN', TEST_TOKEN);
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe('token-absent: 0 mutation routes succeed without a token', () => {
  for (const { name, handler } of MUTATION_ROUTES) {
    it(`${name} returns 401 without a token`, async () => {
      const res = await handler(makeReq(false), ITEM_CTX);
      expect(res.status, `${name} should block unauthenticated requests`).toBe(401);
    });
  }

  it('headline AC: all enumerated routes rejected (0 succeed token-absent)', async () => {
    const statuses = await Promise.all(
      MUTATION_ROUTES.map(({ handler }) => handler(makeReq(false), ITEM_CTX).then((r) => r.status)),
    );
    expect(statuses.every((s) => s === 401), '0 mutation routes succeed without a token').toBe(true);
  });
});

describe('token-present: every mutation route passes the auth gate', () => {
  for (const { name, handler } of MUTATION_ROUTES) {
    it(`${name} returns non-401 with a valid token`, async () => {
      const res = await handler(makeReq(true), ITEM_CTX);
      expect(res.status, `${name} should pass auth and reject downstream (not 401)`).not.toBe(401);
    });
  }
});
