# Foundation & Ingestion (Epic H1) — Home-Management Platform

## The Problem

A household's spending lives in three disconnected sources, none of which tells the whole story on its own:

- **Bank transactions** record *that* money moved and *when it settled*, but as opaque totals — no line-item detail about *what* was bought.
- **Amazon order history** records rich item detail, but carries no settlement information — you can't tell which bank charge a given order produced (and one order can split into several charges).
- **Receipt photos** carry item detail too, but live offline, outside any system.

Reconciling these three is the platform's eventual purpose, but there is nothing to reconcile *with* yet: this is a greenfield repo. Before any matching, classification, or UI can exist, the platform needs a durable scaffold and a trustworthy ingestion layer that gets bank, order, and (later) receipt data in cleanly, idempotently, and without ever leaking real financial data into version control. H1 builds exactly that foundation — and nothing downstream of it.

## Target Users

- **Primary (end user): the household finance-keeper.** A single person reconciling their own household's spending. H1 delivers them no UI; their interest is that the data captured now is complete and faithful enough to support reconciliation later.
- **Primary (immediate consumer): the downstream build epics.** H2 (receipt vision), H3 (matching, classification, store-credit drawdown), and H4 (UI) are the real near-term consumers. The schema, the `SourceAdapter` contract, and the framework-agnostic core exist primarily so these epics can build on a stable, extractable foundation.
- **Secondary: the demo audience.** The seed/fixture path must let someone ingest a real bank Excel export and a real Amazon CSV and see clean data — the credibility beat for the platform.
- **Anti-persona: the multi-tenant / enterprise operator.** Auth, multi-tenancy, and multiple concurrent households are explicitly *not* served today. The schema must *allow* more than one household, but no feature should be built for that user now.

## Proposed Solution

Stand up a greenfield monorepo structured as a home platform, with `modules/finance` as the first module. All business logic (ingestion, parsing, matching, classification) lives in a framework-agnostic `modules/finance/core` — pure TypeScript, no Next.js/React imports — so the engine stays extractable. Next.js App Router route handlers call into that core.

Ingestion is unified behind a single `SourceAdapter` interface that normalizes any input into a common order/receipt/transaction model. Universal, document-upload adapters (Excel/CSV, image, PDF, .eml) are the default; retailer/API-specific adapters (Amazon CSV today, Costco later) are optional implementations behind the same contract. H1 ships the interface plus the upload/CSV adapters, and stubs the retailer-API and .eml slots.

The data model is built end-to-end for the platform — including tables H2 and H3 will populate (receipts, matches, store-credit ledger) — so downstream epics inherit a schema shaped for their needs, not a series of migrations.

## Key Capabilities

1. **Platform scaffold** — greenfield monorepo (pnpm workspaces), `modules/finance` as module #1, Tailwind + shadcn/ui + `geist` font configured, libSQL/Turso client and Drizzle ORM wired. No code imported from any prior project. `data/`, raw uploads, local DB files, and `.env*` gitignored from commit #1.
2. **Framework-agnostic core boundary** — all logic in `modules/finance/core` with no Next/React imports, enforced by an automated test/lint check.
3. **`SourceAdapter` contract** — one normalization interface; universal upload/CSV adapters shipped, retailer-API and .eml slots stubbed behind it.
4. **Data model** — households, accounts, transactions, orders + order_items (per-shipment identifier), receipts + receipt_items (table only, H2), matches (table only, H3), categories (schema only, H3), and a `store_credit_balances` ledger (record-only in H1). Returns are first-class: signed-negative line items with a `refund_destination` enum distinguishing `card` (hits the bank as a credit) from `store_credit`/`gift_card`/`account_balance` (does not). Idempotency keys defined for transactions `(account + date + amount + normalized merchant + source-row hash)` and order lines `(order_id + shipment + item)`.
5. **Bank statement importer** — primary format Excel (.xlsx/.xls via SheetJS), also CSV. Header-row detection, date/amount normalization (incl. Excel serial dates, guarding the 1900 leap-year bug), merchant cleanup, credit/debit handling, and idempotent re-import. Malformed rows are skipped and surfaced as structured import errors — never silently dropped.
6. **Order ingestion** — parse Amazon `Retail.OrderHistory.1.csv` into orders + per-shipment line items (per-shipment subtotals and refund/return rows), file-based, no live auth, flowing through `SourceAdapter`.
7. **Fixtures & seed** — sanitized real samples (fake account numbers, real structure), including ≥1 return/refund case, plus a seed script for a synthetic demo household.

