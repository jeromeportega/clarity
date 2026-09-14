/**
 * No GET API route may be statically prerendered.
 *
 * Next 14 prerenders a route handler at build time when it reads no request
 * data (no `request`, `headers()`, `searchParams`, …). `GET /api/queue` reads
 * only `process.env` and the DB, so a production build froze the demo queue
 * until the next deploy. Every route under app/api serves live household
 * data; each GET handler must opt out explicitly with `export const dynamic =
 * 'force-dynamic'`. (Only GET can be prerendered; write-only routes are
 * exempt.) Discovered, not hand-maintained, like the mutation gate.
 */
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const API_DIR = join(repoRoot, 'apps/web/app/api');
const ROUTE_FILE = /^route\.(ts|tsx|js|jsx)$/;

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) routeFiles(full, out);
    else if (ROUTE_FILE.test(entry)) out.push(full);
  }
  return out;
}

interface DiscoveredRoute {
  name: string;
  dynamic: unknown;
}

async function discoverGetRoutes(): Promise<DiscoveredRoute[]> {
  const routes: DiscoveredRoute[] = [];
  for (const file of routeFiles(API_DIR).sort()) {
    const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    if (typeof mod.GET !== 'function') continue;
    routes.push({
      name: `/api/${relative(API_DIR, dirname(file)).split('\\').join('/')}`,
      dynamic: mod.dynamic,
    });
  }
  return routes;
}

const GET_ROUTES = await discoverGetRoutes();

describe('every GET API route opts out of static prerendering', () => {
  it('discovers at least the three known GET routes (guards against a broken walk)', () => {
    expect(GET_ROUTES.length).toBeGreaterThanOrEqual(3);
    expect(GET_ROUTES.map((r) => r.name)).toEqual(
      expect.arrayContaining(['/api/queue', '/api/true-spend', '/api/true-spend/evidence/[itemId]']),
    );
  });

  for (const route of GET_ROUTES) {
    it(`${route.name} exports dynamic = 'force-dynamic'`, () => {
      expect(route.dynamic, `${route.name} would be prerendered at build time`).toBe('force-dynamic');
    });
  }
});
