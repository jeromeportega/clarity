import { and, eq, isNotNull, isNull, like, ne } from 'drizzle-orm';

import { createDb, type FinanceDb } from '../../db/client';
import { accounts, categories, matches, receiptItems, receipts, transactions } from '../../db/schema';
import type {
  ReconciliationGateway,
  HouseholdScope,
  Match,
  MatchStatus,
  AmbiguousMatchGroup,
  Transaction,
  SpendRollup,
} from './types';

/** DB matches.status enum → gateway MatchStatus, per the H3 read-layer contract. */
const STATUS_MAP: Record<string, MatchStatus | null> = {
  pending: 'ambiguous', // candidate awaiting resolution
  matched: 'confirmed', // auto-linked
  manual: 'confirmed', // human-confirmed
  rejected: null, // dropped from listMatches entirely
};

/** DB stores integer percentage [0,100]; the gateway exposes a [0,1] float. */
function normalizeConfidence(raw: number | null): number | null {
  return raw == null ? null : raw / 100;
}

/**
 * Convert a stored item amount to a SpendRollup netCents value.
 *
 * Schema convention (ADR-001): a purchase line is stored POSITIVE, a return line
 * NEGATIVE. SpendRollup.netCents uses the opposite spend convention (negative =
 * money out), matching the stub gateway (e.g. electronics -4999). So a +4999
 * purchase contributes -4999 to the rollup, and a -X return contributes +X
 * (value returning nets the category back up).
 */
function spendSign(amountCents: number): number {
  return -amountCents;
}

/**
 * Live, DB-backed reconciliation gateway. All reads are scoped to the household
 * in `scope` and resolved through Drizzle against the env-configured DB
 * (`createDb()`), consistent with the rest of the server read path.
 *
 * Status mapping (matches.status → MatchStatus):
 *   pending  → 'ambiguous'   matched → 'confirmed'
 *   manual   → 'confirmed'   rejected → dropped from listMatches
 * Confidence: DB integer pct [0,100] → /100 → [0,1] float.
 *
 * Rollups are computed on read from categorized receipt line items, so
 * corrections (re-categorisations) are reflected without a materialized table;
 * recomputeRollups is therefore a no-op.
 */
export class LiveReconciliationGateway implements ReconciliationGateway {
  private readonly db: FinanceDb;

  constructor(db?: FinanceDb) {
    this.db = db ?? createDb();
  }

  async listMatches(scope: HouseholdScope): Promise<Match[]> {
    const rows = await this.db
      .select({
        id: matches.id,
        transactionId: matches.transactionId,
        orderItemId: matches.orderItemId,
        receiptItemId: matches.receiptItemId,
        status: matches.status,
        confidence: matches.confidence,
        method: matches.method,
      })
      .from(matches)
      .innerJoin(transactions, eq(matches.transactionId, transactions.id))
      .innerJoin(accounts, eq(transactions.accountId, accounts.id))
      .where(and(eq(accounts.householdId, scope.householdId), ne(matches.status, 'rejected')));

    const out: Match[] = [];
    for (const row of rows) {
      const status = STATUS_MAP[row.status];
      if (status == null) continue; // rejected (defensive — also filtered in SQL)
      out.push({
        id: row.id,
        transactionId: row.transactionId,
        orderItemId: row.orderItemId,
        receiptItemId: row.receiptItemId,
        status,
        confidence: normalizeConfidence(row.confidence),
        method: row.method,
      });
    }
    return out;
  }

  async getAmbiguousMatchGroups(scope: HouseholdScope): Promise<AmbiguousMatchGroup[]> {
    const all = await this.listMatches(scope);
    const map = new Map<string, Match[]>();
    for (const m of all) {
      if (m.status !== 'ambiguous') continue;
      const list = map.get(m.transactionId) ?? [];
      list.push(m);
      map.set(m.transactionId, list);
    }
    return [...map.entries()].map(([transactionId, candidates]) => ({ transactionId, candidates }));
  }

  async listUnmatchedTransactions(scope: HouseholdScope): Promise<Transaction[]> {
    // Transactions in this household with no match row at all (left join → null).
    const rows = await this.db
      .select({
        id: transactions.id,
        accountId: transactions.accountId,
        postedDate: transactions.postedDate,
        amountCents: transactions.amountCents,
        direction: transactions.direction,
        normalizedMerchant: transactions.normalizedMerchant,
      })
      .from(transactions)
      .innerJoin(accounts, eq(transactions.accountId, accounts.id))
      .leftJoin(matches, eq(matches.transactionId, transactions.id))
      .where(and(eq(accounts.householdId, scope.householdId), isNull(matches.id)));

    return rows.map((row) => ({
      id: row.id,
      householdId: scope.householdId,
      accountId: row.accountId,
      postedDate: row.postedDate,
      amountCents: row.amountCents,
      direction: row.direction,
      normalizedMerchant: row.normalizedMerchant,
    }));
  }

  async getRollups(scope: HouseholdScope, opts?: { month?: string }): Promise<SpendRollup[]> {
    const month = opts?.month;
    const monthLike = month ? `${month}-%` : undefined;

    // Net spend per (category, month) is summed from categorized receipt line
    // items — the single authoritative source of categorized spend. Counting
    // exclusively here (NOT also over the transaction/order joins used for
    // drill-down) keeps each dollar counted exactly once: a receipt line and the
    // bank line it was matched to are the SAME spend, not two.
    const buckets = new Map<string, SpendRollup>();
    const add = (category: string, ym: string, cents: number): void => {
      const key = `${category} ${ym}`;
      const existing = buckets.get(key);
      if (existing) existing.netCents += cents;
      else
        buckets.set(key, {
          key: { householdId: scope.householdId, category, month: ym },
          netCents: cents,
        });
    };

    const conds = [eq(receipts.householdId, scope.householdId), isNotNull(receiptItems.categoryId)];
    if (monthLike) conds.push(like(receipts.purchasedAt, monthLike));
    const rows = await this.db
      .select({
        amountCents: receiptItems.linePriceCents,
        purchasedAt: receipts.purchasedAt,
        category: categories.name,
      })
      .from(receiptItems)
      .innerJoin(receipts, eq(receiptItems.receiptId, receipts.id))
      .innerJoin(categories, eq(receiptItems.categoryId, categories.id))
      .where(and(...conds));
    for (const r of rows) add(r.category, r.purchasedAt.slice(0, 7), spendSign(r.amountCents));

    return [...buckets.values()].sort(
      (a, b) =>
        a.key.month.localeCompare(b.key.month) || a.key.category.localeCompare(b.key.category),
    );
  }

  /**
   * Rollups are computed on read (see getRollups), so a re-categorisation is
   * reflected immediately by the next getRollups call — there is no materialized
   * rollup table to refresh. Scope is validated so callers see a stable contract.
   */
  async recomputeRollups(scope: HouseholdScope, affectedTransactionIds: string[]): Promise<void> {
    if (!scope.householdId) return;
    // Touching affected transactions would invalidate a cache if one existed;
    // none does — reads are live. Intentionally a no-op.
    void affectedTransactionIds;
  }
}
