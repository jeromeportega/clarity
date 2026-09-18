# Roadmap

North star: **a few minutes of review a week instead of an hour of spreadsheet
archaeology** — and numbers you trust because every dollar is counted once and
every item links to its evidence.

First real user: one household, on its own real data, in a private deployment.
Multi-user is designed in (tenancy on every table) but not built until the
single-household loop is excellent.

## Phase 0 — Safety (code done; rotation is the operator step)

- ~~Stop exposing the mutation token to the browser~~ — done; uploads on the
  public demo stay disabled until real auth exists, and a test guards that no
  file under `apps/web` outside the auth gate mentions the secret.
- ~~Gate the ingest routes the same way as every other mutation~~ — done; the
  route-gate test now discovers every write route automatically.
- Rotate the token; redeploy the public demo (the old value was baked into
  the statically prerendered `/receipts` of every earlier deployment).

## Phase 1 — Make it real for one household

- ~~**Persist uploads.**~~ Done: `apps/web/lib/receipt-pipeline.ts` wires the
  libSQL store (household-scoped, conflict-safe) and dictionary; receipts,
  items and learned SKUs survive the request and re-uploads are idempotent.
  Unreadable receipts persist as flagged placeholders that can be read again
  from the queue; images live in the private Blob store (see below).
- ~~**Reconcile at runtime.**~~ Done: `DrizzleReconcileSource.load` reads the
  household from the database, `reconcileHousehold` runs after every ingest and
  upload (and on demand via `POST /api/reconcile`), the sink never overwrites a
  human's or the resolver's category nor re-opens a settled transaction, and the
  DB-backed gateway is the default (`RECON_BACKEND=stub` is the opt-out).
  Human match decisions are engine inputs, True Spend counts only bank-linked
  receipt lines (net of discount), and the matchers are indexed. Still
  whole-household and synchronous — incremental runs are a later step.
- ~~**Corrections that apply.**~~ Done: every decision lands at its source
  (`receipt_items`, `receipts`, `matches`), clears `needs_review`, teaches the
  dictionary only what the human actually said, and is refused for items not in
  the queue or outside the household. `recomputeRollups` stays a no-op by
  design — rollups are computed on read.
- ~~**Render the queue actions.**~~ Done for a signed-in person (`QueueActions`
  on the queue page, driving the server actions); the public demo stays
  read-only.
- ~~**Evidence image route.**~~ Done: uploads are stored in a private Vercel
  Blob store (local disk without the token) keyed by household + image hash,
  and `/api/receipts/image/[receiptId]` serves them after the household check.
- ~~**Real login.**~~ Done with Clerk: `resolveReadScope` / `requireWriter`
  derive the household from the session in one place; a first sign-in
  provisions the person's household (`users`, `household_members`, migration
  0007). The demo constant survives only for the public demo and the script
  token.
- **Tenancy columns still open.** `household_id` on `sku_dictionary` (the
  pooling-with-consent question), FK on `review_decisions`, household switching
  for a person in several households, and the bank route trusting a token
  caller's `accountId`.
- ~~**Costco digital receipts as a first-class source.**~~ Done: the
  `WarehouseReceiptDetail` export (item number, abbreviated description,
  **canonical product name**, department, price, instant savings, tender)
  imports into `receipts` / `receipt_items` via `POST /api/ingest/costco` or
  the CLI. Every retailer-named line also teaches the SKU dictionary
  (`learnFromDigitalReceipts`, after each import and via
  `npm run dictionary:bootstrap`); the same export is the labeled ground truth
  for the vision eval (`npm run costco:eval-set`).

## Phase 2 — Make the loop great

- **Queue with context.** ~~Receipt-borne items carry store, date, the model's
  answer and a thumbnail~~ — done (`QueueItem.context`). Still open: match
  candidates and "why we're unsure" on match items; replace free-text
  "match candidate ID" with a picker.
- **Per-receipt batch resolution.** Today each line item is one model call with
  no receipt context; resolve a whole receipt in one call with store, date,
  department numbers, and neighboring items as context. Cheaper and more accurate.
- ~~**Bootstrap the dictionary** from Costco canonical names.~~ Done: the item
  number keys the retailer's name at confidence 1.0 with the household's own
  category when a human has set one, else a low-confidence heuristic guess — so
  a photographed Costco line resolves its name for free and asks the human for
  the category once. Store keys are retailer-canonical (`COSTCO WHSE` /
  `COSTCO WHOLESALE #1234` → `COSTCO`).
- ~~**One taxonomy.**~~ Done (`db/taxonomy.ts`, migration 0005; a Household
  category and household-goods classifier rules added). Per-household
  taxonomies remain a later option.
