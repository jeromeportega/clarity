import { closeSync, existsSync, mkdtempSync, openSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { clientConfig, createDb, createTestDb, isRemoteDbUrl, resolveDbConfig, uncachedFetch } from './client';

const TEMP_DB_GLOB = /^clarity-finance-.*\.db$/;

function tmpDbFiles(): string[] {
  return readdirSync(tmpdir()).filter((name) => TEMP_DB_GLOB.test(name));
}

describe('resolveDbConfig', () => {
  it('honors an explicit url (and auth token) above everything else', () => {
    const cfg = resolveDbConfig(
      { url: 'libsql://explicit.example', authToken: 'explicit-token' },
      { TURSO_DATABASE_URL: 'libsql://env.example', TURSO_AUTH_TOKEN: 'env-token' },
    );
    expect(cfg).toEqual({ url: 'libsql://explicit.example', authToken: 'explicit-token' });
  });

  it('falls back to Turso env vars when no explicit url is given', () => {
    const cfg = resolveDbConfig(undefined, {
      TURSO_DATABASE_URL: 'libsql://env.example',
      TURSO_AUTH_TOKEN: 'env-token',
    });
    expect(cfg).toEqual({ url: 'libsql://env.example', authToken: 'env-token' });
  });

  it('uses a durable local file: DB when neither url nor env is set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clarity-data-'));
    const cfg = resolveDbConfig(undefined, { CLARITY_DATA_DIR: dir });
    expect(cfg.url).toBe(`file:${join(dir, 'finance.db')}`);
    expect(cfg.authToken).toBeUndefined();
  });

  it('falls back to a per-run temp file when the local data dir is unusable', () => {
    // Point the data dir under a path that is actually a file, so mkdir throws.
    const blocker = join(mkdtempSync(join(tmpdir(), 'clarity-blk-')), 'not-a-dir');
    closeSync(openSync(blocker, 'w'));
    const cfg = resolveDbConfig(undefined, { CLARITY_DATA_DIR: join(blocker, 'sub') });
    expect(cfg.url).toMatch(/^file:.*clarity-finance-.*\.db$/);
    expect(cfg.url).toContain(tmpdir());
  });
});

describe('createDb', () => {
  it('opens a working client from an explicit file: url (offline)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clarity-createdb-'));
    const db = createDb({ url: `file:${join(dir, 'explicit.db')}` });
    const result = await db.run(sql`select 1 as one`);
    expect(result.rows[0]).toEqual({ one: 1 });
  });
});

describe('createTestDb', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()?.();
  });

  it('returns a { db, cleanup } handle and runs a trivial query offline', async () => {
    const { db, cleanup } = createTestDb();
    cleanups.push(cleanup);
    const result = await db.run(sql`select 1 as one`);
    expect(result.rows[0]).toEqual({ one: 1 });
  });

  it('builds a fresh, isolated schema per call (two handles never share state)', async () => {
    const a = createTestDb();
    const b = createTestDb();
    cleanups.push(a.cleanup, b.cleanup);

    await a.db.run(sql`create table probe (id integer primary key)`);
    await a.db.run(sql`insert into probe (id) values (1)`);

    const aSees = await a.db.run(
      sql`select count(*) as c from sqlite_master where type = 'table' and name = 'probe'`,
    );
    const bSees = await b.db.run(
      sql`select count(*) as c from sqlite_master where type = 'table' and name = 'probe'`,
    );
    expect(aSees.rows[0]).toEqual({ c: 1 });
    expect(bSees.rows[0]).toEqual({ c: 0 });
  });

  it('cleanup() removes the temp file with no leak', async () => {
    // Assert on THIS db's own file (isolation-safe) rather than counting all
    // clarity-finance-*.db files in the shared tmpdir, which races other test
    // files using createTestDb() under vitest's parallel execution.
    const { db, cleanup, file } = createTestDb();
    await db.run(sql`select 1`);
    expect(existsSync(file)).toBe(true);

    cleanup();
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      expect(existsSync(`${file}${suffix}`)).toBe(false);
    }
  });
});

describe('uncachedFetch — database traffic never enters a framework fetch cache', () => {
  it('forwards the request to the base fetch with cache: no-store, keeping the rest of the init', async () => {
    const calls: Array<[unknown, RequestInit | undefined]> = [];
    const base = (async (input: unknown, init?: RequestInit) => {
      calls.push([input, init]);
      return new Response('ok');
    }) as unknown as typeof fetch;
    const f = uncachedFetch(base);
    await f('https://db.example/v2/pipeline', { method: 'POST', body: '{"sql":"select 1"}', headers: { a: 'b' } });
    await f('https://db.example/v2/pipeline');
    expect(calls).toHaveLength(2);
    expect(calls[0]![1]).toMatchObject({ method: 'POST', body: '{"sql":"select 1"}', headers: { a: 'b' }, cache: 'no-store' });
    expect(calls[1]![1]).toMatchObject({ cache: 'no-store' });
  });

  it('overrides a caller-supplied cache mode: nothing from the database may be served stale', async () => {
    let seen: RequestInit | undefined;
    const base = (async (_i: unknown, init?: RequestInit) => { seen = init; return new Response('ok'); }) as unknown as typeof fetch;
    await uncachedFetch(base)('https://db.example/', { cache: 'force-cache' });
    expect(seen?.cache).toBe('no-store');
  });
});

describe('clientConfig — the uncached fetch is wired for remote clients and nothing else', () => {
  it('a remote URL gets the token and an uncached fetch; a file or in-memory URL gets neither', async () => {
    const seen: RequestInit[] = [];
    const base = (async (_i: unknown, init?: RequestInit) => { seen.push(init ?? {}); return new Response('ok'); }) as unknown as typeof fetch;

    const remote = clientConfig('libsql://clarity-x.turso.io', 'tok', base);
    expect(remote.authToken).toBe('tok');
    expect(typeof remote.fetch).toBe('function');
    await remote.fetch!('https://clarity-x.turso.io/v2/pipeline');
    expect(seen[0]).toMatchObject({ cache: 'no-store' });

    for (const url of ['https://clarity-x.turso.io', 'wss://clarity-x.turso.io']) expect(clientConfig(url, undefined, base).fetch).toBeTypeOf('function');
    for (const url of ['file:/tmp/x.db', ':memory:', 'file::memory:']) {
      const cfg = clientConfig(url, undefined, base);
      expect(cfg, url).toEqual({ url });
    }
  });

  it('classifies URLs by scheme, not by "anything that is not file:"', () => {
    expect(isRemoteDbUrl('libsql://h.turso.io')).toBe(true);
    expect(isRemoteDbUrl('HTTPS://h.turso.io')).toBe(true);
    expect(isRemoteDbUrl(':memory:')).toBe(false);
    expect(isRemoteDbUrl('file:data/finance.db')).toBe(false);
  });

  it('handles the shape the libSQL HTTP transport really uses — a single Request with a body, no init', async () => {
    let got: { input: unknown; init: RequestInit | undefined } | undefined;
    const base = (async (input: unknown, init?: RequestInit) => { got = { input, init }; return new Response('ok'); }) as unknown as typeof fetch;
    const req = new Request('https://h.turso.io/v2/pipeline', { method: 'POST', body: '{"requests":[]}', headers: { authorization: 'Bearer t' } });
    await uncachedFetch(base)(req);
    expect(got?.input).toBe(req);
    expect(got?.init).toEqual({ cache: 'no-store' });
    // The Request itself is untouched: method, body and headers still travel with it.
    expect(req.method).toBe('POST');
    expect(await req.text()).toBe('{"requests":[]}');
  });
});
