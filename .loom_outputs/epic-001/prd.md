# Foundation & Ingestion (Epic H1) — Home-Management Platform

## Overview

H1 stands up a greenfield home-management monorepo and a trustworthy ingestion layer for household financial data. A household's spending lives in three disconnected sources — bank transactions (settlement, no line items), Amazon order history (line items, no settlement), and receipt photos (offline) — and the platform's eventual purpose is to reconcile them. There is nothing to reconcile *with* yet. H1 delivers the durable scaffold, a framework-agnostic business-logic core, a unified `SourceAdapter` ingestion contract, an end-to-end data model shaped for downstream epics (H2 receipts, H3 matching/classification/store-credit, H4 UI), and working bank-Excel and Amazon-CSV importers — and nothing downstream of that. No real financial data ever enters version control.

## Goals

1. **Extractable foundation.** Ship a monorepo with all business logic in a framework-agnostic core. *Metric:* the automated core-import-boundary check passes — zero Next/React imports in `modules/finance/core`.
2. **Trustworthy ingestion.** Get bank and order data in cleanly and idempotently. *Metric:* a real bank Excel export and a real Amazon order CSV both ingest cleanly via CLI/script; re-importing either produces zero duplicate rows.
3. **Downstream-ready schema.** Build the data model end-to-end so H2/H3 inherit it without new migrations. *Metric:* `receipts`, `receipt_items`, `matches`, `categories`, and `store_credit_balances` tables exist and are shaped for their consumers; a store-credit refund records a balance row.
4. **Safe and reproducible.** *Metric:* no real financial data in git (proven by `.gitignore` from commit #1); the full Vitest suite is green, runs offline, and uses a `file:`/temp libSQL DB.

## User Stories

- **(Must)** As the **household finance-keeper**, I want my bank Excel and Amazon CSV exports captured completely and faithfully, so that reconciliation built later has trustworthy data to work from.
- **(Must)** As a **downstream build epic (H2/H3/H4)**, I want a stable schema and a single `SourceAdapter` contract over a framework-agnostic core, so that I can build on H1 without reshaping its foundations.
- **(Should)** As the **demo audience**, I want to run a seed/fixture path that ingests a real bank export and a real Amazon CSV into clean data, so that the platform's credibility is demonstrable.
- **(Must)** As the **finance-keeper**, I want returns and refunds represented as first-class signed line items, so that money flowing back is never lost or double-counted.

## Functional Requirements

### Platform scaffold
- **FR-1:** Provide a greenfield monorepo using pnpm workspaces, with `modules/finance` as the first module and no code imported from any prior project.
- **FR-2:** Configure Tailwind, shadcn/ui (copy-in), and the `geist` font package (font only — `geist`, not `@geist-ui/core`).
- **FR-3:** Wire a libSQL/Turso client and Drizzle ORM (schema + migrations).
- **FR-4:** From commit #1, `.gitignore` must exclude `data/`, raw uploads, local DB files, and `.env*`.

### Framework-agnostic core
- **FR-5:** All business logic (ingestion, parsing, and the slots for matching/classification) lives in `modules/finance/core` as pure TypeScript with no Next.js/React imports. Next.js App Router route handlers call into the core.
- **FR-6:** An automated test/lint check fails if any Next/React import appears in `modules/finance/core`.

### SourceAdapter contract
- **FR-7:** Define a single `SourceAdapter` interface that normalizes any input into a common order/receipt/transaction model.
- **FR-8:** Ship universal document-upload adapters for Excel/CSV behind the contract.
- **FR-9:** Provide stubbed slots, behind the same contract, for the retailer-API adapter and the `.eml` adapter (interface present, no implementation).

### Data model
- **FR-10:** Define tables for `households`, `accounts`, and `transactions`.
- **FR-11:** Define `orders` and `order_items`, including a per-shipment identifier on line items.
- **FR-12:** Define `receipts` and `receipt_items` as tables only (populated by H2).
- **FR-13:** Define `matches` as a table only (populated by H3) and `categories` as schema only (used by H3).
- **FR-14:** Define a `store_credit_balances` ledger that, in H1, records balance rows when a refund lands as store credit (drawdown deferred to H3).
- **FR-15:** Model returns as first-class signed-negative line items carrying a `refund_destination` enum: `card` (hits the bank as a credit) vs. `store_credit` / `gift_card` / `account_balance` (does not).
- **FR-16:** Define idempotency keys: transactions keyed on `(account + date + amount + normalized merchant + source-row hash)`; order lines keyed on `(order_id + shipment + item)`.

### Bank statement importer
- **FR-17:** Import bank statements with Excel as the primary format (`.xlsx`/`.xls` via SheetJS) and CSV also supported.
- **FR-18:** Perform header-row detection, date/amount normalization (including Excel serial dates, guarding the 1900 leap-year bug), merchant cleanup, and credit/debit handling.
- **FR-19:** Make re-import idempotent — re-importing the same file produces no duplicate rows.
- **FR-20:** Skip malformed rows and surface them as structured import errors; never silently drop a row.

### Order ingestion
- **FR-21:** Parse Amazon `Retail.OrderHistory.1.csv` into `orders` + per-shipment line items (including per-shipment subtotals and refund/return rows), file-based, with no live auth, flowing through `SourceAdapter`.

### Fixtures, seed, and entry points
- **FR-22:** Provide sanitized real sample fixtures (fake account numbers, real structure), including at least one return/refund case.
- **FR-23:** Provide a seed script that creates a synthetic demo household.
- **FR-24:** Provide a CLI/script entry point that ingests a bank Excel export and an Amazon order CSV.
- **FR-25:** Provide an integration test that imports the real ingest route/service (App Router `route.ts` or `createApp` — not a fixture app) and runs against a fresh libSQL test DB.

## Non-Functional Requirements

- **NFR-1:** No `better-sqlite3` or on-disk SQLite. Local dev and tests use a `file:` libSQL DB, falling back to a per-run temp file if `:memory:` is unsupported, so the suite runs offline.
- **NFR-2:** No real financial data in git, ever — enforced by `.gitignore` from commit #1.
- **NFR-3:** Ingestion is file-based only — no live network auth to banks, Amazon, or email.
- **NFR-4:** Test-first delivery: derive tests before implementation, red→green, using Vitest. Coverage must include importer normalization, parser extraction, idempotency (re-import produces no duplicates), and the malformed-row error path.
- **NFR-5:** Single household today; the schema must *allow* more than one household, but no multi-household feature is built.
- **NFR-6:** The stack is fixed and not open for re-litigation: Next.js App Router + TypeScript (one deployable app), Tailwind + shadcn/ui + `geist` font, libSQL/Turso, Drizzle ORM, pnpm workspaces, deploy on Vercel.

## Epics

- **Epic H1 — Foundation & Ingestion** (this PRD). A single cohesive shipping unit: scaffold + core boundary + `SourceAdapter` + data model + bank/order importers + fixtures/seed. Downstream epics (H2 receipt vision, H3 matching/classification/store-credit drawdown, H4 UI) are separate and out of scope here.

## Assumptions & Open Questions

- **[ASSUMPTION]** The Amazon parser targets the current `Retail.OrderHistory.1.csv` export format only; older export vintages are out of scope unless a fixture proves otherwise. *Open question: which export vintage(s) must be supported?*
- **[ASSUMPTION]** A stable per-shipment identifier is reliably present in the Amazon CSV. *Open question: is shipment granularity reliably exposed by the source?* (H3's one-order→many-charges matching depends on it.)
- **[ASSUMPTION]** The source-row hash disambiguates legitimately distinct same-day/same-amount/same-merchant transactions; if a bank export collapses such rows, the transaction key needs revisiting.
- **[ASSUMPTION]** `refund_destination` is populated only where the *source* states it (e.g., Amazon order data); bank-only refunds default to `card`, with reconciliation deferred to H3.
- **[ASSUMPTION]** PDF bank-statement support (routed through the same Claude vision/LLM extraction as H2 receipts) is build-if-time-allows; Excel is the dependable demo path and PDF must not block the suite going green.

## Out of Scope

- Plaid / bank APIs and any live network auth.
- Live Gmail/IMAP ingestion (file-based only today); `.eml` adapter is a stubbed slot only.
- Live retailer-API adapters (Amazon API, Costco, etc.) — stubbed slot only.
- Receipt parsing / vision extraction (H2); image adapter implementation.
- Matching, classification, and store-credit drawdown (H3) — tables/schema present but unpopulated.
- UI (H4).
- Auth and multi-tenancy / multiple concurrent households — single household today, schema allows more.
- Older Amazon CSV export vintages (per assumption above).
