# Data sources

How each kind of spending data can be obtained, what it contains, and what the code supports today. The guiding principle: **the bank is the backbone; item-level enrichment is progressive.** Nothing should require "connect everything or it's useless."

## Coverage tiers

| Tier | What | Friction | Coverage |
|---|---|---|---|
| **0 — universal capture** | Upload a receipt photo / PDF, an order CSV, or (planned) an `.eml`. Works for any retailer via the generic adapter + LLM disambiguation. | Per capture | Unlimited |
| **1 — the spine** | One bank / card connection (today: statement export; later: a live aggregator). The complete spend skeleton everything else reconciles against. | Once | Every dollar that touches the card |
| **2 — connect once per retailer** | A retailer's own export or digital receipts (Amazon order history, Costco digital receipts). After setup, item detail flows without photographing receipts. | Once per retailer | That retailer's items |

Graceful degradation: with only Tier 1, spending is classified at the merchant level (bank-line keyword fallback). Each Tier 0/2 source upgrades the lines it can explain to item-level.

### The returns wrinkle

Refunds to store credit, gift card balance, or a retailer account balance (Costco Shop Card, Amazon balance) never touch the bank. A bank-only view therefore **undercounts returns and overstates net spend**. Item-level sources are what make net spend correct: a return row with a non-card refund destination accrues to the `store_credit_balances` ledger, and later purchases paid partly from that balance are reconciled against it rather than flagged as unexplained gaps.

## Per source

### Bank transactions

**How to get the data**

- **Statement export (supported now).** Most banks export Excel (`.xlsx`) or PDF; some export CSV. Excel is the reliable path — structured, parsed deterministically. Typical card-style export columns: `Posted Date, Reference Number, Payee, Address, Amount` with a single signed amount.
- **PDF statements** are not parsed today. They could ride the same vision pipeline as receipts, but table layouts are fragile; treat as a bonus, not the critical path.
- **Live connections (later):**
  - **Plaid** — free trial tier (real production data, up to 10 items, $0); instant sandbox. Best brand recognition.
  - **Teller** — 100 free live connections, indie-friendly; access method can break on bank changes, so keep a fallback.
  - **SimpleFIN Bridge** — ~$15/yr, read-only, daily refresh; purpose-built for personal-finance tools and the cheapest durable option.

**What the code supports today:** `.xlsx`, `.xls`, `.csv` via `modules/finance/core/adapters/bank/` — header-row auto-detection (preamble rows are skipped), Excel serial dates with the 1900 leap-year guard, signed cents, merchant cleanup (store numbers and processor reference tails stripped), per-row content hash for idempotent re-import. Import via `POST /api/ingest/bank` (multipart `file` + `accountId`) or `tsx modules/finance/scripts/ingest.ts bank <file> --account <id>`. **No live bank connection exists.**

### Amazon order history

**How to get the data**

There is no consumer order API (SP-API is sellers-only and, as of 2026, costs roughly $1,400/yr plus per-call fees; PA-API is affiliate product data; Knot-style linking APIs are enterprise B2B). The self-serve route is **Amazon Privacy Central → "Request My Data" → Your Orders**, which yields `Retail.OrderHistory.N.csv` (usually within hours). It is **per-item, per-shipment**, which is exactly what is needed to match Amazon's per-shipment card charges. Useful columns: `Order ID`, `Order Date`, `Ship Date`, `Unit Price`, `Shipping Charge`, `Total Owed` / `Total Amount`, `Shipment Item Subtotal` (+ tax), `Payment Instrument Type` / `Payment Method Type`, `Shipment Status`, `ASIN`, `Product Name`, `Quantity`. There is **no category column** — classification is this product's value-add. The export also contains PII (billing/shipping addresses, gift recipient, item serial numbers); those columns are never read.

Returns and refunds come in companion CSVs and as negative rows; the refund destination (card vs. gift card / store credit / account balance) is in the payment method column.

**What the code supports today:** `modules/finance/core/adapters/amazon/` parses the order-history CSV into orders → shipments → line items with signed amounts, `is_return`, and `refund_destination`; non-card refunds accrue to the store-credit ledger on import. Import via `POST /api/ingest/orders` or `tsx modules/finance/scripts/ingest.ts orders <file.csv>`. Split-shipment matching against bank charges is implemented in the reconciliation engine (`reconcile/match/amazon.ts`).

### Costco (and other big-box warehouse stores)

**How to get the data**

