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

- **Persist uploads.** The upload route uses in-memory stub store/dictionary;
  swap in the existing `LibSqlReceiptStore` / `LibSqlSkuDictionary` so
  receipts, items, and learned SKUs survive the request. Fix the
  unreadable-receipt insert (`store`/`purchasedAt`/`totalCents` are `NOT NULL`).
- **Reconcile at runtime.** Implement `DrizzleReconcileSource.load` and run
  `reconcile()` after every upload/ingest (or on demand), persisting via
  `DrizzleReconcileSink`. Make `RECON_BACKEND=live` the default; retire the
  stub gateway to tests.
- **Corrections that apply.** `pickCategoryId` must write `receipt_items.category_id`;
  `pickMatchCandidateId` must write `matches`; every decision clears
  `needs_review`; `recomputeRollups` must actually recompute.
- **Render the queue actions.** `QueueItemActions` and `CorrectionDialog` exist
  but are never rendered; wire them into the home page.
- **Evidence image route.** `/api/receipts/image/[id]` is linked from evidence
  but doesn't exist; store receipt images durably (not `/tmp`) and serve them.
- **Real login.** Single-user auth for the household operator; derive
  `household_id` from the session in one place (`resolveHouseholdScope`) and
  remove the inline `DEMO_HOUSEHOLD_ID` call sites.
- **Tenancy columns now, while the schema is young.** `household_id` on
  `sku_dictionary`, `categories`, and `matches`; FK on `review_decisions`.
- **Costco digital receipts as a first-class source.** Costco's own
  `WarehouseReceiptDetail` export carries item number, abbreviated description,
  **canonical product name**, department, price, tax flag, instant savings, and
  tender for every in-warehouse purchase. Add an adapter for it: it is both a
  Tier-2 ingestion source (no photo needed) and labeled ground truth for the
  SKU resolver and the vision eval.

## Phase 2 — Make the loop great

- **Queue with context.** `QueueItem` is `{id, type, reason, amountCents?}`;
  carry candidates, merchant, date, receipt thumbnail/crop, and "why we're
  unsure" so each item is a one-tap decision. Replace free-text
  "match candidate ID" with a picker.
- **Per-receipt batch resolution.** Today each line item is one model call with
  no receipt context; resolve a whole receipt in one call with store, date,
  department numbers, and neighboring items as context. Cheaper and more accurate.
- **Bootstrap the dictionary** from Costco canonical names.
- **One taxonomy.** Unify `DEFAULT_CATEGORIES` (10, lowercase) and
  `H1_TAXONOMY` (20, Title Case); make it per-household.
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
