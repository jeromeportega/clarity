# H3 — Reconciliation Engine & Item-Level Classification: System Architecture

> Module: `modules/finance/core/reconcile` (+ `core/classify`, `core/rollups`, `core/insights`) · Consumes H1's libSQL schema verbatim · Pure TypeScript, zero Next/React, offline-gated.

## Architecture Philosophy

Four constraints drive every decision below. Where a decision trades something away, the ADR log names the trade.

1. **The engine is a pure function; the database is at the edges.** The reconciliation pipeline takes in-memory domain values (`ReconcileInputs`) and returns an in-memory `ReconciledLedger` — no Drizzle, no Next, no I/O in the hot path (NFR-1, NFR-2). A thin `ReconcileSource` loads H1's tables into those values; a thin `ReconcileSink` persists `matches` + store-credit drawdown rows back. The gate asserts on the returned `ReconciledLedger`, never on a database. This is the most load-bearing constraint: it is what makes the suite fast, deterministic, and offline, and it is the discipline H1 (`importSource(db, …)`) and H2 (`processReceipt(input, deps)`) already established.

2. **The bank line is the unit that gets counted; everything else explains it.** A receipt and an Amazon order matched to the same transaction contribute *item detail and rationale*, never additional dollars (FR-5). One purchase ⇒ one counted `LedgerEvent`. This single rule is the dedup invariant, and its failing test is authored first (NFR-4).

3. **Every dollar is either on the bank or on the store-credit ledger — never nowhere, never twice.** Card refunds reconcile against bank CREDIT lines; store-credit / gift-card / account-balance refunds reconcile against `store_credit_balances` and are *never* flagged unmatched (FR-7). The store-credit ledger is the explicit home for every dollar that legitimately doesn't touch the bank (FR-8). "No bank line" is a valid, explained outcome — not noise.

4. **Honesty over coverage.** Below-threshold matches route to the review queue rather than auto-linking (FR-4); every match carries machine-readable rationale + confidence (FR-3); every classification carries a one-line rationale (FR-10). The deterministic heuristic path is the only gated path; any LLM assist is optional and non-gated (NFR-5), quarantined behind a seam exactly as H2 quarantined its vision provider.

## Component Diagram

```mermaid
flowchart TD
    subgraph edges["I/O edges — the ONLY code that touches libSQL or H1 tables"]
        SRC["ReconcileSource\n• DrizzleReconcileSource (reads H1 tables)\n• FixtureReconcileSource (synthetic)"]
        SINK["ReconcileSink\n• DrizzleReconcileSink → matches + store_credit drawdown\n• InMemorySink (gate)"]
    end

    H1DB[("libSQL / Turso — H1-owned tables\ntransactions · orders/order_items\nreceipts/receipt_items · categories\nstore_credit_balances · matches")]
    H1DB -.read.-> SRC
    SINK -.write.-> H1DB

    SRC -->|ReconcileInputs| ENGINE

    subgraph core["modules/finance/core — pure TS, NO Next/React"]
        subgraph reconcile["core/reconcile"]
            ENGINE["engine.ts — reconcile(inputs, config)"]
            MATCH["match/ — receipt↔bank, amazon subset-sum,\nmerchant similarity, last-4"]
            DEDUP["dedup.ts — single-counting invariant"]
            REFUND["refunds.ts + store-credit.ts —\nsigned-negative events, ledger drawdown"]
            THRESH["thresholds.ts — named tuned constants (FR-14)"]
            MODEL["model.ts — H3 domain types"]
        end
        CLASSIFY["core/classify — taxonomy, heuristic classifier,\nrecurring detection, merchant fallback\n(LLM seam: optional, non-gated)"]
        ROLLUP["core/rollups — net spend by category×month,\napplyCorrections() (H4-aware)"]
        INSIGHT["core/insights — ≥2 flags w/ number + basis,\nsparse-history policy"]
    end

    ENGINE --> MATCH --> DEDUP --> REFUND
    ENGINE --> CLASSIFY
    ENGINE -->|ReconciledLedger| ROLLUP --> INSIGHT
    ENGINE -->|MatchRecord[] + drawdown| SINK
    ENGINE -->|below threshold| RQ["ReviewCandidate[]\n(H4 consumes; H3 only produces)"]

    REVIEW["correction fixtures\n(simulated applied H4 correction)"] -->|Correction[]| ROLLUP
```

