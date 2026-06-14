/**
 * Anti-stub integration test for the DB-backed reconciliation backend.
 *
 * Seeds a fresh file-based libSQL test DB via seedDemoHousehold (which runs the
 * composed reconcile() pipeline and persists via DrizzleReconcileSink), then
 * reads everything back through the LIVE gateway — proving the public-demo,
 * live-backed path serves real, item-level reconciliation data.
 *
 * Fully offline: no API key, no network, throwaway temp DB.
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type FinanceDb } from '../../db/client';
import { categories, receiptItems } from '../../db/schema';
import { LiveReconciliationGateway } from './live';
import { gatewayFor } from './gateway';
import { assembleBreakdown } from '../truespend/assemble';
import { DEMO_HOUSEHOLD_ID } from '../scope';
import type { HouseholdScope } from './types';
import {
  DEMO_RI_1_ID,
  DEMO_TXN_2_ID,
  DEMO_TXN_3_ID,
  seedDemoHousehold,
} from '../seed/demoHousehold';

const SCOPE: HouseholdScope = { householdId: DEMO_HOUSEHOLD_ID };

let db: FinanceDb;
let cleanup: () => void;
let gw: LiveReconciliationGateway;

beforeEach(async () => {
  const handle = createTestDb();
  db = handle.db;
  cleanup = handle.cleanup;
  await seedDemoHousehold(db);
  gw = new LiveReconciliationGateway(db);
});

afterEach(() => cleanup());

describe('LiveReconciliationGateway — DB-backed reconciliation', () => {
  it('listMatches surfaces the engine-persisted matches for the household', async () => {
    const matches = await gw.listMatches(SCOPE);
    expect(matches.length).toBeGreaterThan(0);

    // Every match maps to a valid gateway status and normalised [0,1] confidence.
    for (const m of matches) {
      expect(['confirmed', 'ambiguous']).toContain(m.status);
      if (m.confidence !== null) {
        expect(m.confidence).toBeGreaterThanOrEqual(0);
        expect(m.confidence).toBeLessThanOrEqual(1);
      }
      expect(typeof m.transactionId).toBe('string');
    }

    // The engine confirmed a receipt_bank link for txn-demo-002 (Best Buy).
    expect(matches.some((m) => m.transactionId === DEMO_TXN_2_ID && m.status === 'confirmed')).toBe(
      true,
    );
  });

  it('maps DB status enum: pending→ambiguous, matched/manual→confirmed, rejected dropped', async () => {
    const ambiguous = await gw.getAmbiguousMatchGroups(SCOPE);
    // txn-demo-002 has two curated pending candidates → one ambiguous group.
    const group = ambiguous.find((g) => g.transactionId === DEMO_TXN_2_ID);
    expect(group).toBeDefined();
    expect(group!.candidates.length).toBeGreaterThanOrEqual(2);
    for (const c of group!.candidates) expect(c.status).toBe('ambiguous');
  });

  it('listUnmatchedTransactions returns transactions with no match row', async () => {
    const unmatched = await gw.listUnmatchedTransactions(SCOPE);
    // txn-demo-003 (Whole Foods) has no order/receipt → never matched.
    expect(unmatched.some((t) => t.id === DEMO_TXN_3_ID)).toBe(true);
    for (const t of unmatched) {
      expect(t.householdId).toBe(DEMO_HOUSEHOLD_ID);
      expect(['debit', 'credit']).toContain(t.direction);
    }
  });

  it('getRollups returns category rollups (negative = money out)', async () => {
    const rollups = await gw.getRollups(SCOPE);
    expect(rollups.length).toBeGreaterThan(0);

    const electronics = rollups.find(
      (r) => r.key.category === 'Electronics' && r.key.month === '2025-01',
    );
    expect(electronics).toBeDefined();
    // ri-demo-001 (Wireless Headphones, 4999) classified Electronics → -4999.
    expect(electronics!.netCents).toBe(-4999);
    for (const r of rollups) {
      expect(r.key.householdId).toBe(DEMO_HOUSEHOLD_ID);
      expect(r.key.month).toMatch(/^\d{4}-\d{2}$/);
      expect(Number.isInteger(r.netCents)).toBe(true);
    }
  });

  it('assembleBreakdown returns categories WITH non-empty item-level entries', async () => {
    const breakdown = await assembleBreakdown(SCOPE, gw, db, '2025-01');
    expect(breakdown.categories.length).toBeGreaterThan(0);

    // At least one category has a non-empty item-level breakdown (the demo
    // requirement: live data, not items: []).
    const withItems = breakdown.categories.filter((c) => c.items.length > 0);
    expect(withItems.length).toBeGreaterThan(0);

    const electronics = breakdown.categories.find((c) => c.category === 'Electronics');
    expect(electronics).toBeDefined();
    expect(electronics!.items.length).toBeGreaterThan(0);
    expect(electronics!.items.some((i) => i.id === DEMO_RI_1_ID)).toBe(true);
  });

  it('gatewayFor selects the live backend even in public demo mode', async () => {
    const live = gatewayFor({ PUBLIC_DEMO_MODE: '1', RECON_BACKEND: 'live' });
    expect(live).toBeInstanceOf(LiveReconciliationGateway);
  });

  it('a correction → recomputeRollups updates a rollup', async () => {
    // Baseline: Electronics carries the headphones spend in 2025-01.
    const before = await gw.getRollups(SCOPE, { month: '2025-01' });
    const electronicsBefore = before.find((r) => r.key.category === 'Electronics');
    expect(electronicsBefore?.netCents).toBe(-4999);
    expect(before.some((r) => r.key.category === 'Groceries')).toBe(false);

    // Correction: re-categorise the headphones receipt item to Groceries.
    const groceries = await ensureCategory(db, 'Groceries');
    await db
      .update(receiptItems)
      .set({ categoryId: groceries })
      .where(eq(receiptItems.id, DEMO_RI_1_ID));

    // Signal the affected transaction so the gateway can refresh its rollups.
    await gw.recomputeRollups(SCOPE, [DEMO_TXN_2_ID]);

    // After: the spend moved out of Electronics into Groceries.
    const after = await gw.getRollups(SCOPE, { month: '2025-01' });
    expect(after.some((r) => r.key.category === 'Electronics')).toBe(false);
    const groceriesAfter = after.find((r) => r.key.category === 'Groceries');
    expect(groceriesAfter?.netCents).toBe(-4999);
  });
});

/** Resolve-or-create a category by name; returns its id. */
async function ensureCategory(db: FinanceDb, name: string): Promise<string> {
  const existing = await db
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.name, name));
  if (existing[0]) return existing[0].id;
  const id = `cat-${name.toLowerCase()}`;
  await db.insert(categories).values({ id, name }).onConflictDoNothing();
  const reread = await db
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.name, name));
  return reread[0]!.id;
}
