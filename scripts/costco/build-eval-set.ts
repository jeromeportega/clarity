/**
 * Turn captured Costco receipt images + the member's WarehouseReceiptDetail
 * JSON export into a vision-eval set the existing key-gated harness can grade:
 *
 *   npx tsx scripts/costco/build-eval-set.ts \
 *       --manifest data/costco/receipts/manifest.json \
 *       --json ~/Repos/receipts/costco-receipts.json \
 *       --out data/costco/eval
 *   RECEIPT_EVAL_DIR=data/costco/eval npm run vision:eval
 *   # cheap smoke: RECEIPT_EVAL_LIMIT=5 RECEIPT_EVAL_DIR=data/costco/eval npm run vision:eval
 *
 * For every manifest entry that pairs with a JSON receipt (warehouse receipts
 * by transactionBarcode, gas receipts by invoiceNumber) it copies the PNG into
 * --out and writes the sibling `<name>.expected.json` the harness expects:
 * `{ store, items: [{ sku, name, category: null }], totalCents }`.
 *
 * Ground truth comes from the same parser the ingest path uses
 * (`parseCostcoReceipts`), so the expected line items follow the product's own
 * rules: savings lines are folded (not items), fee lines (CRV etc.) are
 * excluded — the vision path is graded on products, and lines Costco itself
 * cannot name (ALL-CAPS echoes) are excluded because there is no canonical
 * name to grade against. `category` is null: Costco's export carries no
 * classification, so items are graded on the canonical name alone.
 *
 * Everything here is real financial data and lives under data/ (gitignored).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { parseCostcoReceipts } from '../../modules/finance/core/adapters/costco/parse';
import type { NormalizedReceipt } from '../../modules/finance/core/model/normalized';

interface ManifestEntry {
  barcode: string | null;
  invoice: string | null;
  kind: 'receipt' | 'return';
  layout: 'warehouse' | 'gas';
  date: string;
  file: string;
}

interface ExpectedItem {
  sku: string | null;
  name: string;
  category: null;
}

interface ExpectedReceipt {
  store: string | null;
  items: ExpectedItem[];
  totalCents: number;
}

const FEE_NAMES = new Set(['California Redemption Value (CRV)', 'Bottle deposit', 'Bag fee']);

function parseArgs(argv: string[]): { manifest: string; json: string; out: string } {
  const args = { manifest: 'data/costco/receipts/manifest.json', json: '', out: 'data/costco/eval' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    if (a === '--manifest') args.manifest = next();
    else if (a === '--json') args.json = next();
    else if (a === '--out') args.out = next();
    else throw new Error(`unknown argument ${a}`);
  }
  if (!args.json) throw new Error('--json <WarehouseReceiptDetail export> is required');
  return args;
}

/** Index parsed receipts by the identifiers the manifest carries. */
function indexReceipts(text: string): { byBarcode: Map<string, NormalizedReceipt>; byInvoice: Map<string, NormalizedReceipt>; errors: number } {
  const raw = JSON.parse(text.replace(/^﻿/, '')) as Array<Record<string, unknown>>;
  const { receipts, errors } = parseCostcoReceipts(text);
  // parseCostcoReceipts keeps only a hash of the barcode; re-derive the
  // barcode/invoice → receipt mapping from the raw records in order.
  const byBarcode = new Map<string, NormalizedReceipt>();
  const byInvoice = new Map<string, NormalizedReceipt>();
  let i = 0;
  for (const rec of raw) {
    const barcode = typeof rec.transactionBarcode === 'string' ? rec.transactionBarcode : null;
    if (!barcode) continue; // the parser rejects these too, keeping indexes aligned
    const parsed = receipts[i++];
    if (!parsed) break;
    byBarcode.set(barcode, parsed);
    const invoice = rec.invoiceNumber;
    if (invoice !== null && invoice !== undefined) byInvoice.set(String(invoice), parsed);
  }
  return { byBarcode, byInvoice, errors: errors.length };
}

function expectedFor(receipt: NormalizedReceipt): ExpectedReceipt {
  const items: ExpectedItem[] = receipt.items
    .filter((i) => i.canonicalName !== null && !FEE_NAMES.has(i.canonicalName))
    .map((i) => ({ sku: i.sku, name: i.canonicalName!, category: null }));
  return { store: receipt.store, items, totalCents: receipt.totalCents };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = resolve(args.manifest);
  const outDir = resolve(args.out);
  mkdirSync(outDir, { recursive: true });

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ManifestEntry[];
  const { byBarcode, byInvoice, errors } = indexReceipts(readFileSync(resolve(args.json), 'utf8'));
  if (errors > 0) console.warn(`[eval-set] export had ${errors} unparseable record(s)`);

  let written = 0;
  let unpaired = 0;
  let skippedEmpty = 0;
  let expectedItems = 0;
  for (const entry of manifest) {
    const receipt = entry.barcode ? byBarcode.get(entry.barcode) : entry.invoice ? byInvoice.get(entry.invoice) : undefined;
    if (!receipt) {
      unpaired++;
      continue;
    }
    const expected = expectedFor(receipt);
    if (expected.items.length === 0) {
      skippedEmpty++;
      continue;
    }
    const src = resolve(dirname(manifestPath), entry.file);
    if (!existsSync(src)) {
      unpaired++;
      continue;
    }
    const base = basename(entry.file).replace(/\.png$/i, '');
    copyFileSync(src, join(outDir, `${base}.png`));
    writeFileSync(join(outDir, `${base}.expected.json`), `${JSON.stringify(expected, null, 2)}\n`);
    written++;
    expectedItems += expected.items.length;
  }

  console.log(
    `[eval-set] wrote ${written} receipt(s) with ${expectedItems} gradeable line item(s) to ${outDir}` +
      ` (unpaired: ${unpaired}, skipped with no nameable items: ${skippedEmpty})`,
  );
  console.log(`[eval-set] run: RECEIPT_EVAL_DIR=${args.out} npm run vision:eval`);
}

main();
