import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Isolate this file's throwaway DBs (mirrors the other integration tests).
process.env.TMPDIR = mkdtempSync(join(tmpdir(), 'clarity-seed-test-'));

import { createTestDb, type FinanceDb } from '../db/client';
import { DEFAULT_CATEGORIES, accounts, categories, households } from '../db/schema';
import { DEMO_ACCOUNT_ID, DEMO_HOUSEHOLD_ID, seed } from './seed';

let db: FinanceDb;
let cleanup: () => void;

beforeEach(async () => {
  const handle = createTestDb();
  db = handle.db;
  cleanup = handle.cleanup;
  await db.run(sql`PRAGMA foreign_keys = ON`);
});

afterEach(() => cleanup());

async function count(table: string): Promise<number> {
  const r = await db.run(sql.raw(`SELECT count(*) AS c FROM ${table}`));
  return Number(r.rows[0]?.c);
}

describe('seed', () => {
  it('creates exactly one synthetic demo household with a linked account (NFR-5)', async () => {
    await seed(db);

    const hh = await db.select().from(households);
    expect(hh).toHaveLength(1);
    expect(hh[0]?.id).toBe(DEMO_HOUSEHOLD_ID);

    const acct = await db.select().from(accounts).where(eq(accounts.householdId, DEMO_HOUSEHOLD_ID));
    expect(acct).toHaveLength(1);
    expect(acct[0]?.id).toBe(DEMO_ACCOUNT_ID);
  });

  it('populates the default category taxonomy', async () => {
    await seed(db);
    expect(await count('categories')).toBe(DEFAULT_CATEGORIES.length);
  });

  it('is idempotent — re-running yields one household and no duplicate categories', async () => {
    await seed(db);
    await seed(db);

    expect(await count('households')).toBe(1);
    expect(await count('accounts')).toBe(1);
    expect(await count('categories')).toBe(DEFAULT_CATEGORIES.length);
    expect(await db.select().from(categories)).toHaveLength(DEFAULT_CATEGORIES.length);
  });

  it('returns the stable demo identifiers', async () => {
    const result = await seed(db);
    expect(result).toEqual({
      householdId: DEMO_HOUSEHOLD_ID,
      accountId: DEMO_ACCOUNT_ID,
      categories: DEFAULT_CATEGORIES.length,
    });
  });
});
