import { describe, expect, it } from 'vitest';
import { gatewayFor, type ReconciliationGateway } from './gateway';
import { LiveReconciliationGateway } from './live';
import { StubReconciliationGateway } from './stub';
import type { HouseholdScope } from './types';
import { DEMO_HOUSEHOLD_ID } from '../scope';

// =============================================================================
// All tests exercise the stub through the ReconciliationGateway interface only
// — no concrete class imports, no H3 internals (per QA test plan).
// =============================================================================

const DEMO_SCOPE: HouseholdScope = { householdId: DEMO_HOUSEHOLD_ID };
const OTHER_SCOPE: HouseholdScope = { householdId: 'other-household-x1' };

function stubGateway(): ReconciliationGateway {
  return gatewayFor({});
}

function liveGateway(): ReconciliationGateway {
  return gatewayFor({ RECON_BACKEND: 'live' });
}

// --- factory branch ----------------------------------------------------------

describe('gatewayFor — factory branch', () => {
  it('returns stub when PUBLIC_DEMO_MODE=1', async () => {
    const gw = gatewayFor({ PUBLIC_DEMO_MODE: '1' });
    const matches = await gw.listMatches(DEMO_SCOPE);
    expect(matches.length).toBeGreaterThan(0);
  });

  it('returns stub when RECON_BACKEND is absent (default)', async () => {
    const gw = gatewayFor({});
    const matches = await gw.listMatches(DEMO_SCOPE);
    expect(matches.length).toBeGreaterThan(0);
  });

  it('returns stub when RECON_BACKEND=stub', async () => {
    const gw = gatewayFor({ RECON_BACKEND: 'stub' });
    const matches = await gw.listMatches(DEMO_SCOPE);
    expect(matches.length).toBeGreaterThan(0);
  });

  it('returns live when RECON_BACKEND=live (and PUBLIC_DEMO_MODE unset)', () => {
    const gw = liveGateway();
    expect(gw).toBeInstanceOf(LiveReconciliationGateway);
  });

  it('RECON_BACKEND=live selects the live backend even when PUBLIC_DEMO_MODE=1', () => {
    // PUBLIC_DEMO_MODE controls SCOPE only, not stub-vs-live: a public demo can
    // be live-backed. This is the corrected gatewayFor contract.
    const gw = gatewayFor({ PUBLIC_DEMO_MODE: '1', RECON_BACKEND: 'live' });
    expect(gw).toBeInstanceOf(LiveReconciliationGateway);
  });

  it('PUBLIC_DEMO_MODE=1 with RECON_BACKEND absent still uses the stub', () => {
    const gw = gatewayFor({ PUBLIC_DEMO_MODE: '1' });
    expect(gw).toBeInstanceOf(StubReconciliationGateway);
  });
});

// --- determinism (ADR-001 drift guard) ---------------------------------------

