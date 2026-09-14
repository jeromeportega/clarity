/**
 * No API route may be statically prerendered.
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

const files = routeFiles(API_DIR).sort();

describe('every GET API route opts out of static prerendering', () => {
  it('finds the API routes (sanity)', () => {
    expect(files.length).toBeGreaterThanOrEqual(9);
  });

  let getRoutes = 0;
  for (const file of files) {
    const name = `/api/${relative(API_DIR, dirname(file)).split('\\').join('/')}`;
    it(`${name}: if it exports GET, it exports dynamic = 'force-dynamic'`, async () => {
      const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
      if (typeof mod.GET !== 'function') return;
      getRoutes += 1;
      expect(mod.dynamic, `${name} would be prerendered at build time`).toBe('force-dynamic');
    });
  }

  it('checked at least the three known GET routes', () => {
    expect(getRoutes).toBeGreaterThanOrEqual(3);
  });
});
