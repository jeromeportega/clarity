# Reconciliation Engine & Item-Level Classification (Epic H3)

## The Problem

A person's spending is scattered across three systems that never agree: the **bank statement** (authoritative on dollars, blind to detail), the **receipt** (item-level truth, no link to settlement), and the **Amazon order** (line items split across several charges). Today these live as disconnected records. The same purchase appears in two or three places at once, so any naive sum **double-counts**. Refunds make it worse: a refund to a Costco Shop Card or Amazon balance never touches the bank, so a reconciler that expects every event on the bank statement flags it as "unmatched" — manufacturing noise where there is none. The result is a spend total nobody trusts and a category breakdown that is quietly wrong.

The core claim this epic must deliver: **every dollar counted once, every dollar explained.** A $234.17 bank line *is* receipt #1042, which *is* part of Amazon order #112-44321 — one economic event, three views, one dollar.

## Target Users

- **Primary — the individual reconciling their own finances.** Wants a trustworthy net-spend figure and a per-line explanation of where each dollar went, without manually stitching receipts to statements.
- **Secondary — downstream modules.** H4's review queue consumes the ambiguous-match candidates this engine refuses to auto-link; rollups must later reflect H4 corrections when they land.
- **Anti-persona — the forecaster/budgeter.** This epic measures and flags what *happened*; it does not project, budget, or train models. Requests for predictive budgeting are out of scope by design.

## Proposed Solution

A **pure-TypeScript reconciliation engine** in `modules/finance/core` — no Next, no React — that joins the three sources into a single reconciled ledger. It matches receipts and Amazon orders to bank lines with persisted rationale and confidence, enforces a single-counting invariant when sources overlap, handles refunds (including store-credit refunds that never hit the bank) correctly against a store-credit ledger, classifies every line item to a category, and rolls up **net** true-spend by category × month. From those rollups it derives a small set of **in-app** insight flags. All logic is unit-tested under Vitest — fast, deterministic, offline — against **synthetic fixtures** that mirror the real formats. No real data and no API keys ever enter the gate.

## Key Capabilities

1. **Matching engine.**
   - *Receipt ↔ bank line:* fuzzy match on amount (exact, plus tip/adjustment tolerance), date window, merchant-string similarity, and card last-4 where available.
   - *Amazon order ↔ bank line:* sum-of-subsets matching within a date window to resolve split shipments (one order → several charges). Source is the **Amazon order CSV**, not email.
   - Every match persists **rationale text + confidence**. Ambiguous candidates route to the review queue — **never** auto-linked.
2. **Dedup invariant (headline).** When a transaction has both a receipt and an Amazon order, item detail merges and the dollar is **counted exactly once**. This is the product's central invariant and its failing test is written first (red → green).
3. **Returns & refunds.** Refunds are signed-negative events.
   - A `card` refund reconciles against a bank **CREDIT** line (matched like a purchase, opposite sign).
   - A `store_credit` / `gift_card` / `account_balance` refund **never** appears on the bank — it must **not** be flagged unmatched; instead it posts to the `store_credit_balances` ledger (H1 created the table + accrual rows; H3 implements drawdown).
   - **Net spend = purchases − refunds**; all rollups use net, not gross. When a later purchase is partly paid from store credit, the bank charge is *less* than the receipt total — reconcile the gap against the store-credit ledger, not as a mismatch.
4. **Item-level classifier.** Every line item → a category from H1's taxonomy, with a one-line rationale. Includes recurring-pattern detection (same merchant + amount + cadence → mortgage/utility/subscription) and merchant-level fallback classification for unmatched bank lines that carry no item data.
5. **True-spend rollups.** Queryable by category × month, computed on **net** spend, designed to reflect review-queue corrections from H4 when they arrive.
6. **In-app insight flags (≥2).** Cheap queries over the rollups, surfaced **in-app only** — e.g. "this Costco trip is 40% above your 3-month average for that merchant," "groceries tracking over last month," "new recurring charge detected." Each flag carries the number and its comparison basis.

## Constraints

- **Pure TS, no UI framework** — logic lives in `modules/finance/core`; no Next/React.
- **Test-first, Vitest only** — unit tests over pure logic; fast, deterministic, **offline**. The dedup-invariant and matcher tests are written **before** implementation.
- **Gate-safe** — synthetic fixtures matching real formats only; **never real data, never API keys** in the gate.
- **Dependency order** — consumes H1's schema (categories taxonomy, `store_credit_balances` table + accrual rows) and H2's `receipt_items`.
- **Amazon source is the order CSV**, not email parsing.
- **No auto-linking of low-confidence matches** — the review queue is the only path for ambiguity.

## Risks & Open Questions

- **Matching thresholds are unspecified.** Tip/adjustment tolerance, merchant-similarity cutoff, and date-window widths need concrete values. `[ASSUMPTION]` these are tunable constants chosen to pass the synthetic fixtures, with sane defaults documented in code.
- **Sum-of-subsets is combinatorial.** Split-shipment matching can blow up on large candidate sets. `[ASSUMPTION]` date-window + amount bounding keeps the candidate pool small enough that a bounded subset search is acceptable for synthetic-scale data; revisit if real volumes grow.
- **Confidence semantics undefined.** What numeric band auto-links vs. routes to review is not specified. `[ASSUMPTION]` a single confidence threshold separates auto-link from review-queue, defined as a named constant.
- **H4 dependency is forward-looking.** Rollups must "reflect review-queue corrections when they land," but H4 does not exist yet. `[ASSUMPTION]` H3 ships a correction-aware rollup path that is exercised by fixtures simulating an applied correction.
- **Classifier mechanism.** Brief permits "LLM + heuristics." `[ASSUMPTION]` gate tests cover the heuristic/deterministic path only (offline, no API keys); any LLM assist is non-gated and optional.
- **Insight-flag baselines.** "3-month average" requires ≥3 months of fixture data and a defined handling for sparse history. Open: behavior when history is shorter than the comparison window.

## Success Criteria

Tests are written **first**, red → green; all are Vitest unit tests over pure logic — fast, deterministic, offline.

- [ ] The **dedup-invariant** test and matcher unit tests are authored first and pass.
- [ ] On synthetic demo fixtures: **≥3** receipt ↔ bank matches.
- [ ] **≥2** Amazon-order ↔ bank matches, including **≥1 split-shipment** case.
- [ ] **≥1 dedup case** — receipt + order + bank linked, the dollar counted exactly once.
- [ ] **≥1 card refund** matched to a bank credit, **and ≥1 store-credit refund** that posts to the ledger with **no bank line** — net spend correct in both.
- [ ] Test: "refund to store credit → bank shows nothing → net spend still correct" passes.
- [ ] **Every** classification carries a rationale.
- [ ] Rollups are consistent with matches (consistency test) and computed on **net** spend.
- [ ] **≥2 insight flags** compute correctly, each carrying its number + comparison basis (test).
- [ ] No real data or API keys present anywhere in the gate.

## Non-Goals

- ML training / embedding pipelines — LLM + heuristics suffice.
- **Outbound notifications of any kind** (email / SMS / push / WhatsApp) — insight flags are in-app only.
- Full budgeting / forecasting — measurement and insight flags only.
- Auto-applying low-confidence matches — the review queue exists for exactly that.