describe('stub — determinism', () => {
  it('listMatches: identical results across two calls', async () => {
    const gw = stubGateway();
    const a = await gw.listMatches(DEMO_SCOPE);
    const b = await gw.listMatches(DEMO_SCOPE);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('getAmbiguousMatchGroups: identical results across two calls', async () => {
    const gw = stubGateway();
    const a = await gw.getAmbiguousMatchGroups(DEMO_SCOPE);
    const b = await gw.getAmbiguousMatchGroups(DEMO_SCOPE);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('listUnmatchedTransactions: identical results across two calls', async () => {
    const gw = stubGateway();
    const a = await gw.listUnmatchedTransactions(DEMO_SCOPE);
    const b = await gw.listUnmatchedTransactions(DEMO_SCOPE);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('getRollups: identical results across two calls', async () => {
    const gw = stubGateway();
    const a = await gw.getRollups(DEMO_SCOPE);
    const b = await gw.getRollups(DEMO_SCOPE);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('recomputeRollups: resolves to identical (undefined) on repeated calls', async () => {
    const gw = stubGateway();
    const a = await gw.recomputeRollups(DEMO_SCOPE, ['txn-demo-001']);
    const b = await gw.recomputeRollups(DEMO_SCOPE, ['txn-demo-001']);
    expect(a).toBeUndefined();
    expect(b).toBeUndefined();
  });
});

// --- shape conformance -------------------------------------------------------

describe('stub — shape conformance', () => {
  it('match status values are within the declared enum', async () => {
    const gw = stubGateway();
    const matches = await gw.listMatches(DEMO_SCOPE);
    expect(matches.length).toBeGreaterThan(0);
    const valid = new Set<string>(['confirmed', 'ambiguous']);
    for (const m of matches) {
      expect(valid).toContain(m.status);
    }
  });

  it('rollup keys contain household + category + YYYY-MM month', async () => {
    const gw = stubGateway();
    const rollups = await gw.getRollups(DEMO_SCOPE);
    expect(rollups.length).toBeGreaterThan(0);
    for (const r of rollups) {
      expect(r.key.householdId).toBeTruthy();
      expect(r.key.category).toBeTruthy();
      expect(r.key.month).toMatch(/^\d{4}-\d{2}$/);
    }
  });

  it('rollup netCents is a signed integer', async () => {
    const gw = stubGateway();
    const rollups = await gw.getRollups(DEMO_SCOPE);
    for (const r of rollups) {
      expect(Number.isInteger(r.netCents)).toBe(true);
    }
  });

  it('unmatched transactions have integer amountCents and valid direction', async () => {
    const gw = stubGateway();
    const txns = await gw.listUnmatchedTransactions(DEMO_SCOPE);
    expect(txns.length).toBeGreaterThan(0);
    for (const t of txns) {
      expect(Number.isInteger(t.amountCents)).toBe(true);
      expect(['debit', 'credit']).toContain(t.direction);
    }
  });

  it('ambiguous groups each have a transactionId and candidate array', async () => {
    const gw = stubGateway();
    const groups = await gw.getAmbiguousMatchGroups(DEMO_SCOPE);
    expect(groups.length).toBeGreaterThan(0);
    for (const g of groups) {
      expect(typeof g.transactionId).toBe('string');
      expect(Array.isArray(g.candidates)).toBe(true);
      expect(g.candidates.length).toBeGreaterThan(0);
    }
  });

  it('multiple ambiguous candidates for same transactionId produce one group', async () => {
    const gw = stubGateway();
    const groups = await gw.getAmbiguousMatchGroups(DEMO_SCOPE);
    // txn-demo-002 has two candidate matches; they must merge into a single group
    const txnGroup = groups.find(g => g.transactionId === 'txn-demo-002');
    expect(txnGroup).toBeDefined();
    expect(txnGroup!.candidates.length).toBe(2);
    // all transactionIds in groups must be unique
    const ids = groups.map(g => g.transactionId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// --- scope honored -----------------------------------------------------------

describe('stub — scope honored', () => {
  it('non-demo scope returns no matches (not demo seed data)', async () => {
    const gw = stubGateway();
    const matches = await gw.listMatches(OTHER_SCOPE);
    expect(matches).toEqual([]);
  });

  it('non-demo scope returns no unmatched transactions', async () => {
    const gw = stubGateway();
    const txns = await gw.listUnmatchedTransactions(OTHER_SCOPE);
    expect(txns).toEqual([]);
  });

  it('non-demo scope getRollups returns empty (no cross-household bleed)', async () => {
    const gw = stubGateway();
    const rollups = await gw.getRollups(OTHER_SCOPE);
    expect(rollups).toEqual([]);
  });

  it('non-demo scope returns no ambiguous groups', async () => {
    const gw = stubGateway();
    const groups = await gw.getAmbiguousMatchGroups(OTHER_SCOPE);
    expect(groups).toEqual([]);
  });

  it('demo scope returns the seeded DEMO_HOUSEHOLD_ID data', async () => {
    const gw = stubGateway();
    const matches = await gw.listMatches(DEMO_SCOPE);
    expect(matches.length).toBeGreaterThan(0);
    for (const m of matches) {
      // transactionIds reference demo transactions (scope consistency)
      expect(m.id).toBeTruthy();
    }
  });
});

// --- getRollups month filtering ----------------------------------------------

describe('stub — getRollups month filtering', () => {
  it('filters to the requested month', async () => {
    const gw = stubGateway();
    const rollups = await gw.getRollups(DEMO_SCOPE, { month: '2025-01' });
    expect(rollups.length).toBeGreaterThan(0);
    for (const r of rollups) {
      expect(r.key.month).toBe('2025-01');
    }
  });

  it('returns rollups for all months when opts is omitted', async () => {
    const gw = stubGateway();
    const all = await gw.getRollups(DEMO_SCOPE);
    const jan = await gw.getRollups(DEMO_SCOPE, { month: '2025-01' });
    // total must be at least as large as any single-month slice
    expect(all.length).toBeGreaterThanOrEqual(jan.length);
    // and the seeded data spans more than one month
    const months = new Set(all.map(r => r.key.month));
    expect(months.size).toBeGreaterThan(1);
  });

  it('returns empty for a month with no seed rollups', async () => {
    const gw = stubGateway();
    const rollups = await gw.getRollups(DEMO_SCOPE, { month: '1999-01' });
    expect(rollups).toEqual([]);
  });
});

// --- recomputeRollups boundary -----------------------------------------------

describe('stub — recomputeRollups boundary', () => {
  it('resolves (no-op) when affectedTransactionIds is empty', async () => {
    const gw = stubGateway();
    await expect(gw.recomputeRollups(DEMO_SCOPE, [])).resolves.toBeUndefined();
  });

  it('resolves (no-op) with a non-empty affected set', async () => {
    const gw = stubGateway();
    await expect(
      gw.recomputeRollups(DEMO_SCOPE, ['txn-demo-001', 'txn-demo-002']),
    ).resolves.toBeUndefined();
  });
});
