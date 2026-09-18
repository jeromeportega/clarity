/**
 * Mutation-route token gate — discovered, not hand-maintained.
 *
 * Walks apps/web/app/** for every route.(ts|tsx|js|jsx), imports it, and treats
 * every exported POST / PUT / PATCH / DELETE handler as a write route. For each:
 *   - a request with no token must get 401, and
 *   - a request with a valid token must get past the gate (non-401; the
 *     bodiless probe then fails validation with 400, which is the point:
 *     any parsing or DB work that ran BEFORE the gate would also surface as
 *     a non-401 on the token-absent probe and fail the first assertion).
 *
 * Adding a write route without gating it therefore fails this suite
 * automatically. A sanity check pins the six routes known today so a broken
 * discovery walk cannot silently pass with an empty table.
 */
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

type RouteHandler = (
  req: Request,
  ctx: { params: { id: string } },
) => Promise<Response>;

const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// Walk the whole app dir, not just app/api — a route handler anywhere under
// app/ is a live endpoint in Next. Match every page extension Next accepts.
const APP_DIR = join(repoRoot, 'apps/web/app');
const ROUTE_FILE = /^route\.(ts|tsx|js|jsx)$/;

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) routeFiles(full, out);
    else if (ROUTE_FILE.test(entry)) out.push(full);
  }
  return out;
}

async function discoverWriteRoutes(): Promise<Array<{ name: string; handler: RouteHandler }>> {
  const routes: Array<{ name: string; handler: RouteHandler }> = [];
  for (const file of routeFiles(APP_DIR).sort()) {
    const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    const path = `/${relative(APP_DIR, dirname(file)).split('\\').join('/')}`;
    for (const method of WRITE_METHODS) {
      const handler = mod[method];
      if (typeof handler === 'function') routes.push({ name: `${method} ${path}`, handler: handler as RouteHandler });
    }
  }
  return routes;
}

const MUTATION_ROUTES = await discoverWriteRoutes();

const KNOWN_WRITE_ROUTES = [
  'POST /api/ingest/bank',
  'POST /api/ingest/costco',
  'POST /api/ingest/orders',
  'POST /api/queue/[id]/confirm',
  'POST /api/queue/[id]/correct',
  'POST /api/queue/[id]/dismiss',
  'POST /api/plaid/sandbox/connect',
  'POST /api/plaid/sync',
  'POST /api/receipts/[receiptId]/reextract',
  'POST /api/receipts/upload',
  'POST /api/reconcile',
];

const TEST_TOKEN = 'mutation-gate-test-secret-123';
const ITEM_CTX = { params: { id: 'test-item-id' } };

function makeReq(withToken: boolean): Request {
  const headers: Record<string, string> = {};
  if (withToken) {
    headers['x-reconcile-token'] = TEST_TOKEN;
  }
  return new Request('http://test/api/probe', {
    method: 'POST',
    headers,
    // No body — routes return 400 (bad request: unparseable JSON / multipart)
    // after auth passes, which is non-401.
  });
}

beforeAll(() => {
  vi.stubEnv('RECONCILE_MUTATION_TOKEN', TEST_TOKEN);
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe('route discovery', () => {
  it('finds every write route known today (guards against a broken walk)', () => {
    const names = MUTATION_ROUTES.map((r) => r.name).sort();
    for (const known of KNOWN_WRITE_ROUTES) expect(names).toContain(known);
  });
});

describe('token-absent: 0 mutation routes succeed without a token', () => {
  for (const { name, handler } of MUTATION_ROUTES) {
    it(`${name} returns 401 without a token`, async () => {
      const res = await handler(makeReq(false), ITEM_CTX);
      expect(res.status, `${name} should block unauthenticated requests`).toBe(401);
    });
  }

  it('headline: all discovered routes rejected (0 succeed token-absent)', async () => {
    const statuses = await Promise.all(
      MUTATION_ROUTES.map(({ handler }) => handler(makeReq(false), ITEM_CTX).then((r) => r.status)),
    );
    expect(statuses.length).toBeGreaterThanOrEqual(KNOWN_WRITE_ROUTES.length);
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
