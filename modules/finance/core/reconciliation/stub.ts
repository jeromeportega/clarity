import { DEMO_HOUSEHOLD_ID } from '../scope';
import type {
  ReconciliationGateway,
  HouseholdScope,
  Match,
  AmbiguousMatchGroup,
  Transaction,
  SpendRollup,
} from './types';

// Hard-coded seed values — no Math.random / Date.now so results are
// byte-identical across any number of repeated calls (ADR-001 drift guard).

const DEMO_MATCHES: ReadonlyArray<Match> = [
  {
    id: 'match-demo-001',
    transactionId: 'txn-demo-001',
    orderItemId: 'oi-demo-001',
    receiptItemId: null,
    status: 'confirmed',
    confidence: 0.97,
    method: 'exact_amount',
  },
  {
    id: 'match-demo-002',
    transactionId: 'txn-demo-002',
    orderItemId: null,
    receiptItemId: 'ri-demo-001',
    status: 'ambiguous',
    confidence: 0.68,
    method: 'fuzzy_merchant',
  },
  // Second candidate for txn-demo-002 — exercises Map grouping in getAmbiguousMatchGroups
  {
    id: 'match-demo-003',
    transactionId: 'txn-demo-002',
    orderItemId: 'oi-demo-002',
    receiptItemId: null,
    status: 'ambiguous',
    confidence: 0.54,
    method: 'fuzzy_merchant',
  },
];

// txn-demo-003 has no match row → surfaces via listUnmatchedTransactions
const DEMO_UNMATCHED: ReadonlyArray<Transaction> = [
  {
    id: 'txn-demo-003',
    householdId: DEMO_HOUSEHOLD_ID,
    accountId: 'acct-demo-001',
    postedDate: '2025-02-10',
    amountCents: -8750, // negative = money out (debit)
    direction: 'debit',
    normalizedMerchant: 'WHOLE FOODS',
  },
];

const DEMO_ROLLUPS: ReadonlyArray<SpendRollup> = [
  {
    key: { householdId: DEMO_HOUSEHOLD_ID, category: 'electronics', month: '2025-01' },
    netCents: -4999,
  },
  {
    key: { householdId: DEMO_HOUSEHOLD_ID, category: 'groceries', month: '2025-01' },
    netCents: -1200,
  },
  {
    key: { householdId: DEMO_HOUSEHOLD_ID, category: 'groceries', month: '2025-02' },
    netCents: -8750,
  },
];

export class StubReconciliationGateway implements ReconciliationGateway {
  async listMatches(scope: HouseholdScope): Promise<Match[]> {
    if (scope.householdId !== DEMO_HOUSEHOLD_ID) return [];
    return [...DEMO_MATCHES];
  }

  async getAmbiguousMatchGroups(scope: HouseholdScope): Promise<AmbiguousMatchGroup[]> {
    if (scope.householdId !== DEMO_HOUSEHOLD_ID) return [];
    const map = new Map<string, Match[]>();
    for (const m of DEMO_MATCHES.filter(m => m.status === 'ambiguous')) {
      map.set(m.transactionId, [...(map.get(m.transactionId) ?? []), { ...m }]);
    }
    return [...map.entries()].map(([transactionId, candidates]) => ({
      transactionId,
      candidates,
    }));
  }

  async listUnmatchedTransactions(scope: HouseholdScope): Promise<Transaction[]> {
    if (scope.householdId !== DEMO_HOUSEHOLD_ID) return [];
    return [...DEMO_UNMATCHED];
  }

  async getRollups(scope: HouseholdScope, opts?: { month?: string }): Promise<SpendRollup[]> {
    const all: SpendRollup[] =
      scope.householdId === DEMO_HOUSEHOLD_ID ? [...DEMO_ROLLUPS] : [];
    if (opts?.month !== undefined) {
      return all.filter(r => r.key.month === opts.month);
    }
    return all;
  }

  async recomputeRollups(
    scope: HouseholdScope,
    _affectedTransactionIds: string[],
  ): Promise<void> {
    if (scope.householdId !== DEMO_HOUSEHOLD_ID) return;
    // stub has no mutable state; recompute is a no-op
  }
}
