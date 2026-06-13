# PRD: Receipt Vision & SKU Disambiguation (Epic H2)

## Overview

H2 is a pure-TypeScript core function in `modules/finance/core` (zero Next/React imports) that turns a photo of a retail paper receipt into a trustworthy, structured record plus line items. It uses Claude vision (Anthropic SDK, system prompt cached) for extraction and a generic LLM resolver for SKU disambiguation, backed by a persistent, self-learning SKU dictionary so repeat items resolve instantly. Every output carries explicit confidence; low-confidence line items and any receipt that fails arithmetic reconciliation are flagged `needs_review` rather than guessed. The same core entry point is called by H4's interactive receipt-drop route and by a separate, key-gated accuracy harness. Storage honors H1's shared `receipts`/`receipt_items` schema and `categories` taxonomy verbatim.

## Goals

| # | Goal | Success Metric |
|---|------|----------------|
| G-1 | Accurately extract and resolve line items | Accuracy harness asserts **≥80% of line items "correctly resolved"** (canonical-name fuzzy match above the set ratio **AND** category equals expected), as a threshold assertion — never exact-string match |
| G-2 | Be honest about uncertainty | 100% of below-threshold line items and 100% of arithmetic-failing receipts flagged `needs_review`; zero fabricated items; unreadable photos persisted with zero line items |
| G-3 | Keep the default gate runnable everywhere | `npm test` is green **offline, with no API key and no network**, driven entirely by recorded/fixture vision outputs |
| G-4 | Learn from repetition | A repeat `(store, SKU/abbreviation)` resolves from the dictionary with **no LLM call** (instant repeat-resolve) |

## User Stories

- **(Must)** As **H4's receipt-drop route**, I want to call one core function with image bytes and receive a structured record + line items with per-field confidence, so that I can persist and render the basket without owning extraction logic.
- **(Must)** As **the accuracy harness**, I want to call the same core function under a key-gated, live-vision command, so that I can measure end-to-end resolution accuracy against fixtures without polluting the default test gate.
- **(Must)** As **H4's human-review queue**, I want H2 to flag `needs_review` on every low-confidence item and every receipt that fails reconciliation, so that I never have to detect silent guesses myself.
- **(Should)** As **an H4 human reviewer**, I want my corrections to be persisted as `source=human` and to always win on upsert, so that the dictionary improves and never regresses to an auto guess.
- **(Should)** As **H1's schema owner**, I want H2 to write only the columns and categories I expose, so that there is no contract drift or taxonomy sprawl.

## Functional Requirements

**Core surface**
- **FR-1** A single core entry point in `modules/finance/core` accepts a receipt image (bytes) and returns a structured receipt record plus line items. The module contains **zero** Next/React imports.
- **FR-2** Re-submitting the identical photo is idempotent (a no-op that returns/links the existing record) via a hash of the image bytes.

**Extraction pipeline**
- **FR-3** Extraction produces a structured record: store, date, total, tax, and payment hint/last-4 **only if printed**.
- **FR-4** Extraction produces line items: SKU, abbreviated description, quantity, unit price, line price, and discounts.
- **FR-5** Extraction tolerates skew, glare, and crumple, and accepts JPEG and PNG. (HEIC/PDF deferred — see Open Questions.)
- **FR-6** On a fully unreadable photo or a vision refusal, the receipt is persisted flagged `needs_review` with **zero** line items. The upload is never discarded and items are never fabricated.
- **FR-7** The Claude vision call uses a cached system prompt via the Anthropic SDK.

**SKU disambiguation**
- **FR-8** Given abbreviated description + SKU + store context, the resolver returns a canonical product name and a category drawn **only** from H1's fixed `categories` taxonomy.
- **FR-9** The resolver emits a **separate** confidence score for name and for category. The generic LLM resolver is the default path.

**Persistent learning dictionary**
- **FR-10** A persistent dictionary is keyed `(store, SKU/abbreviation) → resolution + confidence + source`. An empty dictionary (cold start) is a supported normal first-run path.
- **FR-11** A `(store, SKU/abbreviation)` already present resolves from the dictionary instantly, without invoking the LLM resolver.
- **FR-12** Auto-resolutions are appended **only at or above** the confidence threshold (default `0.80`), tagged `source=auto`.
- **FR-13** `source=human` corrections (appended later by H4) **always win on upsert**, overriding any `source=auto` entry.

