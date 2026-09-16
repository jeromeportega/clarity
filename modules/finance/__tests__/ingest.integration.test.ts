import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Integration test for the REAL App Router ingest routes (FR-25).
 *
 * It imports the actual `apps/web/app/api/ingest/{bank,orders}/route.ts` handlers
 * — not a fixture app — POSTs real multipart/form-data uploads, and asserts both
 * that the response is a well-formed `ImportResult` AND that rows physically
 * landed in a fresh libSQL DB. Because the routes call `createDb()`, we obtain the
 * test DB from the sanctioned `createTestDb()` harness and then point the routes'
 * `createDb()` at that very file through its documented `TURSO_DATABASE_URL` seam.
 *
 * The behavioural assertions fail if a route ever stops delegating to the core
 * engine (a stubbed handler would persist nothing, and re-import would not dedup),
 * which is the "built AND wired" guard this story exists to enforce.
 */

// Private TMPDIR so createTestDb's file lands somewhere only this file writes,
// making the "which DB file was just created" lookup race-free.
const PRIVATE_TMP = mkdtempSync(join(tmpdir(), 'clarity-ingest-itest-'));
process.env.TMPDIR = PRIVATE_TMP;

import { createTestDb, type FinanceDb } from '../db/client';
import { skuDictionary } from '../core/receipts/dictionary/schema';
import {
  AMAZON_ORDER_HISTORY_CSV,
  BANK_STATEMENT_CSV,
  COSTCO_WAREHOUSE_RECEIPTS_JSON,
  readFixtureBytes,
} from '../fixtures';
import { DEMO_ACCOUNT_ID, seed } from '../scripts/seed';
// The REAL route modules under test.
import { POST as bankPost } from '../../../apps/web/app/api/ingest/bank/route';
import { POST as costcoPost } from '../../../apps/web/app/api/ingest/costco/route';
import { POST as ordersPost } from '../../../apps/web/app/api/ingest/orders/route';

const ORIG_URL = process.env.TURSO_DATABASE_URL;
const ORIG_TOKEN = process.env.TURSO_AUTH_TOKEN;
const ORIG_MUTATION_TOKEN = process.env.RECONCILE_MUTATION_TOKEN;

// Ingest routes are mutations and share the x-reconcile-token gate.
const TEST_MUTATION_TOKEN = 'ingest-itest-mutation-token';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTE_DIR = join(HERE, '..', '..', '..', 'apps', 'web', 'app', 'api', 'ingest');
const DB_FILE_RE = /^clarity-finance-.*\.db$/;
const listDbFiles = (): string[] => readdirSync(PRIVATE_TMP).filter((f) => DB_FILE_RE.test(f));

let db: FinanceDb;
let cleanup: () => void;

beforeEach(async () => {
  delete process.env.TURSO_AUTH_TOKEN;
  process.env.RECONCILE_MUTATION_TOKEN = TEST_MUTATION_TOKEN;

  const before = new Set(listDbFiles());
  const handle = createTestDb();
  db = handle.db;
  cleanup = handle.cleanup;
  // Awaiting a query forces the file to exist and the migrations to have run.
  await db.run(sql`PRAGMA foreign_keys = ON`);

  const created = listDbFiles().filter((f) => !before.has(f));
  expect(created).toHaveLength(1);
  process.env.TURSO_DATABASE_URL = `file:${join(PRIVATE_TMP, created[0]!)}`;

  await seed(db);
});

afterEach(() => {
  delete process.env.TURSO_DATABASE_URL;
  cleanup();
});

afterAll(() => {
  if (ORIG_URL === undefined) delete process.env.TURSO_DATABASE_URL;
  else process.env.TURSO_DATABASE_URL = ORIG_URL;
  if (ORIG_TOKEN === undefined) delete process.env.TURSO_AUTH_TOKEN;
  else process.env.TURSO_AUTH_TOKEN = ORIG_TOKEN;
  if (ORIG_MUTATION_TOKEN === undefined) delete process.env.RECONCILE_MUTATION_TOKEN;
  else process.env.RECONCILE_MUTATION_TOKEN = ORIG_MUTATION_TOKEN;
  rmSync(PRIVATE_TMP, { recursive: true, force: true });
});

