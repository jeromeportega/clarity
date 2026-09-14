import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Isolate this file's throwaway DBs.
process.env.TMPDIR = mkdtempSync(join(tmpdir(), 'clarity-persist-receipts-'));

import { createTestDb, type FinanceDb } from '../../db/client';
import { receiptItems, receipts } from '../../db/schema';
import { COSTCO_WAREHOUSE_RECEIPTS_JSON, readFixtureBytes } from '../../fixtures';
import { DEMO_HOUSEHOLD_ID, seed } from '../../scripts/seed';
import { costcoAdapter } from '../adapters/costco/costco.adapter';
import { COSTCO_DIGITAL_SOURCE } from '../adapters/costco/parse';
import type { RawInput } from '../adapters/source-adapter';
import { importSource } from './pipeline';

/**
 * Digital receipts persist through the same `persistBatch` as every other
 * source and land in the same `receipts` / `receipt_items` tables the vision
 * pipeline writes — so the queue, true-spend, evidence and the receipt↔bank
 * matcher see them without knowing where they came from.
 */
describe('persistBatch — receipts', () => {
  let db: FinanceDb;
  let cleanup: () => void;

  const input = (): RawInput => ({
    kind: 'costco',
    filename: 'warehouse-receipts.json',
    bytes: readFixtureBytes(COSTCO_WAREHOUSE_RECEIPTS_JSON),
  });

  beforeEach(async () => {
    const handle = createTestDb();
    db = handle.db;
    cleanup = handle.cleanup;
    await db.run(sql`PRAGMA foreign_keys = ON`);
    await seed(db);
  });

  afterEach(() => cleanup());

  async function count(table: string): Promise<number> {
    const r = await db.run(sql.raw(`SELECT count(*) AS c FROM ${table}`));
    return Number(r.rows[0]?.c);
  }

  it('lands every receipt and line item, with counts in the result', async () => {
    const result = await importSource(db, input(), { householdId: DEMO_HOUSEHOLD_ID }, [costcoAdapter]);
    expect(result.errors).toEqual([]);
    expect(result.inserted.receipts).toBe(3);
    expect(result.inserted.receiptItems).toBe(6);
    expect(result.skippedDuplicates).toBe(0);
    expect(await count('receipts')).toBe(3);
    expect(await count('receipt_items')).toBe(6);
  });

  it('re-importing the same export inserts nothing and counts the duplicates', async () => {
    await importSource(db, input(), { householdId: DEMO_HOUSEHOLD_ID }, [costcoAdapter]);
    const again = await importSource(db, input(), { householdId: DEMO_HOUSEHOLD_ID }, [costcoAdapter]);
    expect(again.inserted.receipts).toBe(0);
    expect(again.inserted.receiptItems).toBe(0);
    expect(again.skippedDuplicates).toBe(3);
    expect(await count('receipts')).toBe(3);
    expect(await count('receipt_items')).toBe(6);
  });

  it('stores the receipt the way the vision pipeline would: source, store, hash in image_hash, last4, flags', async () => {
    await importSource(db, input(), { householdId: DEMO_HOUSEHOLD_ID }, [costcoAdapter]);
    const rows = await db.select().from(receipts).where(eq(receipts.householdId, DEMO_HOUSEHOLD_ID));
    const sale = rows.find((r) => r.totalCents === 10900)!;
    expect(sale.source).toBe(COSTCO_DIGITAL_SOURCE);
    expect(sale.store).toBe('COSTCO WHSE #0021');
    expect(sale.purchasedAt).toBe('2026-09-08');
    expect(sale.paymentLast4).toBe('1234');
    expect(sale.imageHash).toMatch(/^[0-9a-f]{64}$/);
    expect(sale.needsReview).toBe(false);

    const refund = rows.find((r) => r.totalCents === -1099)!;
    expect(refund.store).toBe('COSTCO WHSE #0021');
    const gas = rows.find((r) => r.store === 'COSTCO GAS #0021')!;
    expect(gas.totalCents).toBe(5677);
  });

  it('stores line items with canonical names at confidence 1, discounts folded, and review flags', async () => {
    await importSource(db, input(), { householdId: DEMO_HOUSEHOLD_ID }, [costcoAdapter]);
    const sale = (await db.select().from(receipts).where(eq(receipts.totalCents, 10900)))[0]!;
    const items = await db.select().from(receiptItems).where(eq(receiptItems.receiptId, sale.id));
    expect(items.map((i) => i.lineNo).sort()).toEqual([1, 2, 3, 4]);

    const bounty = items.find((i) => i.sku === '1919326')!;
    expect(bounty.canonicalName).toBe('Bounty Advanced Paper Towels, 12-count');
    expect(bounty.nameConfidence).toBe(1);
    expect(bounty.categoryId).toBeNull();
    expect(bounty.categoryConfidence).toBeNull();
    expect(bounty.linePriceCents).toBe(2849);
    expect(bounty.discountCents).toBe(560);
    expect(bounty.needsReview).toBe(false);

    const bushwood = items.find((i) => i.sku === '9999901')!;
    expect(bushwood.canonicalName).toBeNull();
    expect(bushwood.nameConfidence).toBeNull();
    expect(bushwood.needsReview).toBe(true);

    const refund = (await db.select().from(receipts).where(eq(receipts.totalCents, -1099)))[0]!;
    const refundItems = await db.select().from(receiptItems).where(eq(receiptItems.receiptId, refund.id));
    expect(refundItems[0]!.linePriceCents).toBe(-1099);
    expect(refundItems[0]!.refundDestination).toBe('gift_card');
  });

  it('keeps idempotency scoped to the household', async () => {
    await importSource(db, input(), { householdId: DEMO_HOUSEHOLD_ID }, [costcoAdapter]);
    // A second household with the same export gets its own rows.
    await db.run(sql`INSERT INTO households (id, name) VALUES ('hh-2', 'Other')`);
    const other = await importSource(db, input(), { householdId: 'hh-2' }, [costcoAdapter]);
    expect(other.inserted.receipts).toBe(3);
    expect(await count('receipts')).toBe(6);
  });
});
