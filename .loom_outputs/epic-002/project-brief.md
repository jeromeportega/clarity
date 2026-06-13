# Receipt Vision & SKU Disambiguation — Epic H2

## The Problem

For in-store spending at big-box retailers, the paper receipt is the *only* item-level record of what was actually purchased. Banks and card networks see a single opaque total — "$147.32 at WHOLESALE CLUB" — with no visibility into the basket. The receipts themselves resist machine reading: they are photographs of thermal paper crowded with cryptic abbreviations (`KS ORG EVOO 2CT`, `GV WHL MLK`), bare SKU numbers, multi-buy discounts, and tax/fee lines, often skewed, glare-washed, or crumpled.

Converting that photo into a trustworthy, structured set of line items is both the hard problem and the differentiating capability of the platform's finance module. Everything downstream — categorized spending, budgets, the human-review queue — depends on this extraction being accurate *and honest about its own uncertainty*.

## Target Users

- **Primary beneficiary — the household finance user.** Wants to know *what* they bought, not just that they spent money. Never interacts with H2 directly; consumes its output through later epics.
- **Primary consumer — H4's receipt-drop route and the accuracy harness.** These are the direct callers of H2's core function and define its real contract. The surface must serve both an interactive upload path and an offline evaluation script.
- **Secondary — H4's human-review queue.** Consumes the `needs_review` flags H2 emits; relies on H2 never silently guessing.
- **Secondary — H1's schema owners.** Own the shared `receipts`/`receipt_items` contract and the `categories` taxonomy that H2 must honor without extension.
- **Anti-persona — the mobile-capture / document-parsing user.** Anyone expecting live camera capture, invoice/bank-statement parsing, or external product-API lookups. These are explicit non-goals and must not shape the design.

## Proposed Solution

A **pure-TypeScript core function** in `modules/finance/core` (no Next/React imports) that accepts a receipt image and returns a structured record plus line items. It uses Claude vision via the Anthropic SDK (system prompt cached) for extraction and a generic LLM resolver for SKU disambiguation, backed by a **persistent, self-learning SKU dictionary** so repeat items resolve instantly. Every output carries explicit confidence; low-confidence items and any receipt that fails arithmetic reconciliation are flagged `needs_review` rather than guessed. The same core function is called by H4's route and by a separate, key-gated accuracy harness.

## Key Capabilities

