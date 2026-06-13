import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Isolate this file's throwaway DBs from the shared tmpdir (mirrors pipeline.test.ts).
process.env.TMPDIR = mkdtempSync(join(tmpdir(), 'clarity-amazon-test-'));

import { createTestDb, type FinanceDb } from '../../../../db/client';
import { households } from '../../../../db/schema';
import type { RawInput } from '../../source-adapter';
import { importSource } from '../../../ingest/pipeline';
import { amazonAdapter } from '../amazon.adapter';
import { FULL_CSV } from './fixtures';

let db: FinanceDb;
let cleanup: () => void;
let householdId: string;

beforeEach(async () => {
  const handle = createTestDb();
  db = handle.db;
  cleanup = handle.cleanup;
  await db.run(sql`PRAGMA foreign_keys = ON`);
  householdId = randomUUID();
  await db.insert(households).values({ id: householdId, name: 'Test Household' });
});

afterEach(() => cleanup());

function input(csv: string): RawInput {
  return {
    kind: 'amazon',
    filename: 'Retail.OrderHistory.1.csv',
    bytes: new TextEncoder().encode(csv),
  };
}

const adapters = () => [amazonAdapter];

async function count(table: string): Promise<number> {
  const res = await db.run(sql.raw(`SELECT count(*) AS c FROM ${table}`));
  return Number(res.rows[0]?.c);
}

async function orderSum(externalOrderId: string, where = ''): Promise<number> {
  const res = await db.run(
    sql.raw(
      `SELECT COALESCE(SUM(oi.amount_cents), 0) AS s
       FROM order_items oi JOIN orders o ON oi.order_id = o.id
       WHERE o.external_order_id = '${externalOrderId}' ${where}`,
    ),
  );
  return Number(res.rows[0]?.s);
}

describe('amazonAdapter → importSource → DB', () => {
  it('persists every order and per-shipment line item from the file', async () => {
    const result = await importSource(db, input(FULL_CSV), { householdId }, adapters());

    expect(result.errors).toEqual([]);
    expect(result.inserted.orders).toBe(4);
    expect(result.inserted.orderItems).toBe(10);
    expect(result.skippedDuplicates).toBe(0);

    expect(await count('orders')).toBe(4);
    expect(await count('order_items')).toBe(10);
  });

  it('accrues exactly one positive store-credit row for a gift-card refund, none for a card refund', async () => {
    await importSource(db, input(FULL_CSV), { householdId }, adapters());

    const ledger = await db.run(
      sql`SELECT amount_cents AS amt, kind FROM store_credit_balances`,
    );
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]?.kind).toBe('gift_card');
    expect(Number(ledger.rows[0]?.amt)).toBe(2400); // positive accrual from the -2400 refund line

    // Drawdown is deferred to H3: no negative ledger rows are ever written here.
    const negatives = await db.run(
      sql`SELECT count(*) AS c FROM store_credit_balances WHERE amount_cents < 0`,
    );
    expect(Number(negatives.rows[0]?.c)).toBe(0);
  });

  it('is idempotent: re-importing the same file inserts zero new order lines', async () => {
    const first = await importSource(db, input(FULL_CSV), { householdId }, adapters());
    expect(first.inserted.orderItems).toBe(10);

    const second = await importSource(db, input(FULL_CSV), { householdId }, adapters());
    expect(second.inserted.orders).toBe(0);
    expect(second.inserted.orderItems).toBe(0);
    expect(second.inserted.storeCreditRows).toBe(0);
    expect(second.skippedDuplicates).toBe(10); // every (order_id, shipment_id, item_seq) line already present

    // Totals are unchanged after the second import.
    expect(await count('orders')).toBe(4);
    expect(await count('order_items')).toBe(10);
    expect(await count('store_credit_balances')).toBe(1);
  });

  it('respects the sign convention end-to-end: the return nets the order down, and amount>0 would wrongly drop it', async () => {
    await importSource(db, input(FULL_CSV), { householdId }, adapters());

    // 333-RETURN: +3000 (mouse) +2000 (keyboard) -2000 (keyboard return) = 3000 true value.
    const trueValue = await orderSum('333-RETURN');
    expect(trueValue).toBe(3000);

    // The trap: a WHERE amount > 0 filter silently drops the -2000 return → overstates spend.
    const positiveOnly = await orderSum('333-RETURN', 'AND oi.amount_cents > 0');
    expect(positiveOnly).toBe(5000);
    expect(positiveOnly).not.toBe(trueValue);

    // The return line is really there (not lost, not double-counted).
    const returnRows = await db.run(
      sql`SELECT count(*) AS c FROM order_items oi JOIN orders o ON oi.order_id = o.id
          WHERE o.external_order_id = '333-RETURN' AND oi.amount_cents < 0`,
    );
    expect(Number(returnRows.rows[0]?.c)).toBe(1);
  });
});