## Constraints

- **Stack is decided and not open for re-litigation** (H4 inherits it): Next.js App Router + TypeScript (UI, API routes, and the future receipt-vision job in one deployable app); Tailwind + shadcn/ui (copy-in) + the `geist` font package (font only — use shadcn/ui, *not* `@geist-ui/core`); libSQL/Turso for data; Drizzle ORM for schema + migrations; pnpm workspaces; deploy on Vercel.
- **No durable serverless disk:** `better-sqlite3` / on-disk SQLite is forbidden. Local dev and tests use a `file:` libSQL DB, falling back to a per-run temp file if `:memory:` is unsupported, so tests run offline.
- **No real financial data in git, ever** — enforced by `.gitignore` from commit #1.
- **File-based ingestion only** — no live network auth to banks, Amazon, or email.
- **Single household today**, though the schema must accommodate more.
- **Test-first delivery:** derive tests before implementation, red→green, using Vitest.

## Risks and Open Questions

- **Real-world Excel variance.** Bank exports differ wildly in header layout, date encoding, and credit/debit conventions. The 1900 leap-year bug is called out, but header-row detection and merchant cleanup are where silent corruption hides. *Mitigation: the malformed-row error path must be exercised by tests against real sanitized fixtures.*
- **Amazon CSV format drift.** `Retail.OrderHistory.1.csv` schema has changed across exports over time. **Open question:** which export vintage(s) must the parser support? `[ASSUMPTION]` H1 targets the current export format only; older variants are out of scope unless a fixture proves otherwise.
- **Per-shipment identifier fidelity.** The one-order→many-charges beat (H3) depends entirely on H1 capturing a correct per-shipment identifier. If Amazon's export doesn't expose a stable shipment ID, H3's matching premise weakens. **Open question:** is shipment granularity reliably present in the source CSV?
- **Idempotency key collisions.** The transaction key relies on a normalized merchant string and a source-row hash. **Open question:** do legitimately distinct same-day, same-amount, same-merchant transactions exist (e.g., two identical coffee purchases)? `[ASSUMPTION]` the source-row hash disambiguates these; if a bank export collapses such rows, the key needs revisiting.
- **`refund_destination` inference.** Bank data alone can't always tell whether a refund landed on `card` vs. store credit. `[ASSUMPTION]` in H1 this enum is populated only where the *source* states it (e.g., Amazon order data); bank-only refunds default to `card`, with reconciliation deferred to H3.
- **PDF bank statements (optional).** Routed through the same Claude vision/LLM extraction as H2 receipts. `[ASSUMPTION]` this is build-if-time-allows; Excel is the dependable demo path and PDF must not block the suite going green.

## Success Criteria

H1 is done when all of the following hold:

- [ ] A **real bank Excel export** ingests cleanly via CLI/script.
- [ ] A **real Amazon order CSV** ingests cleanly via CLI/script.
- [ ] The schema supports H2 and H3: `receipts` and `matches` tables are present and shaped for their downstream consumers; `store_credit_balances` records balance rows on store-credit refunds (drawdown deferred to H3).
- [ ] Vitest covers: importer normalization, parser extraction, **idempotency** (re-import produces no duplicates), and the **malformed-row error path**.
- [ ] An **integration test imports the real ingest route/service** (App Router `route.ts` or `createApp` — *not* a fixture app) against a fresh libSQL test DB.
- [ ] The **core-import-boundary check passes** (no Next/React imports in `modules/finance/core`).
- [ ] The **full test suite is green**, runs offline, and uses a `file:`/temp libSQL DB.
- [ ] **No real data in git**, and `.gitignore` proves the exclusion from commit #1.

## Non-Goals

Plaid/bank APIs; live Gmail/IMAP (file-based only today); receipt parsing (H2); matching, classification, and store-credit drawdown (H3); UI (H4); auth and multi-tenancy (single household today, schema allows more).