- **Digital path.** costco.com → *Orders & Returns* → *In-Warehouse* shows itemized receipts for several years; members can opt into digital receipts at checkout. The page is fed by Costco's receipt API, whose `WarehouseReceiptDetail` records are far richer than the printed receipt: per line, the item number, the abbreviated description exactly as printed (`itemDescription01/02`), **the canonical product name (`itemActualName`)**, department number, unit price, tax flag, and often a product image URL; per receipt, warehouse, timestamp, subtotal, tax, total, instant savings, coupons, and tender. Refund receipts, gas-station receipts, and instant-savings lines (negative rows referencing another line's item number) are all present. Saved as JSON, this is both a photo-free item-level source and a **labeled ground-truth set** for the SKU resolver and the vision eval. It also carries membership number and masked card data — never commit it.
- **Photo / PDF path (the differentiator).** Photograph the thermal receipt, or save the digital receipt as a PDF, and let vision extract item numbers + abbreviated names + prices. Abbreviations like `KS ORG EVOO` or `ORG SPRING MIX` are resolved to canonical product names and categories by the LLM resolver, with a persistent per-store dictionary so each abbreviation is resolved once and learned. No clean public Costco item-number → name database exists; disambiguation leans on the model plus what the household confirms.

**What the code supports today:** the saved `WarehouseReceiptDetail` JSON via `POST /api/ingest/costco` or `tsx modules/finance/scripts/ingest.ts costco <file.json>` (`modules/finance/core/adapters/costco/`): each receipt lands in `receipts` / `receipt_items` with Costco's canonical product name at confidence 1, instant-savings lines folded into the item they discount, CRV lines kept as named fee items, refund receipts negative with the refund destination taken from the tender, gas receipts as `COSTCO GAS`; lines Costco itself cannot name are flagged for the review queue. Only a card tender's last four digits are kept; membership and account numbers are never read. Every named line also teaches the SKU dictionary under its item number (`learnFromDigitalReceipts`), so a photographed Costco receipt whose item numbers vision reads resolves those items with no model call and only asks the human for a category the first time. Today these rows reach the review queue; rollups and bank matching need the Phase 1 wiring (see `ARCHITECTURE.md` → Current gaps). Also JPEG, PNG and PDF receipts via `POST /api/receipts/upload` → `processReceipt`. Live Claude vision extraction (store, date, totals, tax, fees, per-line SKU / raw description / quantity / unit price / signed line price / discount), arithmetic validation against the printed total, dictionary-first SKU resolution with confidence gating. The eval harness ships with five sample Costco PDFs. See `docs/ARCHITECTURE.md` for what is and isn't persisted on the live path.

### Order confirmation emails

**How to get the data**

Exported `.eml` files, not a live mailbox. Gmail's API in "Testing" mode revokes refresh tokens after 7 days for external users, and the restricted Gmail scopes require Google's CASA security review to reach production — weeks of effort and cost. Live Gmail OAuth is therefore the wrong first integration for an early product; exporting the relevant emails as files gives the same data with no auth fragility. A "forward to an intake address" flow is the natural later step.

**What the code supports today:** `modules/finance/core/adapters/eml.adapter.ts` is a registered adapter slot that throws `NotImplementedError`. The `SourceAdapter` contract leaves room to add it without touching the pipeline.

### Retailer APIs (generic)

**What the code supports today:** `modules/finance/core/adapters/retailer-api.adapter.ts` is a registered slot that throws `NotImplementedError`. Nothing calls a retailer API.

## Receipt OCR fallbacks

If LLM vision underperforms on a class of receipts, purpose-built receipt OCR services can slot in behind the same `VisionProvider` interface:

- **Taggun** — inexpensive (~$4/mo tier), strong grocery line-item extraction.
- **Veryfi** — best-in-class accuracy, ~1 s per receipt, pre-trained; expensive (~$500/mo).
- **Mindee** — deep-learning line items; 14-day trial.

Claude vision remains the primary path (it also performs the disambiguation step OCR services do not); a fallback provider would be an accuracy hedge, selected per upload or per store.

## Support matrix

| Source | Format | Status |
|---|---|---|
| Bank statement | `.xlsx` / `.xls` / `.csv` | ✅ Supported |
| Bank statement | PDF | ❌ Not parsed |
| Bank | Live aggregator (Plaid / Teller / SimpleFIN) | ❌ Not built |
| Amazon order history | `Retail.OrderHistory.csv` | ✅ Supported (incl. returns + refund destination) |
| Receipts | JPEG / PNG / PDF | ✅ Extraction + resolution (persistence not yet wired on the live route) |
| Costco digital receipts | PDF | ✅ Via the receipt photo/PDF path |
| Costco digital receipts | `WarehouseReceiptDetail` JSON | ✅ `POST /api/ingest/costco` / `ingest costco <file.json>` — user-saved export, no scraper |
| Order emails | `.eml` | ❌ Adapter slot throws `NotImplemented` |
| Retailer API | — | ❌ Adapter slot throws `NotImplemented` |
