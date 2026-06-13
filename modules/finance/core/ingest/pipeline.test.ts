import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Isolate this file's throwaway DBs from the shared tmpdir so a sibling file's
// temp-file leak count cannot race with ours (mirrors db/schema.test.ts).
process.env.TMPDIR = mkdtempSync(join(tmpdir(), 'clarity-pipeline-test-'));

import { createTestDb, type FinanceDb } from '../../db/client';
import { accounts, households, orderItems, orders, storeCreditBalances, transactions } from '../../db/schema';
import type { NormalizedBatch, RawInput, SourceAdapter } from '../adapters/source-adapter';
import { importSource } from './pipeline';

let db: FinanceDb;
let cleanup: () => void;
let householdId: string;
let accountId: string;

beforeEach(async () => {
  const handle = createTestDb();
  db = handle.db;
  cleanup = handle.cleanup;
  await db.run(sql`PRAGMA foreign_keys = ON`);
  householdId = randomUUID();
  accountId = randomUUID();
  await db.insert(households).values({ id: householdId, name: 'Test Household' });
  await db.insert(accounts).values({ id: accountId, householdId, name: 'Checking', type: 'checking' });
});

afterEach(() => cleanup());

const emptyBatch = (): NormalizedBatch => ({
  transactions: [],
  orders: [],
  receipts: [],
  errors: [],
});

/** A fake adapter that supports a given kind and returns a fixed batch. */
function fakeAdapter(kind: RawInput['kind'], batch: NormalizedBatch): SourceAdapter {
  return {
    kind,
    supports: (input) => input.kind === kind,
    normalize: () => batch,
  };
}

const bankInput: RawInput = { kind: 'bank', filename: 'bank.csv', bytes: new Uint8Array() };
const ordersInput: RawInput = { kind: 'amazon', filename: 'orders.csv', bytes: new Uint8Array() };

describe('importSource — adapter selection', () => {
  it('returns a single ImportError and no inserts when no adapter supports the input', async () => {
    const result = await importSource(db, bankInput, { householdId, accountId }, [
      fakeAdapter('amazon', emptyBatch()),
    ]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.reason).toMatch(/no adapter supports/);
    expect(result.inserted).toEqual({
      transactions: 0,
      orders: 0,
      orderItems: 0,
      storeCreditRows: 0,
    });
  });

  it('propagates adapter normalization errors into the result (FR-20)', async () => {
    const batch = emptyBatch();
    batch.errors.push({ rowRef: 'line:3', reason: 'malformed amount' });
    const result = await importSource(db, bankInput, { householdId, accountId }, [
      fakeAdapter('bank', batch),
    ]);
    expect(result.errors).toEqual([{ rowRef: 'line:3', reason: 'malformed amount' }]);
  });
});

describe('importSource — transactions + idempotency (FR-19)', () => {
  function bankBatch(): NormalizedBatch {
    return {
      ...emptyBatch(),
      transactions: [
        {
          postedDate: '2026-01-15',
          amountCents: -1299,
          direction: 'debit',
          rawMerchant: 'ACME STORE #14',
          normalizedMerchant: 'ACME STORE 14',
          sourceRowHash: 'hash-a',
        },
      ],
    };
  }

  it('inserts a transaction, then skips it as a duplicate on a re-import', async () => {
    const adapters = [fakeAdapter('bank', bankBatch())];

    const first = await importSource(db, bankInput, { householdId, accountId }, adapters);
    expect(first.inserted.transactions).toBe(1);
    expect(first.skippedDuplicates).toBe(0);

    const second = await importSource(db, bankInput, { householdId, accountId }, [
      fakeAdapter('bank', bankBatch()),
    ]);
    expect(second.inserted.transactions).toBe(0);
    expect(second.skippedDuplicates).toBe(1);

    const count = await db.run(sql`SELECT count(*) AS c FROM transactions`);
    expect(Number(count.rows[0]?.c)).toBe(1);
  });

  it('records an error (and skips the row) when a transaction has no accountId', async () => {
    const result = await importSource(db, bankInput, { householdId }, [
      fakeAdapter('bank', bankBatch()),
    ]);
    expect(result.inserted.transactions).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.reason).toMatch(/accountId/);
  });
});

describe('importSource — orders, returns, and the store-credit ledger (FR-14)', () => {
  function orderBatch(refundDestination: 'store_credit' | 'card'): NormalizedBatch {
    return {
      ...emptyBatch(),
      orders: [
        {
          source: 'amazon',
          externalOrderId: 'ORD-1',
          orderDate: '2026-02-01',
          currency: 'USD',
          orderTotalCents: 2500,
          items: [
            {
              shipmentId: 'SHIP-1',
              itemSeq: 1,
              description: 'Widget',
              quantity: 1,
              unitPriceCents: 2500,
              amountCents: 2500,
              isReturn: false,
              sourceRowHash: 'item-buy',
            },
            {
              shipmentId: 'SHIP-1',
              itemSeq: 2,
              description: 'Widget (return)',
              quantity: 1,
              amountCents: -2500,
              isReturn: true,
              refundDestination,
              sourceRowHash: 'item-return',
            },
          ],
        },
      ],
    };
  }

  it('inserts the order and its items, accruing one positive ledger row for a non-card return', async () => {
    const result = await importSource(db, ordersInput, { householdId }, [
      fakeAdapter('amazon', orderBatch('store_credit')),
    ]);
    expect(result.inserted.orders).toBe(1);
    expect(result.inserted.orderItems).toBe(2);
    expect(result.inserted.storeCreditRows).toBe(1);

    const ledger = await db.run(
      sql`SELECT amount_cents AS amt, kind FROM store_credit_balances`,
    );
    expect(ledger.rows).toHaveLength(1);
    expect(Number(ledger.rows[0]?.amt)).toBe(2500); // positive accrual from a -2500 return line
    expect(ledger.rows[0]?.kind).toBe('store_credit');
  });

  it('writes NO ledger row when the return refunds to card', async () => {
    const result = await importSource(db, ordersInput, { householdId }, [
      fakeAdapter('amazon', orderBatch('card')),
    ]);
    expect(result.inserted.orderItems).toBe(2);
    expect(result.inserted.storeCreditRows).toBe(0);

    const ledger = await db.run(sql`SELECT count(*) AS c FROM store_credit_balances`);
    expect(Number(ledger.rows[0]?.c)).toBe(0);
  });

  it('is idempotent: re-importing the same order skips its items and accrues no new ledger rows', async () => {
    const adapters = () => [fakeAdapter('amazon', orderBatch('store_credit'))];

    await importSource(db, ordersInput, { householdId }, adapters());
    const second = await importSource(db, ordersInput, { householdId }, adapters());

    expect(second.inserted.orders).toBe(0);
    expect(second.inserted.orderItems).toBe(0);
    expect(second.inserted.storeCreditRows).toBe(0);
    expect(second.skippedDuplicates).toBe(2); // both line items already present

    const orderCount = await db.run(sql`SELECT count(*) AS c FROM orders`);
    const itemCount = await db.run(sql`SELECT count(*) AS c FROM order_items`);
    const ledgerCount = await db.run(sql`SELECT count(*) AS c FROM store_credit_balances`);
    expect(Number(orderCount.rows[0]?.c)).toBe(1);
    expect(Number(itemCount.rows[0]?.c)).toBe(2);
    expect(Number(ledgerCount.rows[0]?.c)).toBe(1);
  });
});