1. **Extraction pipeline.** Receipt photo → structured record (store, date, total, tax, payment hint/last-4 *if printed*) + line items (SKU, abbreviated description, quantity, unit price, line price, discounts). Tolerates skew, glare, and crumple. On a fully unreadable photo or a vision refusal, persist the receipt flagged `needs_review` with zero line items — **never discard the upload, never fabricate items.** Accept JPEG/PNG; HEIC/PDF optional.
2. **SKU disambiguation.** Abbreviated description + SKU + store context → canonical product name + category (drawn only from H1's fixed `categories` taxonomy), each with its **own** confidence score. Generic LLM resolver is the default path.
3. **Persistent learning SKU dictionary.** Keyed `(store, SKU/abbreviation) → resolution + confidence + source`. Repeat items resolve instantly; auto-resolutions append **only at/above the confidence threshold** (default `0.80`), tagged `source=auto`. H4 later appends `source=human` corrections, which **always win on upsert**. An empty-dictionary cold start is the normal first-run path.
4. **Honest uncertainty + arithmetic reconciliation.** Line items below threshold are flagged `needs_review`. Arithmetic check: `Σ line prices − Σ discounts + tax (+ bag/bottle/CRV fees)` must reconcile to the printed total within **±$0.02**; a mismatch flags the **whole receipt** `needs_review`.
5. **Framework-free, idempotent surface.** A single core entry point usable by both H4's route and the harness. Re-uploading the identical photo is idempotent via a hash of the image bytes.
6. **Schema-contract storage.** Writes `receipts`/`receipt_items` per H1's shared schema. If H1 has not landed, stub the two tables behind the same TypeScript interface so the epic is independently testable — **do not invent columns H1 doesn't expose.**

## Constraints

- **Stack:** Next.js App Router + TypeScript + libSQL. The H2 core must contain **zero** Next/React imports.
- **Shared contracts:** Reuse H1's schema and `categories` taxonomy verbatim; no new columns or categories.
- **Test-gate discipline (critical):** The default `npm test` gate — what loom's integration gate runs — **must stay green offline, with no API key and no network**, driven by recorded/fixture vision outputs. The live-vision accuracy harness is a **separate** command (e.g. `npm run vision:eval`), gated on `ANTHROPIC_API_KEY`, and is **not** part of `npm test` and **not** in E2E.
- **Tunable defaults:** confidence threshold `0.80`; arithmetic tolerance `±$0.02`.
- **Cost/non-determinism:** vision calls cost money and are non-deterministic — hence the fixture/harness split above.
- **Data hygiene:** only publishable/sanitized receipts may appear in fixtures.
- **Dependency:** H1's schema; stub-behind-interface if not yet landed.

## Risks and Open Questions

- **H1 dependency timing.** If H1's schema lands late or changes, the stub interface must track it. *Risk:* contract drift between the stub and H1's real columns.
- **Fuzzy-match ratio undefined.** Success requires canonical-name match "above a set ratio," but the ratio is unspecified. **Open question:** what ratio (and which algorithm) counts as "correctly resolved"? `[ASSUMPTION]` the team sets a concrete ratio before deriving tests.
- **Cold-start accuracy.** With an empty dictionary, early receipts rely entirely on the LLM resolver. `[ASSUMPTION]` accuracy is lowest on first runs and improves as the dictionary warms; the ≥80% bar is `[ASSUMPTION]` measured against the harness fixtures, not cold real-world traffic.
- **Confidence derivation.** How the resolver produces *separate* name and category confidence scores from the LLM is unspecified. **Open question:** model-reported confidence, a heuristic, or calibrated post-processing?
- **Fee/discount handling.** CRV, bag, and bottle fees vary by jurisdiction, and multi-buy discounts must be attributed correctly for reconciliation. **Open question:** are fee-bearing and multi-buy receipts represented in the ≥5 fixtures?
- **PII in payment hints.** Last-4 and payment hints appear "if printed." `[ASSUMPTION]` sanitization is mandatory and enforced by the fixtures-must-be-sanitized rule.
- **Optional formats.** HEIC/PDF are optional — a scope decision is needed on whether they land in H2 or defer.

## Success Criteria

- **End-to-end coverage:** ≥5 real, sanitized receipt photos process end-to-end into structured records.
- **Accuracy bar:** the accuracy harness asserts **≥80% of line items "correctly resolved,"** defined per line item as canonical-name fuzzy match above the set ratio **AND** category equals expected — implemented as a **threshold assertion, never exact-string match.**
- **Arithmetic validation:** a deliberately corrupted fixture flags the receipt `needs_review`; a clean fixture reconciles within ±$0.02.
- **Unit coverage in the default gate (no live calls):** arithmetic-to-total; and SKU dictionary behaviors — append, instant repeat-resolve, confidence gating, and human-wins upsert — all run on recorded/fixture outputs.
- **Uncertainty surfaced:** below-threshold items carry `needs_review`; fully unreadable photos persist flagged with zero line items.
- **Idempotency:** re-uploading the identical photo is a no-op via image-byte hash.
- **Gate hygiene:** `npm test` is green offline with no key and no network; `vision:eval` is separate, key-gated, and excluded from `npm test` and E2E.
- **Data hygiene:** only sanitized receipts appear in fixtures.
- **Process:** tests derived **first**, red → green, before implementation.

### Out of Scope (Non-Goals)

Live camera/mobile capture (file upload suffices); non-receipt documents — invoices, bank statements (statement-PDF vision is H1's optional adapter); product-image lookup or external product APIs; and the review UI, human write-back, and Playwright E2E (all H4).
