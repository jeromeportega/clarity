import { closeSync, existsSync, mkdtempSync, openSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { createDb, createTestDb, resolveDbConfig } from './client';

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
