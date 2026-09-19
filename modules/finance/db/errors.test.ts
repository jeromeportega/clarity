import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb } from './client';
import { households } from './schema';
import { isUniqueViolation } from './errors';

// Real driver, real constraint: the shape of the error is the driver's to
// change (it did between @libsql/client 0.14 and 0.18), so this test does not
// build a fake — it makes the database refuse a duplicate and asks the helper.
describe('isUniqueViolation', () => {
  let handle: ReturnType<typeof createTestDb>;
  beforeEach(() => {
    handle = createTestDb();
  });
  afterEach(() => handle.cleanup());

  it('recognises what the installed driver throws for a duplicate primary key', async () => {
    await handle.db.insert(households).values({ id: 'hh-dup', name: 'one' });
    const err = await handle.db.insert(households).values({ id: 'hh-dup', name: 'two' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(isUniqueViolation(err)).toBe(true);
  });

  it('recognises both driver shapes and the message fallback, and nothing else', () => {
    expect(isUniqueViolation({ code: 'SQLITE_CONSTRAINT_UNIQUE', message: 'x' })).toBe(true); // ≤ 0.14
    expect(isUniqueViolation({ code: 'SQLITE_CONSTRAINT', extendedCode: 'SQLITE_CONSTRAINT_UNIQUE', message: 'x' })).toBe(true); // ≥ 0.18
    expect(isUniqueViolation(new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: review_decisions.item_id'))).toBe(true);
    expect(isUniqueViolation(new Error('wrapped', { cause: { code: 'SQLITE_CONSTRAINT_PRIMARYKEY' } }))).toBe(true);
    expect(isUniqueViolation({ code: 'SQLITE_CONSTRAINT', extendedCode: 'SQLITE_CONSTRAINT_NOTNULL', message: 'NOT NULL constraint failed' })).toBe(false);
    expect(isUniqueViolation({ code: 'SQLITE_BUSY', message: 'database is locked' })).toBe(false);
    expect(isUniqueViolation(new Error('no such table: t'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation('SQLITE_CONSTRAINT_UNIQUE')).toBe(false);
  });
});