- **Classifier confidence → queue.** The heuristic classifier silently emits
  `Other`; give it a confidence signal so misclassifications surface for review,
  and add the LLM classifier behind the existing seam for items the rules miss.
- **Capture.** Mobile camera capture (`capture="environment"`), responsive
  layout, navigation between queue / true spend / upload, month picker.
- **Hygiene.** Next.js and React upgrades; cold-start time.

## Phase 3 — Dogfood

- Private deployment (separate from the public demo) with real bank `.xlsx`,
  Amazon CSV, Costco digital receipts, and receipt photos.
- Measure: minutes of review per week, % of line items auto-resolved,
  % of bank lines reconciled, dictionary hit rate over time.

## Later

- Multi-user: households, members, invites.
- **Bank connection: Plaid** (decided 2026-09-18; file imports stay for Amazon and Costco). Done so far: the sync core behind a `PlaidClient` port, accounts and transactions from a sandbox Item, encrypted tokens, `/banks`. Next: Link in the app (link token + public-token exchange), disconnect (`/item/remove`), tombstones for bank lines a sync removed under a human's match, webhook-driven or scheduled sync, ITEM_LOGIN_REQUIRED re-auth, and the production Plaid application.
- Email forwarding for order confirmations (`.eml` adapter exists as a seam).
- Additional retailers' digital receipts.
- Second module of the home platform (chores, calendars) once finance is solid.

## Follow-ups from the AI SDK pivot (PR #29)

- ~~**Re-extract.**~~ Done: "Read again" on unreadable receipts
  (`POST /api/receipts/[receiptId]/reextract`); a failed re-read writes nothing.
- **Spend guardrails.** ~~Budget~~ set: the private project has a $25/month AI
  Gateway budget. Still open: record `usage` (incl. cached input tokens) per
  upload so the prompt-cache breakpoint is measured, not assumed.
- **Eval margin.** The fixture eval passes at exactly 80%; the misses are naming
  variants ("Costco Rotisserie Chicken", "HDMI Cable 6ft", "Men's T-Shirt").
  Grade on the real Costco export before tuning the prompt further.

## Real-data eval (2026-09-17, Costco export)

Command, run from the repo root with a pulled `VERCEL_OIDC_TOKEN` in `.env.local`:

```bash
RECEIPT_EVAL_NAME_MODE=identity RECEIPT_EVAL_DIR=data/costco/eval npm run vision:eval
```

What the numbers are, and are not:

- **Item numbers read off the photo** is the metric the product depends on: a
  read item number resolves from the household's dictionary (bootstrapped from
  the digital export, then from human answers) with no model naming at all. It
  is a multiset count over the receipt's numbers (a duplicated number needs as
  many extracted lines); a number attached to the wrong line's text is caught
  by the name grade, not here. The precision side is reported alongside
  (extracted numbers matching no expected line).
- **Naming** here is the model alone, with an **empty dictionary** — the
  harness has no dictionary-primed mode yet — graded on the name only, because
  Costco's export carries no categories (the fixture eval's "and exact
  category" half is never exercised on this data). In `identity` mode the
  appended pack-size segments are stripped from both sides first; a wrong
  product is still wrong.
- The 80% bar is asserted only for the committed fixture sample in `full`
  mode, where it was calibrated. A real-data run prints the report and passes.
- `RECEIPT_EVAL_LIMIT` takes a deterministic evenly spaced sample — fine for a
  smoke, but a few large receipts dominate a small sample (in the 15-receipt
  smoke, three receipts held 29 of 62 lines). Quote the full directory.

Results are appended below as they are measured.

- 2026-09-17, 15 of 78 receipts (62 lines, smoke, first normaliser): item
  numbers read 60/62, totals 15/15, unaided naming 9/62.
- 2026-09-18, **all 78 receipts (272 lines)**, harness at PR #32: item numbers
  read on their own line **246/272 (90.4%)**; 76 extracted numbers matched no
  expected line — many are the instant-savings and fee lines the ground truth
  deliberately folds away, so this is an upper bound on mis-reads, not a
  count of them; totals **77/78** (the miss is a return receipt read as
  +$71.24 instead of −$71.24: returns need a sign rule); unaided naming
  **81/272 (29.8%)**. Cost of the run: about $6 of gateway credit.
- Findings to act on: (1) returns — a receipt whose lines are all refunds must
  carry a negative total, and the reconciler must expect it; (2) the 26 unread
  item numbers are worth a look by receipt (are they damaged prints, or a
  layout the extraction prompt misreads?); (3) the dictionary-primed path is
  what to measure next.
