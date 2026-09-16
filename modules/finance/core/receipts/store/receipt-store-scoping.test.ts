import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyStubH1Schema, schema } from './h1-schema';
import { LibSqlReceiptStore } from './libsql-receipt-store';
import type { NewReceipt } from './receipt-store';
import { StubReceiptStore } from './stub-receipt-store';

// One receipt per (household, image hash): the idempotency lookup is scoped
// to the store's household, and a lost insert race returns the existing row.

const receipt = (householdId: string, imageHash: string): NewReceipt => ({
  householdId,
  source: 'photo',
  store: 'COSTCO',
  purchasedAt: '2026-06-13',
  subtotalCents: 100,
  taxCents: 0,
  totalCents: 100,
  paymentLast4: null,
  imageHash,
  needsReview: false,
});

describe('LibSqlReceiptStore — household scoping and conflict safety', () => {
  let client: ReturnType<typeof createClient>;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(async () => {
    client = createClient({ url: ':memory:' });
    await applyStubH1Schema(client);
    await client.execute("INSERT OR IGNORE INTO households (id, name) VALUES ('household-2', 'Two')");
    db = drizzle(client, { schema });
  });

  afterEach(() => client.close());

  it('a scoped store only finds its own household’s receipt for a shared hash', async () => {
    const one = new LibSqlReceiptStore(db, { householdId: 'household-1' });
    const two = new LibSqlReceiptStore(db, { householdId: 'household-2' });
    await one.insertReceipt(receipt('household-1', 'same-photo'));

    expect(await one.findReceiptByImageHash('same-photo')).not.toBeNull();
    expect(await two.findReceiptByImageHash('same-photo')).toBeNull();

    const theirs = await two.insertReceipt(receipt('household-2', 'same-photo'));
    expect(theirs.householdId).toBe('household-2');
    expect(await two.findReceiptByImageHash('same-photo')).not.toBeNull();
  });

  it('inserting a duplicate (household, hash) returns the existing row instead of throwing', async () => {
    const store = new LibSqlReceiptStore(db, { householdId: 'household-1' });
    const first = await store.insertReceipt(receipt('household-1', 'dup'));
    const again = await store.insertReceipt({ ...receipt('household-1', 'dup'), totalCents: 999 });
    expect(again.id).toBe(first.id);
    expect(again.totalCents).toBe(100); // the original row, untouched
    const rows = await client.execute("SELECT count(*) AS c FROM receipts WHERE image_hash = 'dup'");
    expect(Number(rows.rows[0]?.c)).toBe(1);
  });

  it('an unscoped store still finds by hash alone (legacy behaviour)', async () => {
    const store = new LibSqlReceiptStore(db);
    await store.insertReceipt(receipt('household-1', 'h'));
    expect(await store.findReceiptByImageHash('h')).not.toBeNull();
  });
});

describe('StubReceiptStore — mirrors the scoping and duplicate rules', () => {
  it('scopes lookups and returns the existing row on a duplicate', async () => {
    const one = new StubReceiptStore({ householdId: 'household-1' });
    const first = await one.insertReceipt(receipt('household-1', 'x'));
    expect((await one.insertReceipt(receipt('household-1', 'x'))).id).toBe(first.id);
    const two = new StubReceiptStore({ householdId: 'household-2' });
    expect(await two.findReceiptByImageHash('x')).toBeNull();
  });
});