**Honest uncertainty + reconciliation**
- **FR-14** Any line item with confidence below threshold is flagged `needs_review`.
- **FR-15** Arithmetic check: `Σ line prices − Σ discounts + tax (+ bag/bottle/CRV fees)` must reconcile to the printed total within **±$0.02**. A mismatch flags the **whole receipt** `needs_review`.

**Storage & contract**
- **FR-16** Output is written to `receipts`/`receipt_items` per H1's shared schema, reusing the `categories` taxonomy verbatim — no new columns, no new categories.
- **FR-17** If H1's schema has not landed, the two tables are stubbed behind the same TypeScript interface so H2 is independently testable; the stub exposes only columns H1 exposes.

**Evaluation surface**
- **FR-18** The live-vision accuracy harness is a **separate** command (e.g. `npm run vision:eval`), gated on `ANTHROPIC_API_KEY`, and is **not** part of `npm test` and **not** in E2E.
- **FR-19** ≥5 real, sanitized receipt photos process end-to-end into structured records under the harness.
- **FR-20** Default-gate unit coverage runs with no live calls on recorded/fixture outputs and covers: arithmetic-to-total reconciliation; and dictionary behaviors — append, instant repeat-resolve, confidence gating, and human-wins upsert.

## Non-Functional Requirements

- **NFR-1** **Gate hygiene:** `npm test` (loom's integration gate) must pass offline with no API key and no network. Live-vision runs only under the separate `vision:eval` command.
- **NFR-2** **Framework isolation:** the H2 core has zero Next/React imports.
- **NFR-3** **Tunable defaults:** confidence threshold `0.80`; arithmetic tolerance `±$0.02` — both configurable.
- **NFR-4** **Data hygiene:** only publishable/sanitized receipts may appear in fixtures; PII (last-4, payment hints) sanitization is mandatory in fixtures. `[ASSUMPTION]` sanitization is enforced by the fixtures-must-be-sanitized rule.
- **NFR-5** **Cost & non-determinism:** because vision calls cost money and are non-deterministic, accuracy is asserted via threshold checks on fixtures, never exact-string match.
- **NFR-6** **Process:** tests are derived **first** (red → green) before implementation.

## Epics

This PRD is delivered as **one epic** — it is a single cohesive shipping unit (the H2 core function and its evaluation harness).

- **Epic H2 — Receipt Vision & SKU Disambiguation** — the extraction pipeline, SKU resolver, persistent learning dictionary, uncertainty/reconciliation logic, schema-contract storage, and the separate key-gated accuracy harness.

## Open Questions & Assumptions

- **Fuzzy-match ratio undefined.** "Correctly resolved" requires a canonical-name match above a set ratio, but the ratio and algorithm are unspecified. `[ASSUMPTION]` the team fixes a concrete ratio + algorithm before deriving accuracy tests.
- **Confidence derivation.** How the resolver produces *separate* name and category confidence scores (model-reported, heuristic, or calibrated post-processing) is unspecified — open question.
- **Fee/discount fixtures.** Whether CRV/bag/bottle-fee and multi-buy-discount receipts are represented among the ≥5 fixtures is an open question affecting reconciliation coverage.
- **Cold-start accuracy.** `[ASSUMPTION]` accuracy is lowest on first runs and improves as the dictionary warms; the ≥80% bar is measured against harness fixtures, not cold real-world traffic.
- **H1 dependency timing.** If H1's schema lands late or changes, the stub interface must track it; risk of contract drift between stub and real columns.
- **Optional formats.** HEIC/PDF support is a deferred scope decision — `[ASSUMPTION]` deferred out of H2 V1 unless the team decides otherwise.

## Out of Scope (Non-Goals)

- Live camera / mobile capture (file upload suffices).
- Non-receipt documents — invoices, bank statements (statement-PDF vision is H1's optional adapter).
- Product-image lookup or external product APIs.
- The review UI, human write-back, and Playwright E2E (all H4).
- Extending H1's schema or `categories` taxonomy.
