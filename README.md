# Clarity

Item-level truth for household spending.

Bank statements tell you *where* money went (`COSTCO WHSE #0420  $234.17`).
Clarity tells you *what you bought*: it ingests bank exports, Amazon order
history, and receipts from big-box stores; reads receipts with Claude vision;
disambiguates abbreviated SKUs (`KS EVOO 2L` → *Kirkland Signature Organic
Extra Virgin Olive Oil*) into real products; reconciles every source so each
dollar is counted exactly once; classifies spending at the item level; and
routes anything it isn't sure about to a human review queue. Corrections feed
back into a per-store SKU dictionary so the system gets better with use.

The UI centerpiece is the **review queue** — a few minutes of triage a week —
with a secondary **true-spend** view (item-level category breakdown, each item
linked to its evidence: receipt region, Amazon order row, or bank line).

## How it works

```
bank .xlsx/.csv ─┐
Amazon orders CSV ┼─▶ ingest ─▶ normalize ─┐
receipt photo/PDF ┘        │               ├─▶ reconcile ─▶ classify ─▶ review queue
                       vision ─▶ SKU resolve ┘   (every $ once)  (item-level)      │
                                                                              true spend
```

- **Ingest** — `SourceAdapter`s for bank exports (Excel or CSV, header
  auto-detection), Amazon `Retail.OrderHistory.csv` (per-shipment line items,
  PII columns dropped), and receipt images/PDFs. Idempotency keys make every
  import safe to re-run.
- **Receipt vision** — one structured tool call to Claude with a static,
  prompt-cached system prompt; everything in the image is treated as untrusted
  data. Unreadable receipts are kept and flagged, never guessed.
- **SKU resolution** — dictionary-first: a per-store cache of learned
  `abbreviation → canonical name + category` is consulted before any model call.
  Misses go to Claude; confident answers (≥ 0.80 on both name and category) are
  written back.
- **Reconciliation** — receipt ↔ bank line matching (amount/date/merchant),
  Amazon order ↔ bank charge matching including split shipments (subset-sum),
  refunds and store-credit that never touch the bank, and a dedup invariant so a
  transaction covered by both a receipt and an order export is counted once.
- **Classification** — item-level categories with a merchant-level fallback when
  no item data exists.
- **Review queue** — low-confidence SKU resolutions, ambiguous matches,
  unmatched transactions, and receipts whose arithmetic doesn't add up.
  Confirm / correct / dismiss; decisions persist.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the module map, data
model, and what is and isn't wired yet, and [`docs/DATA_SOURCES.md`](docs/DATA_SOURCES.md)
for how to obtain each kind of input data. The plan is in
[`docs/ROADMAP.md`](docs/ROADMAP.md).

## Stack

Next.js (App Router) + TypeScript · Tailwind CSS + shadcn/ui primitives +
Geist · libSQL / Turso via Drizzle · Anthropic SDK · Vitest + Playwright ·
deployed on Vercel.

## Repository layout

```
apps/web/            Next.js app: pages, API routes, UI components
modules/finance/     Domain module: core/ (pure logic, DI seams) and db/ (schema, migrations, client)
tests/               Cross-cutting tests (route handlers, toolchain, deploy artifacts)
e2e/                 Playwright golden path (not part of `npm test`)
deploy/              Deploy checklist, env var reference, smoke test
scripts/             Dev scripts (demo seed)
docs/                Architecture, data sources, roadmap
```

`modules/finance/core` never constructs framework or SDK objects — clients,
stores, and providers are injected, which is what keeps the whole test suite
offline and deterministic (a boundary test enforces this).

## Getting started

Requires Node ≥ 20.

```bash
npm ci
cp .env.example .env            # fill in values; .env is gitignored
npm run db:migrate --workspace=@clarity/finance
npm run seed:demo               # optional: the demo household
npm run dev --workspace=@clarity/web
```

Without `TURSO_DATABASE_URL` the app falls back to a local file database under
`data/` (gitignored). Environment variables are documented in
[`deploy/ENV.md`](deploy/ENV.md) — names only, never values.

## Scripts

| Command | What it does |
|---|---|
| `npm test` | Vitest unit + integration suite. Offline, deterministic, no API keys, throwaway libSQL DBs. This is the CI gate. |
| `npm run typecheck` | `tsc --noEmit` over the db module and the tests plus everything they import (which transitively covers the app routes, pages, and core). |
| `npm run vision:eval` | Receipt-extraction accuracy harness against fixture receipts, through the Vercel AI Gateway. Needs `AI_GATEWAY_API_KEY` or a pulled `VERCEL_OIDC_TOKEN` (`vercel env pull`). Asserts one threshold over the sample — ≥ 80 % of expected line items resolved correctly, where "correct" = Dice similarity ≥ 0.85 on the canonical name *and* exact category — never per-item exact match. Not part of `npm test`. |
| `npm run e2e` | Playwright golden path (receipt → items → queue → rollup). Not part of `npm test`. |
| `npm run seed:demo` | Seeds the demo household and runs reconciliation over it. |
| `npm run db:generate` / `db:migrate` (in `modules/finance`) | Drizzle migrations. |

## Data and privacy

- **Real financial data never enters git.** `data/`, `uploads/`, `*.db`, and
  `.env*` are gitignored from the first commit; test fixtures under
  `modules/finance/fixtures` and `modules/finance/core/receipts/fixtures` are
  sanitized/synthetic.
- Receipt images are untrusted input: anything printed on them is data to
  extract, never an instruction to follow.
- All amounts are integer cents end to end.
- The public demo deployment serves a single seeded demo household in read-only
  mode; a private deployment signs people in with Clerk, and scripts write with
  a server-side token.

## Status

Working, well-tested core engine, and the live path now runs end to end for one
household: uploaded and imported receipts persist, reconciliation runs after
every ingest, upload and match decision (human decisions are inputs the engine
honours), corrections apply at their source and teach the SKU dictionary, and
digital Costco receipts seed that dictionary, and a signed-in person (Clerk)
gets their own household with the queue actions and uploads live in the
browser. Still ahead: durable receipt images and the queue UI that shows a
decision's context. The
[roadmap](docs/ROADMAP.md) tracks the path from demo to daily-use product;
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) lists what is not wired yet.
