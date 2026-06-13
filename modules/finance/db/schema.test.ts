import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type FinanceDb } from './client';

// Redirect this file's throwaway libSQL DBs into a dedicated temp dir. Vitest
// runs test files in parallel; createTestDb() names its temp DBs with a shared
// prefix under the OS tmpdir, and a sibling file's leak-detection test counts
// those files in the shared dir. Isolating TMPDIR here keeps this file's DBs
// out of that shared directory so the two files don't race. createTestDb()'s
// cleanup() removes each DB by absolute path, so this override is transparent.
process.env.TMPDIR = mkdtempSync(join(tmpdir(), 'clarity-schema-test-'));
import {
  REFUND_DESTINATIONS,
  accounts,
  households,
  orderItems,
  orders,
  storeCreditBalances,
  transactions,
} from './schema';

const ALL_TABLES = [
  'households',
  'accounts',
  'transactions',
  'orders',
  'order_items',
  'receipts',
  'receipt_items',
  'matches',
  'categories',
  'store_credit_balances',
] as const;

let db: FinanceDb;
let cleanup: () => void;

beforeEach(async () => {
  const handle = createTestDb();
  db = handle.db;
  cleanup = handle.cleanup;
  // SQLite enforces foreign keys per-connection only when explicitly enabled.
  await db.run(sql`PRAGMA foreign_keys = ON`);
});

afterEach(() => cleanup());

async function seedHousehold(id: string = randomUUID()): Promise<string> {
  await db.insert(households).values({ id, name: 'Test Household' });
  return id;
}

async function seedAccount(householdId: string, id: string = randomUUID()): Promise<string> {
  await db.insert(accounts).values({ id, householdId, name: 'Checking', type: 'checking' });
  return id;
}

async function seedOrder(
  householdId: string,
  id: string = randomUUID(),
  externalOrderId: string = randomUUID(),
): Promise<string> {
  await db
    .insert(orders)
    .values({ id, householdId, source: 'amazon', externalOrderId, orderDate: '2026-01-01' });
  return id;
}

function txValues(accountId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    accountId,
    postedDate: '2026-01-15',
    amountCents: -1299,
    direction: 'debit' as const,
    normalizedMerchant: 'ACME',
    sourceRowHash: randomUUID(),
    dedupKey: randomUUID(),
    ...overrides,
  };
}

function orderItemValues(orderId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    orderId,
    shipmentId: 'SHIP-1',
    itemSeq: 1,
    description: 'Widget',
    quantity: 1,
    amountCents: 2500,
    sourceRowHash: randomUUID(),
    ...overrides,
  };
}

type RunResult = Awaited<ReturnType<FinanceDb['run']>>;

function firstRow(result: RunResult): RunResult['rows'][number] {
  const row = result.rows[0];
  if (row === undefined) throw new Error('expected at least one result row');
  return row;
}

describe('migration', () => {
  it('applies cleanly to a fresh DB and creates all ten tables', async () => {
    const res = await db.run(sql`SELECT name FROM sqlite_master WHERE type = 'table'`);
    const names = res.rows.map((r) => r.name as string);
    for (const table of ALL_TABLES) {
      expect(names, `expected table ${table}`).toContain(table);
    }
  });

  it('creates the load-bearing unique indexes', async () => {
    const res = await db.run(sql`SELECT name FROM sqlite_master WHERE type = 'index'`);
    const names = res.rows.map((r) => r.name as string);
    expect(names).toContain('ux_transactions_dedup');
    expect(names).toContain('ux_order_items_line');
    expect(names).toContain('ux_orders_external');
  });
});

describe('ux_transactions_dedup', () => {
  it('rejects a second transaction with the same dedup_key', async () => {
    const account = await seedAccount(await seedHousehold());
    const dedupKey = 'shared-dedup-key';
    await db.insert(transactions).values(txValues(account, { dedupKey }));
    await expect(
      db.insert(transactions).values(txValues(account, { dedupKey })),
    ).rejects.toThrow(/UNIQUE|constraint/i);
  });

  it('accepts transactions with distinct dedup_keys', async () => {
    const account = await seedAccount(await seedHousehold());
    await db.insert(transactions).values(txValues(account, { dedupKey: 'key-a' }));
    await db.insert(transactions).values(txValues(account, { dedupKey: 'key-b' }));
    const count = await db.run(sql`SELECT count(*) AS c FROM transactions`);
    expect(Number(firstRow(count).c)).toBe(2);
  });
});

describe('ux_order_items_line', () => {
  it('rejects a duplicate (order_id, shipment_id, item_seq) triple', async () => {
    const order = await seedOrder(await seedHousehold());
    await db.insert(orderItems).values(orderItemValues(order, { shipmentId: 'S1', itemSeq: 1 }));
    await expect(
      db.insert(orderItems).values(orderItemValues(order, { shipmentId: 'S1', itemSeq: 1 })),
    ).rejects.toThrow(/UNIQUE|constraint/i);
  });

  it('accepts rows that differ in item_seq or shipment_id', async () => {
    const order = await seedOrder(await seedHousehold());
    await db.insert(orderItems).values(orderItemValues(order, { shipmentId: 'S1', itemSeq: 1 }));
    await db.insert(orderItems).values(orderItemValues(order, { shipmentId: 'S1', itemSeq: 2 }));
    await db.insert(orderItems).values(orderItemValues(order, { shipmentId: 'S2', itemSeq: 1 }));
    const count = await db.run(sql`SELECT count(*) AS c FROM order_items`);
    expect(Number(firstRow(count).c)).toBe(3);
  });
});

