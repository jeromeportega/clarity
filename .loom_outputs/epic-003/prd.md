# Reconciliation Engine & Item-Level Classification (Epic H3)

## Overview

A pure-TypeScript reconciliation engine in `modules/finance/core` that joins three disagreeing financial sources — bank statements, receipts, and Amazon order CSVs — into a single reconciled ledger where **every dollar is counted once and every dollar is explained**. The engine fuzzy-matches receipts and Amazon orders to bank lines with persisted rationale and confidence, enforces a single-counting invariant when sources overlap, handles refunds (including store-credit refunds that never touch the bank) against a store-credit ledger, classifies every line item to a category, and rolls up **net** true-spend by category × month. From those rollups it derives in-app insight flags. All logic is unit-tested under Vitest — fast, deterministic, offline — against synthetic fixtures only.

## Goals

1. **Trustworthy net-spend total.** A single reconciled figure where overlapping sources never double-count. *Metric:* ≥1 dedup case (receipt + order + bank) proves the dollar is counted exactly once; net spend = purchases − refunds across all rollups.
2. **Every dollar explained.** Each matched event carries machine-readable rationale and confidence; each classification carries a rationale. *Metric:* 100% of matches persist rationale + confidence; 100% of classifications carry a one-line rationale.
3. **No manufactured noise.** Store-credit/gift-card/account-balance refunds that never hit the bank are reconciled against the store-credit ledger, not flagged unmatched. *Metric:* the "refund to store credit → bank shows nothing → net spend still correct" test passes.
4. **Actionable in-app insight.** Cheap derived flags over rollups, each citing its number and comparison basis. *Metric:* ≥2 insight flags compute correctly with number + basis.

## User Stories

- **Must** — As a person reconciling my own finances, I want receipts and Amazon orders automatically matched to bank lines with a visible reason, so that I trust the link without manually stitching records.
- **Must** — As a person reconciling my own finances, I want a purchase that appears in multiple sources counted exactly once, so that my spend total isn't inflated.
- **Must** — As a person reconciling my own finances, I want refunds (including store-credit refunds) netted correctly, so that refunds reduce my spend instead of appearing as unmatched noise.
- **Must** — As a person reconciling my own finances, I want every line item classified to a category with a rationale, so that my category breakdown is correct and auditable.
- **Should** — As a person reconciling my own finances, I want net true-spend rolled up by category × month, so that I can see where money actually went over time.
- **Should** — As a person reconciling my own finances, I want in-app flags on unusual or recurring spending, so that I notice anomalies without analyzing the data myself.
- **Must** — As a downstream module (H4), I want ambiguous matches routed to a review queue rather than auto-linked, so that low-confidence links never silently corrupt the ledger.

## Functional Requirements

- **FR-1** — Match a receipt to a bank line by amount (exact, plus a tunable tip/adjustment tolerance), date window, merchant-string similarity, and card last-4 where available.
- **FR-2** — Match an Amazon order (from the order CSV) to one or more bank lines via sum-of-subsets within a date window, resolving split shipments (one order → several charges). Candidate pool is bounded by date-window + amount to keep the subset search tractable.
- **FR-3** — Persist for every match a rationale text and a numeric confidence value.
- **FR-4** — Route any match whose confidence falls below a named threshold constant to the review queue; never auto-link below threshold.
- **FR-5** — When a transaction has both a receipt and an Amazon order, merge item detail and count the underlying dollar exactly once (dedup invariant). The failing dedup-invariant test is authored before implementation (red → green).
- **FR-6** — Reconcile a `card` refund against a bank CREDIT line, matched like a purchase but signed negative.
- **FR-7** — Post a `store_credit` / `gift_card` / `account_balance` refund to the `store_credit_balances` ledger (drawdown against H1's table + accrual rows) and never flag it as unmatched for lacking a bank line.
- **FR-8** — When a later purchase is partly paid from store credit (bank charge < receipt total), reconcile the gap against the store-credit ledger rather than recording a mismatch.
- **FR-9** — Compute net spend as purchases − refunds; all rollups consume net, not gross.
- **FR-10** — Classify every line item to a category from H1's taxonomy with a one-line rationale, including recurring-pattern detection (same merchant + amount + cadence → mortgage/utility/subscription) and merchant-level fallback classification for unmatched bank lines lacking item data.
- **FR-11** — Produce true-spend rollups queryable by category × month, computed on net spend.
- **FR-12** — Expose a correction-aware rollup path that reflects review-queue corrections when applied, exercised by fixtures simulating an applied H4 correction. `[ASSUMPTION]` — H4 does not yet exist; correctness is verified via simulated correction fixtures.
- **FR-13** — Derive ≥2 in-app insight flags from the rollups (e.g. merchant trip above 3-month average, category tracking over last month, new recurring charge), each carrying its number and comparison basis.
- **FR-14** — Define matching thresholds (tip/adjustment tolerance, merchant-similarity cutoff, date-window widths, confidence cutoff) as named, documented constants tuned to pass the synthetic fixtures. `[ASSUMPTION]` — concrete values are unspecified in the brief; sane defaults are chosen and documented in code.

## Non-Functional Requirements

- **NFR-1** — All gate logic is pure TypeScript in `modules/finance/core` with no Next.js and no React dependency.
- **NFR-2** — All tests run under Vitest as unit tests over pure logic; they are fast, deterministic, and fully offline.
- **NFR-3** — The gate contains only synthetic fixtures matching real formats; no real data and no API keys are present anywhere in the gate.
- **NFR-4** — Test-first delivery: the dedup-invariant test and matcher tests are authored before their implementation.
- **NFR-5** — Any LLM-assisted classification is non-gated and optional; gate tests cover only the heuristic/deterministic classification path. `[ASSUMPTION]` — derived from the offline/no-API-key constraint.
- **NFR-6** — Insight-flag baselines require ≥3 months of fixture data for a "3-month average"; behavior for history shorter than the comparison window is defined explicitly. `[ASSUMPTION]` — sparse-history handling is unspecified in the brief and must be decided in implementation.

## Epics

- **Epic H3 — Reconciliation Engine & Item-Level Classification.** One cohesive engine: matching, dedup invariant, refunds/store-credit ledger, classification, rollups, and insight flags. Single shipping unit; one epic.

## Out of Scope

- ML training / embedding pipelines — LLM + heuristics suffice.
- Outbound notifications of any kind (email / SMS / push / WhatsApp) — insight flags are in-app only.
- Full budgeting or forecasting — measurement and flags only, no projection.
- Auto-applying low-confidence matches — the review queue is the only path for ambiguity.
- Amazon email parsing — the order CSV is the sole Amazon source.
- The H4 review-queue UI and correction-application logic itself — H3 only produces candidates and a correction-aware rollup path.
