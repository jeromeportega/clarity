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

- **Queue with context.** `QueueItem` is `{id, type, reason, amountCents?}`;
  carry candidates, merchant, date, receipt thumbnail/crop, and "why we're
  unsure" so each item is a one-tap decision. Replace free-text
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
- Bank connection (Plaid trial / Teller / SimpleFIN) instead of file export.
- Email forwarding for order confirmations (`.eml` adapter exists as a seam).
- Additional retailers' digital receipts.
- Second module of the home platform (chores, calendars) once finance is solid.

## Follow-ups from the AI SDK pivot (PR #29)

- **Re-extract.** An unreadable outcome is persisted and idempotent on the image
  hash, so a one-off refusal or malformed answer is sticky until the row is
  removed. Add an explicit "read again" action for zero-item `needs_review` receipts.
- **Spend guardrails.** Set an AI Gateway budget for the private project
  (`vercel ai-gateway budgets`), and record `usage` (incl. cached input tokens)
  per upload so the prompt-cache breakpoint is measured, not assumed.
- **Eval margin.** The fixture eval passes at exactly 80%; the misses are naming
  variants ("Costco Rotisserie Chicken", "HDMI Cable 6ft", "Men's T-Shirt").
  Grade on the real Costco export before tuning the prompt further.