interface FilePart {
  bytes: Uint8Array;
  name: string;
  type: string;
}

function postRequest(
  fields: { file?: FilePart; accountId?: string },
  opts: { withToken?: boolean } = {},
): Request {
  const form = new FormData();
  if (fields.file) {
    form.append('file', new File([fields.file.bytes], fields.file.name, { type: fields.file.type }));
  }
  if (fields.accountId !== undefined) form.append('accountId', fields.accountId);
  const headers: Record<string, string> = {};
  if (opts.withToken ?? true) headers['x-reconcile-token'] = TEST_MUTATION_TOKEN;
  return new Request('http://localhost/api/ingest', { method: 'POST', headers, body: form });
}

async function count(table: string): Promise<number> {
  const r = await db.run(sql.raw(`SELECT count(*) AS c FROM ${table}`));
  return Number(r.rows[0]?.c);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function expectWellFormedImportResult(body: any): void {
  expect(body).toMatchObject({
    inserted: {
      transactions: expect.any(Number),
      orders: expect.any(Number),
      orderItems: expect.any(Number),
      storeCreditRows: expect.any(Number),
    },
    skippedDuplicates: expect.any(Number),
    errors: expect.any(Array),
  });
}

const bankFile = (): FilePart => ({
  bytes: readFixtureBytes(BANK_STATEMENT_CSV),
  name: 'sample-bank-statement.csv',
  type: 'text/csv',
});

const ordersFile = (): FilePart => ({
  bytes: readFixtureBytes(AMAZON_ORDER_HISTORY_CSV),
  name: 'Retail.OrderHistory.1.csv',
  type: 'text/csv',
});

describe('POST /api/ingest/bank (real route)', () => {
  it('imports a bank CSV and lands transactions in the fresh test DB', async () => {
    const res = await bankPost(postRequest({ file: bankFile(), accountId: DEMO_ACCOUNT_ID }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expectWellFormedImportResult(body);
    expect(body.inserted.transactions).toBe(7);
    expect(body.errors).toEqual([]);

    expect(await count('transactions')).toBe(7);
  });

  it('delegates idempotency to the core: a second identical POST inserts nothing new', async () => {
    await bankPost(postRequest({ file: bankFile(), accountId: DEMO_ACCOUNT_ID }));
    const res = await bankPost(postRequest({ file: bankFile(), accountId: DEMO_ACCOUNT_ID }));
    const body = await res.json();

    expect(body.inserted.transactions).toBe(0);
    expect(body.skippedDuplicates).toBe(7);
    expect(await count('transactions')).toBe(7);
  });

  it('returns 400 when the file part is missing', async () => {
    const res = await bankPost(postRequest({ accountId: DEMO_ACCOUNT_ID }));
    expect(res.status).toBe(400);
    expect(await count('transactions')).toBe(0);
  });

  it('returns 400 for an unknown accountId', async () => {
    const res = await bankPost(postRequest({ file: bankFile(), accountId: 'no-such-account' }));
    expect(res.status).toBe(400);
  });

  it('returns 401 without a mutation token and writes nothing', async () => {
    const res = await bankPost(
      postRequest({ file: bankFile(), accountId: DEMO_ACCOUNT_ID }, { withToken: false }),
    );
    expect(res.status).toBe(401);
    expect(await count('transactions')).toBe(0);
  });
});

describe('POST /api/ingest/orders (real route)', () => {
  it('imports an Amazon CSV, landing orders, line items, and the store-credit ledger row', async () => {
    const res = await ordersPost(postRequest({ file: ordersFile() }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expectWellFormedImportResult(body);
    expect(body.inserted.orders).toBe(2);
    expect(body.inserted.orderItems).toBe(4);
    expect(body.inserted.storeCreditRows).toBe(1);
    expect(body.errors).toEqual([]);

    expect(await count('orders')).toBe(2);
    expect(await count('order_items')).toBe(4);
    expect(await count('store_credit_balances')).toBe(1);
  });

  it('returns 400 when the file part is missing', async () => {
    const res = await ordersPost(postRequest({}));
    expect(res.status).toBe(400);
    expect(await count('orders')).toBe(0);
  });

  it('returns 401 without a mutation token and writes nothing', async () => {
    const res = await ordersPost(postRequest({ file: ordersFile() }, { withToken: false }));
    expect(res.status).toBe(401);
    expect(await count('orders')).toBe(0);
  });
});

const costcoFile = (): FilePart => ({
  bytes: readFixtureBytes(COSTCO_WAREHOUSE_RECEIPTS_JSON),
  name: 'warehouse-receipts.json',
  type: 'application/json',
});

describe('POST /api/ingest/costco (real route)', () => {
  it('imports a Costco digital-receipt export, landing receipts and line items', async () => {
    const res = await costcoPost(postRequest({ file: costcoFile() }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expectWellFormedImportResult(body);
    expect(body.inserted.receipts).toBe(3);
    expect(body.inserted.receiptItems).toBe(6);
    expect(body.errors).toEqual([]);

    expect(await count('receipts')).toBe(3);
    expect(await count('receipt_items')).toBe(6);

    // Every retailer-named, item-numbered line taught the dictionary under the
    // key the photo path looks up: (canonical store, item number).
    expect(body.dictionary).toMatchObject({ itemsSeen: expect.any(Number), keys: expect.any(Number) });
    expect(body.dictionary.keys).toBeGreaterThanOrEqual(2);
    const learned = await db.select().from(skuDictionary).where(eq(skuDictionary.skuOrAbbrev, '1919326'));
    expect(learned).toHaveLength(1);
    expect(learned[0]).toMatchObject({
      store: 'COSTCO',
      canonicalName: 'Bounty Advanced Paper Towels, 12-count',
      nameConfidence: 1,
      source: 'auto',
    });
    expect(learned[0]!.categoryConfidence).toBeLessThan(0.8);
    // ALL-CAPS echoes of the receipt text are not names Costco supplied: never learned.
    expect(await db.select().from(skuDictionary).where(eq(skuDictionary.skuOrAbbrev, '9999901'))).toEqual([]);
  });

  it('is idempotent across requests, and a re-upload that landed nothing teaches nothing', async () => {
    await costcoPost(postRequest({ file: costcoFile() }));
    const before = await count('sku_dictionary');
    const res = await costcoPost(postRequest({ file: costcoFile() }));
    const body = await res.json();
    expect(body.inserted.receipts).toBe(0);
    expect(body.skippedDuplicates).toBe(3);
    expect(body.dictionary).toEqual({ skipped: true });
    expect(await count('receipts')).toBe(3);
    expect(await count('sku_dictionary')).toBe(before);
  });

  it('returns 400 when the file part is missing', async () => {
    const res = await costcoPost(postRequest({}));
    expect(res.status).toBe(400);
    expect(await count('receipts')).toBe(0);
  });

  it('returns 401 without a mutation token and writes nothing', async () => {
    const res = await costcoPost(postRequest({ file: costcoFile() }, { withToken: false }));
    expect(res.status).toBe(401);
    expect(await count('receipts')).toBe(0);
  });
});

describe('the routes stay thin (logic lives in importSource)', () => {
  it('all ingest routes delegate to importSource and contain no persistence or parsing logic', () => {
    for (const name of ['bank', 'orders', 'costco']) {
      const src = readFileSync(join(ROUTE_DIR, name, 'route.ts'), 'utf8');
      expect(src).toMatch(/importSource\(/);
      expect(src).not.toMatch(/\.insert\(/);
      expect(src).not.toMatch(/from ['"](?:xlsx|csv-parse)/);
    }
  });
});