The solid path is the production/gate flow over in-memory values. The dotted arrows are the only libSQL touches, isolated to `ReconcileSource`/`ReconcileSink`. Under `vitest run` the `FixtureReconcileSource` + `InMemorySink` are wired, so no arrow ever reaches libSQL or the network.

## Tech Stack

| Layer | Choice | Rationale |
|---|---|---|
| Language / module home | TypeScript in `modules/finance/core/{reconcile,classify,rollups,insights}` | Inherited from H1/H2; keeps the engine framework-agnostic (NFR-1). |
| Money representation | Signed integer cents (`number`) | H1 ADR-001. Reconciliation needs exact equality and summation; floats accumulate sub-cent error precisely where the tip/adjustment tolerance lives. |
| Persistence (edges only) | libSQL / Turso via Drizzle (`FinanceDb` from `db/client.ts`) | H1's decided stack; H3 reads H1 tables and writes `matches` + `store_credit_balances` drawdown rows through it. Never reached in the gate. |
| Merchant similarity | Sørensen–Dice bigram ratio (reuse H2's `similarityRatio`) | Boring, dependency-light, order-tolerant on short merchant strings; H2 already shipped it at `core/receipts`. One implementation, two callers. |
| Subset matching | In-repo bounded sum-of-subsets (no dependency) | Split-shipment resolution (FR-2) is a constrained subset-sum; a bounded DFS over a date+amount-pruned candidate pool is sufficient and exact. |
| Recurring detection | In-repo clustering on (merchant + amount ± tol + cadence) | Deterministic, offline, explainable — no ML (a stated non-goal). |
| Classification (gated) | Pure rule/keyword heuristics over H1 taxonomy | The only path the gate exercises (NFR-5). |
| Classification (optional) | Anthropic SDK behind a `Classifier` seam | Non-gated, key-gated, never collected by `vitest run`; mirrors H2's `VisionProvider` quarantine. |
| Test runner | Vitest (`vitest run`, config at repo root) | H1's runner; `include: modules/**/*.{test,spec}.ts`. Test-first for dedup + matchers (NFR-4). |
| Hashing / ids | Node `crypto`, app-generated UUID text | Consistent with H1; deterministic match ids for idempotent re-runs. |

## Data Models

H3 introduces **no new H1 tables**. It consumes H1's `transactions`, `orders`/`order_items`, `receipts`/`receipt_items`, `categories`, `store_credit_balances` verbatim, and *populates* the H1-shipped-empty `matches` table (which H1 explicitly designated "populated by H3", epic-001 FR-13). The authoritative contract is the in-memory domain model; the DB mapping follows it.

### Sign convention (read this once)

H1 stores **bank cash-flow** sign: a purchase debit is `amount_cents < 0`, a refund credit is `> 0`. H3's ledger uses a deliberately *different* **spend** sign so that a total reads naturally:

```
signedSpendCents:  purchase  →  POSITIVE   (consumption)
                   refund    →  NEGATIVE   (money/value coming back)
netSpendCents      = Σ signedSpendCents over events
```

The mapping is explicit and lives in one place (`reconcile/model.ts`): bank purchase debit (`-1234`) → spend `+1234`; card refund credit (`+1234`) → spend `-1234`. Any consumer that re-derives sign elsewhere is a bug — this is the exact "filter amount > 0 silently drops returns" trap H1 warned about, so the flip happens once, at ingestion into the engine.

### H3 domain types — `modules/finance/core/reconcile/model.ts`

```ts
import type { RefundDestination } from '../model/normalized'; // H1: 'card'|'store_credit'|'gift_card'|'account_balance'

type Cents = number; // signed integer cents

// ── Inputs (loaded by ReconcileSource from H1 tables or fixtures) ──────────
interface BankLine {            // ← transactions
  id: string; accountId: string; postedDate: string;  // ISO YYYY-MM-DD
  amountCents: Cents; direction: 'debit' | 'credit';
  normalizedMerchant: string; lastFour?: string;
}
interface OrderView {           // ← orders + order_items
  id: string; externalOrderId: string; orderDate: string; orderTotalCents?: Cents;
  items: OrderItemView[];
}
interface OrderItemView {
  id: string; shipmentId: string; description: string;
  amountCents: Cents; isReturn: boolean; refundDestination?: RefundDestination;
}
interface ReceiptView {         // ← receipts + receipt_items
  id: string; merchant?: string; capturedAt?: string; totalCents?: Cents; lastFour?: string;
  items: ReceiptItemView[];
}
interface ReceiptItemView { id: string; description?: string; amountCents: Cents; }

interface StoreCreditAccrual {  // ← store_credit_balances rows with amount > 0 (H1-written)
  id: string; kind: 'store_credit' | 'gift_card' | 'account_balance';
  amountCents: Cents; occurredAt: string; orderId?: string; orderItemId?: string;
}

interface ReconcileInputs {
  householdId: string;
  bankLines: BankLine[]; orders: OrderView[]; receipts: ReceiptView[];
  storeCreditAccruals: StoreCreditAccrual[];
}

// ── Outputs ────────────────────────────────────────────────────────────────
type MatchType =
  | 'receipt_bank' | 'order_bank' | 'order_bank_split'
  | 'refund_card' | 'store_credit_refund' | 'store_credit_drawdown' | 'dedup_merge';

interface MatchRecord {                       // → persisted into H1 `matches`
  id: string;
  type: MatchType;
  transactionId?: string; orderId?: string; orderItemId?: string;
  receiptId?: string; receiptItemId?: string;
  storeCreditBalanceId?: string;              // link to a ledger row when no bank line
  confidence: number;                         // [0,1], REAL
  rationale: string;                          // FR-3 — human/machine-readable reason
  status: 'auto_linked' | 'review';           // < THRESHOLD ⇒ 'review' (FR-4)
}

interface ClassifiedItem {
  itemRef: { receiptItemId?: string; orderItemId?: string };
  category: string;                           // ∈ H1 categories taxonomy
  rationale: string;                          // FR-10, one line
  source: 'item_heuristic' | 'recurring' | 'merchant_fallback' | 'llm';
}

interface LedgerEvent {                        // the COUNTED unit — one per real purchase/refund
  id: string;
  signedSpendCents: Cents;                    // spend sign (purchase +, refund −)
  occurredOn: string;                          // ISO date used for month rollup
  fundedBy: 'bank' | 'store_credit' | 'bank+store_credit';
  sources: { transactionId?: string; orderId?: string; receiptId?: string };
  mergedItems: ClassifiedItem[];               // detail from receipt ∪ order, counted ONCE
  categoryFallback?: string;                   // used when mergedItems is empty (merchant-level)
}

interface ReconciledLedger {
  events: LedgerEvent[];
  matches: MatchRecord[];
  reviewQueue: MatchRecord[];                  // status === 'review'; H4 consumes
  storeCreditDrawdowns: StoreCreditDrawdown[]; // → negative store_credit_balances rows
  unmatched: { bankLines: string[]; orderItems: string[]; receipts: string[] };
  netSpendCents: Cents;                        // Σ events.signedSpendCents (FR-9)
}

interface StoreCreditDrawdown {                // → store_credit_balances (negative amount)
  id: string; kind: StoreCreditAccrual['kind']; amountCents: Cents; // < 0
  occurredAt: string; reason: 'partial_payment' | 'manual'; orderId?: string;
}
```

### Rollups & insights — `core/rollups/model.ts`, `core/insights/model.ts`

```ts
interface RollupCell { category: string; month: string; /* YYYY-MM */ netSpendCents: Cents; eventIds: string[]; }
type Rollup = RollupCell[];                    // queryable by (category, month) (FR-11)

interface Correction {                          // simulates an applied H4 review-queue decision (FR-12)
  kind: 'relink_match' | 'reject_match' | 'reclassify_item';
  matchId?: string; itemRef?: ClassifiedItem['itemRef'];
  newTransactionId?: string; newCategory?: string;
}

interface InsightFlag {
  code: 'merchant_above_avg' | 'category_tracking_over' | 'new_recurring_charge';
  message: string;
  number: { observedCents: Cents; comparisonCents?: Cents; deltaPct?: number }; // FR-13: cites its number
  basis: string;                               // e.g. "3-month avg for COSTCO" | "insufficient_history"
  inconclusive?: boolean;                      // true when history < comparison window (NFR-6)
}
```

### Persistence mapping (DB shape — additive only)

`MatchRecord` → H1 `matches` (`transaction_id`, `order_id`, `order_item_id`, `receipt_id`, `receipt_item_id`, `match_type`, `confidence`, `status`). `StoreCreditDrawdown` → a **negative** `store_credit_balances` row (balance stays `SUM(amount_cents)`; H1 ADR-005). The one schema change H3 needs is a home for `rationale` (FR-3), added by an H3-owned additive migration on the H1-shipped-empty table:

```sql
-- migration 0002_h3_matches (owned by story-003-001)
ALTER TABLE matches ADD COLUMN rationale TEXT;            -- FR-3
ALTER TABLE matches ADD COLUMN store_credit_balance_id TEXT
  REFERENCES store_credit_balances(id);                  -- no-bank-line links (FR-7)
```

## API / Interface Contracts

These are the seams independent story-agents must agree on; the implementation contract (Task C) reconciles ownership. Signatures are the contract.

### The engine (the single public surface — pure, no I/O)

```ts
// core/reconcile/engine.ts
function reconcile(inputs: ReconcileInputs, config?: Partial<ReconcileConfig>): ReconciledLedger;
```

### I/O ports (the only libSQL touch; mirror H1's injected `FinanceDb`)

```ts
// core/reconcile/source.ts
interface ReconcileSource { load(householdId: string): Promise<ReconcileInputs>; }
//   DrizzleReconcileSource(db: FinanceDb)  — reads H1 tables
//   FixtureReconcileSource(fixtures)       — synthetic, used by the gate

interface ReconcileSink {                                   // demo path only; gate uses InMemorySink
  persist(householdId: string, ledger: ReconciledLedger): Promise<void>;
}
```

### Matching (story-003-002; tests authored first)

```ts
// core/reconcile/match/index.ts
function matchReceipts(bank: BankLine[], receipts: ReceiptView[], cfg: ReconcileConfig): MatchRecord[];
function matchAmazonOrders(bank: BankLine[], orders: OrderView[], cfg: ReconcileConfig): MatchRecord[];

// core/reconcile/match/subset-sum.ts — split shipments (FR-2)
function findChargeSubset(
  candidates: BankLine[], targetCents: Cents, cfg: ReconcileConfig,
): BankLine[] | null;   // bounded DFS over a date-window + amount-pruned pool; null ⇒ route to review
```

### Dedup invariant (story-003-003; test authored first)

```ts
// core/reconcile/dedup.ts
function mergeCounted(matches: MatchRecord[], inputs: ReconcileInputs): LedgerEvent[];
//   one LedgerEvent per anchored transaction; receipt+order on the same anchor ⇒ items merged, dollar counted ONCE.
```

### Refunds & store credit (story-003-004)

```ts
// core/reconcile/refunds.ts
function reconcileRefunds(inputs: ReconcileInputs, matches: MatchRecord[]): {
  events: LedgerEvent[]; drawdowns: StoreCreditDrawdown[]; matches: MatchRecord[];
};
// card refund → matched to a bank CREDIT line (signed negative spend);
// store_credit/gift_card/account_balance refund → linked to its store_credit_balances accrual, NEVER unmatched;
// partial store-credit payment (bank charge < receipt total) → negative drawdown row for the gap (FR-8).
```

### Classification (story-003-005)

```ts
// core/classify/classifier.ts
interface Classifier {                                      // heuristic impl is the gated default
  classify(q: { merchant: string; description?: string; amountCents: Cents }, taxonomy: readonly string[]): ClassifiedItem;
}
function detectRecurring(events: LedgerEvent[], cfg: ReconcileConfig): Map<string /*eventId*/, ClassifiedItem>; // FR-10
function merchantFallback(line: BankLine, taxonomy: readonly string[]): ClassifiedItem;
// An optional LlmClassifier implements the same interface; NEVER wired in the gate (NFR-5).
```

### Rollups & insights (stories 003-006, 003-007)

```ts
// core/rollups/rollup.ts
function rollupNetSpend(ledger: ReconciledLedger): Rollup;                       // category × month, NET (FR-11)
function applyCorrections(ledger: ReconciledLedger, corrections: Correction[]): ReconciledLedger; // FR-12

// core/insights/flags.ts
function deriveInsights(rollup: Rollup, ledger: ReconciledLedger, cfg: ReconcileConfig): InsightFlag[]; // ≥2 (FR-13)
```

### Tuned threshold constants (story-003-001 — FR-14)

```ts
// core/reconcile/thresholds.ts — named, documented, tuned to the fixtures; all overridable via ReconcileConfig.
interface ReconcileConfig {
  tipAdjustmentToleranceCents: number;   // default 1500  ($15 tip/adjustment band, receipt↔bank)
  merchantSimilarityCutoff: number;      // default 0.72  (Dice bigram ratio)
  receiptDateWindowDays: number;         // default 3     (receipt vs posted date)
  orderDateWindowDays: number;           // default 7     (order ship/charge lag; subset-sum window)
  subsetMaxCandidates: number;           // default 12    (caps the DFS pool — keeps subset-sum tractable)
  confidenceThreshold: number;           // default 0.70  (< ⇒ review queue, never auto-link, FR-4)
  recurringAmountToleranceCents: number; // default 200   ($2 drift allowed for "same amount")
  recurringCadenceToleranceDays: number; // default 3     (monthly cadence window)
  insightComparisonMonths: number;       // default 3     (the "3-month average" window; NFR-6 sparse policy)
}
```

## Security Model

H3 inherits H1's posture (single household, no auth, no live network ingestion). Its distinctive risks are about *correctness as a trust property* and keeping the gate clean.

| Threat | Control |
|---|---|
| Real financial data or API keys entering the gate (NFR-3) | `FixtureReconcileSource` + `InMemorySink` are the only wirings the suite uses; synthetic fixtures only; a gate-safety test fails the build on any key-shaped or PAN-shaped string in fixture JSON (FR, story-003-001 AC). The engine constructs no DB and no SDK client. |
| Silent double-counting inflating spend | Dedup invariant: the bank line is the sole counted unit; a property test asserts `netSpend === Σ counted bank events (net of refunds)` and that a receipt+order+bank case counts the dollar exactly once (FR-5). Failing test authored first. |
| Manufactured "unmatched noise" from store-credit refunds | Store-credit/gift-card/account-balance refunds are reconciled against `store_credit_balances`, never emitted to `unmatched` (FR-7); the "refund → bank shows nothing → net spend still correct" test pins it. |
| Low-confidence link silently corrupting the ledger | Anything below `confidenceThreshold` is emitted as a `review` `MatchRecord`, never `auto_linked` (FR-4). H4 is the only path that can promote it. |
| Subset-sum DoS / pathological blow-up | Candidate pool bounded by `orderDateWindowDays` + `subsetMaxCandidates`; over the bound, the order routes to review rather than brute-forcing (FR-2). |
| Prompt injection via merchant/item text (only if LLM classifier is enabled) | The gated path is pure heuristics — no model. The optional `LlmClassifier` treats all text as data, clamps any returned category to the H1 taxonomy, and is never executed in the gate (NFR-5). |
| Store-credit ledger going negative (spending credit you don't have) | Drawdowns are validated against available accrual balance per kind; an over-drawdown routes to review rather than writing an invalid negative balance. |

## ADR Log

### ADR-001 — Pure functional engine; libSQL quarantined behind `ReconcileSource`/`ReconcileSink`
**Decision:** `reconcile(inputs, config)` operates entirely on in-memory domain values and returns a `ReconciledLedger`. All H1-table reads and `matches`/store-credit writes live in two injected ports.
**Context:** NFR-1/2/3 demand a fast, deterministic, offline gate; H1 (`importSource(db,…)`) and H2 (`processReceipt(input, deps)`) set the DI precedent.
**Rationale:** The entire matching/dedup/refund/classify/rollup/insight surface becomes deterministically unit-testable against fixtures with zero I/O; the DB becomes a thin, separately-tested mapping.
**Trade-off:** A mapping layer (`DrizzleReconcileSource`) and a standing risk of source/real-schema drift; localized to one file and covered by the demo path, accepted for gate hermeticity.

### ADR-002 — The bank line is the canonical counted unit; other sources add detail, not dollars
**Decision:** When a receipt and/or order match a transaction, exactly one `LedgerEvent` is emitted carrying the transaction's amount; matched receipt/order rows contribute merged `mergedItems` and rationale only. When a purchase legitimately has *no* bank line (fully store-credit-funded), the store-credit ledger row becomes the counted anchor.
**Context:** FR-5, the headline invariant — "every dollar counted once."
**Rationale:** A single deterministic anchor rule makes the dedup invariant provable as `netSpend === Σ counted anchors` rather than an emergent property of join order.
**Trade-off:** Requires an explicit, documented anchor-selection precedence (bank > store-credit ledger > receipt total) so the "no bank line" case is unambiguous; that precedence is a constant, not a heuristic.

### ADR-003 — Amazon split shipments via a bounded sum-of-subsets, pruned by date + amount
**Decision:** One order → several charges is resolved by `findChargeSubset` — a DFS over bank candidates pre-filtered to `orderDateWindowDays` and `subsetMaxCandidates`; no match within the bound routes to review.
**Context:** FR-2; subset-sum is NP-hard in general and the candidate pool must stay tractable.
**Rationale:** Within a tight date+amount window the pool is tiny (a household, not a warehouse), so an exact bounded DFS is both correct and cheap; bounding it makes worst-case runtime a constant.
**Trade-off:** A genuine split whose charges fall outside the window or exceed the candidate cap is routed to review rather than auto-linked — the honest failure mode, consistent with FR-4.

### ADR-004 — A single named confidence threshold gates auto-linking
**Decision:** `confidenceThreshold` (default 0.70) is the one cutoff; `confidence < threshold ⇒ status:'review'`, never `auto_linked`.
**Context:** FR-4 and the *Must* H4 story — ambiguity must go to a queue, never silently corrupt the ledger.
**Rationale:** One documented constant is auditable and tunable against the fixtures; "below threshold ⇒ review" is a single, testable rule.
**Trade-off:** A global cutoff is coarse across match types; it's `ReconcileConfig`-overridable so per-type tuning is possible later without reshaping the rule.

### ADR-005 — Net true-spend is funding-source-agnostic; store credit is a parallel explaining ledger
**Decision:** A `LedgerEvent`'s `signedSpendCents` reflects the *value of goods*, regardless of whether bank cash or store credit funded it. Card and store-credit refunds are negative events; a store-credit-funded purchase portion is a positive event backed by a `store_credit_balances` drawdown. `netSpend = Σ signedSpendCents`.
**Context:** FR-7/FR-8/FR-9 — a refund-to-credit then re-spend must net correctly and never appear as noise.
**Rationale:** Refund (−X) then re-spend (+X) of that credit nets to zero new outflow, which is economically correct; the store-credit ledger (`SUM = accruals − drawdowns ≥ 0`) explains exactly which dollars bypassed the bank.
**Trade-off:** Store-credit-funded spend shows as spend in a month where no bank money moved — correct for "what did we consume," potentially surprising for "what left my bank." The chosen semantic is documented at the seam.

### ADR-006 — Persist rationale on H1's `matches` via an additive H3-owned migration
**Decision:** Add `rationale TEXT` (and `store_credit_balance_id`) to `matches` via migration `0002_h3_matches`, owned by story-003-001.
**Context:** FR-3 requires persisted rationale; H1's `matches` has no such column, but H1 explicitly designated `matches` as "populated by H3" (epic-001 FR-13, ADR-004).
**Rationale:** `matches` is H3's table to fill; rationale is intrinsic to a match, so it belongs there rather than in a bolt-on side table. ADR-004 of H1 anticipated exactly this ("reshaping a near-empty table later is cheap").
**Trade-off:** The type declaration lives in H1's `schema.ts`; H3 touches a foreign-owned file's domain. Mitigated by routing the change through a single additive migration owned by one story (003-001), and by the engine's authoritative in-memory model not depending on the column existing.

### ADR-007 — Heuristic classification is the only gated path; LLM classification is an optional non-gated seam
**Decision:** Ship a pure `Classifier` (rules/keywords + recurring detection + merchant fallback) as the gated default; define an optional `LlmClassifier` behind the same interface, never wired in `vitest run`.
**Context:** FR-10 + NFR-5 — classification must be deterministic and offline in the gate; LLM assist is optional.
**Rationale:** Mirrors H2's `VisionProvider` quarantine: the network/non-determinism boundary is a single injected dependency, so the whole classification surface is deterministically testable.
**Trade-off:** Gate accuracy is limited to what heuristics achieve; LLM drift is only observable off-gate. Accepted — the gate's job is correctness of the *engine*, not classifier recall.

### ADR-008 — Correction-aware rollups via a pure `applyCorrections` transform; H4 simulated by fixtures
**Decision:** `applyCorrections(ledger, corrections)` returns a new `ReconciledLedger`; rollups recompute over the result. H4 not existing yet, correctness is verified with fixtures that encode an applied correction.
**Context:** FR-12 with the `[ASSUMPTION]` that H4 doesn't exist.
**Rationale:** Keeping correction-application a pure transform over the ledger means the "before" and "after" rollups are both testable today, and H4 later supplies real `Correction[]` to the same function.
**Trade-off:** H3 commits to a `Correction` shape before H4 is designed; localized to one type and one function, cheap to adjust when H4 lands.

### ADR-009 — Recurring detection by (merchant + amount±tol + cadence), deterministic
**Decision:** `detectRecurring` clusters events by normalized merchant and near-equal amount, confirms a monthly-ish cadence within `recurringCadenceToleranceDays`, and labels mortgage/utility/subscription.
**Context:** FR-10 — fixed obligations must be recognized; ML is a non-goal.
**Rationale:** A deterministic clustering rule is explainable (the rationale cites merchant + amount + observed cadence) and gate-stable.
**Trade-off:** Only amount-stable recurring charges are caught; variable-amount subscriptions need a future cadence-only revision. Stated, not silently handled.

### ADR-010 — Sparse-history policy: comparison flags require ≥ window months, else explicit `insufficient_history`
**Decision:** Insight flags whose basis is a multi-month comparison (e.g. 3-month average) require ≥ `insightComparisonMonths` of history; below that, the flag is emitted `inconclusive` with `basis:'insufficient_history'` rather than computing a misleading number.
**Context:** NFR-6 — the brief leaves sub-window behavior undefined; fixtures span ≥3 months precisely so the populated case is testable.
**Rationale:** Honesty over a fabricated comparison (consistent with Philosophy #4); both the populated and sparse branches are explicitly tested.
**Trade-off:** Fewer insights early in a household's history — accepted, since a comparison against one month of data is noise, not insight.