describe('returns modeled as in-table signed line items', () => {
  it('accepts negative amounts with each refund_destination, and NULL on purchases', async () => {
    const order = await seedOrder(await seedHousehold());
    let seq = 0;

    // A purchase: positive amount, no refund destination.
    await db.insert(orderItems).values(
      orderItemValues(order, {
        itemSeq: seq++,
        amountCents: 2500,
        isReturn: false,
        refundDestination: null,
      }),
    );

    // A return line per refund_destination, each carrying a negative amount.
    for (const destination of REFUND_DESTINATIONS) {
      await db.insert(orderItems).values(
        orderItemValues(order, {
          itemSeq: seq++,
          amountCents: -2500,
          isReturn: true,
          refundDestination: destination,
        }),
      );
    }

    const rows = await db.run(
      sql`SELECT amount_cents, refund_destination FROM order_items ORDER BY item_seq`,
    );
    const negatives = rows.rows.filter((r) => Number(r.amount_cents) < 0);
    expect(negatives.length).toBe(REFUND_DESTINATIONS.length);

    const stored = rows.rows.map((r) => r.refund_destination);
    for (const destination of REFUND_DESTINATIONS) {
      expect(stored).toContain(destination);
    }
    expect(stored).toContain(null);
  });
});

describe('store_credit_balances', () => {
  it('accepts a positive accrual row with kind and order_item_id FK set', async () => {
    const order = await seedOrder(await seedHousehold());
    const household = firstRow(
      await db.run(sql`SELECT household_id AS h FROM orders WHERE id = ${order}`),
    ).h as string;
    const itemId = randomUUID();
    await db.insert(orderItems).values(
      orderItemValues(order, {
        id: itemId,
        amountCents: -2500,
        isReturn: true,
        refundDestination: 'store_credit',
      }),
    );

    await db.insert(storeCreditBalances).values({
      id: randomUUID(),
      householdId: household,
      orderItemId: itemId,
      kind: 'store_credit',
      amountCents: 2500,
    });

    const rows = await db.run(
      sql`SELECT amount_cents, kind, order_item_id FROM store_credit_balances`,
    );
    expect(rows.rows.length).toBe(1);
    const ledger = firstRow(rows);
    expect(Number(ledger.amount_cents)).toBe(2500);
    expect(ledger.kind).toBe('store_credit');
    expect(ledger.order_item_id).toBe(itemId);
  });
});

describe('money columns are signed integer cents (ADR-001)', () => {
  it('round-trips a signed integer with integer storage class', async () => {
    const account = await seedAccount(await seedHousehold());
    const id = randomUUID();
    await db.insert(transactions).values(txValues(account, { id, amountCents: -123456 }));
    const row = firstRow(
      await db.run(
        sql`SELECT amount_cents AS v, typeof(amount_cents) AS t FROM transactions WHERE id = ${id}`,
      ),
    );
    expect(row.v).toBe(-123456);
    expect(row.t).toBe('integer');
  });

  it('declares money columns with INTEGER affinity', async () => {
    const txInfo = await db.run(sql`PRAGMA table_info(transactions)`);
    const txAmount = txInfo.rows.find((r) => r.name === 'amount_cents');
    expect(String(txAmount?.type).toLowerCase()).toBe('integer');

    const itemInfo = await db.run(sql`PRAGMA table_info(order_items)`);
    const itemAmount = itemInfo.rows.find((r) => r.name === 'amount_cents');
    expect(String(itemAmount?.type).toLowerCase()).toBe('integer');
  });
});

describe('multi-household (NFR-5: schema permits, no feature gates it)', () => {
  it('permits more than one household', async () => {
    await seedHousehold();
    await seedHousehold();
    const count = await db.run(sql`SELECT count(*) AS c FROM households`);
    expect(Number(firstRow(count).c)).toBe(2);
  });
});

describe('foreign-key integrity', () => {
  it('rejects an account referencing a missing household', async () => {
    await expect(
      db.insert(accounts).values({ id: randomUUID(), householdId: 'missing', name: 'Orphan' }),
    ).rejects.toThrow(/FOREIGN KEY|constraint/i);
  });

  it('rejects a transaction referencing a missing account', async () => {
    await expect(
      db.insert(transactions).values(txValues('missing-account')),
    ).rejects.toThrow(/FOREIGN KEY|constraint/i);
  });

  it('rejects an order item referencing a missing order', async () => {
    await expect(
      db.insert(orderItems).values(orderItemValues('missing-order')),
    ).rejects.toThrow(/FOREIGN KEY|constraint/i);
  });
});
