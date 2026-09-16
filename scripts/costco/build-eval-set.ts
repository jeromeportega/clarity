/**
 * Turn captured Costco receipt images + the member's WarehouseReceiptDetail
 * JSON export into a vision-eval set the existing key-gated harness can grade:
 *
 *   npx tsx scripts/costco/build-eval-set.ts \
 *       --manifest data/costco/receipts/manifest.json \
 *       --json ~/Repos/receipts/costco-receipts.json \
 *       --out data/costco/eval
 *   RECEIPT_EVAL_DIR=data/costco/eval npm run vision:eval
 *   # cheap smoke (an evenly spaced sample): RECEIPT_EVAL_LIMIT=5 RECEIPT_EVAL_DIR=data/costco/eval npm run vision:eval
 *
 * For every manifest entry that pairs with a JSON receipt it copies the PNG
 * into --out and writes the sibling `<name>.expected.json` the harness
 * expects: `{ store, items: [{ sku, name, category: null }], totalCents }`.
 *
 * Pairing never depends on record order. The parser stamps every receipt with
 * `sourceHash = sha256("costco:" + transactionBarcode)`; a warehouse capture
 * carries the barcode, a gas capture carries the printed Invoice#, and the
 * export maps invoice → barcode. Both resolve to the hash.
 *
 * Ground truth comes from the same parser the ingest path uses
 * (`parseCostcoReceipts`), so the expected line items follow the product's own
 * rules: savings lines are folded (not items), fee lines (CRV etc.) are
 * excluded — the vision path is graded on products — and lines Costco itself
 * cannot name (ALL-CAPS echoes) are excluded because there is no canonical
 * name to grade against. `category` is null: Costco's export carries no
 * classification, so items are graded on the canonical name alone.
 *
 * Everything here is real financial data and lives under data/ (gitignored).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { FEE_NAMES, parseCostcoReceipts } from '../../modules/finance/core/adapters/costco/parse';
import { sha256Hex } from '../../modules/finance/core/idempotency/keys';
import type { NormalizedReceipt } from '../../modules/finance/core/model/normalized';

export interface ManifestEntry {
  barcode: string | null;
  invoice: string | null;
  kind: 'receipt' | 'return';
  layout?: 'warehouse' | 'gas';
  date: string;
  file: string;
}

export interface ExpectedItem {
  sku: string | null;
  name: string;
  category: null;
}

export interface ExpectedReceipt {
  store: string | null;
  items: ExpectedItem[];
  totalCents: number;
}

export interface EvalEntry {
  /** Filename base (no extension) shared by the image and its expected record. */
  base: string;
  /** Manifest-relative path of the source image. */
  file: string;
  expected: ExpectedReceipt;
}

export interface EvalSetStats {
  written: number;
  unpaired: number;
  skippedEmpty: number;
  expectedItems: number;
  parseErrors: number;
}

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

/** sha256("costco:" + barcode) — the same key the parser stamps on every receipt. */
function hashFor(barcode: string): string {
  return sha256Hex(`costco:${barcode}`);
}

/** Gas receipts print an Invoice#, not a barcode; the export maps one to the other. */
function invoiceToBarcode(exportText: string): Map<string, string> {
  const raw = JSON.parse(exportText.replace(/^﻿/, '')) as unknown;
  const records = Array.isArray(raw) ? raw : [];
  const map = new Map<string, string>();
  for (const rec of records) {
    if (typeof rec !== 'object' || rec === null) continue;
    const r = rec as Record<string, unknown>;
    const barcode = typeof r.transactionBarcode === 'string' ? r.transactionBarcode : null;
    const invoice = r.invoiceNumber;
    const isGas = typeof r.receiptType === 'string' && /gas/i.test(r.receiptType);
    if (barcode && isGas && invoice !== null && invoice !== undefined) map.set(String(invoice), barcode);
  }
  return map;
}

export function expectedFor(receipt: NormalizedReceipt): ExpectedReceipt {
  const items: ExpectedItem[] = receipt.items
    .filter((i) => i.canonicalName !== null && !FEE_NAMES.has(i.canonicalName))
    .map((i) => ({ sku: i.sku, name: i.canonicalName!, category: null }));
  return { store: receipt.store, items, totalCents: receipt.totalCents };
}

/** Pure: pair manifest entries with parsed receipts and build the expected records. */
export function buildEvalSet(manifest: ManifestEntry[], exportText: string): { entries: EvalEntry[]; stats: EvalSetStats } {
  const { receipts, errors } = parseCostcoReceipts(exportText);
  const byHash = new Map(receipts.map((r) => [r.sourceHash, r] as const));
  const barcodeByInvoice = invoiceToBarcode(exportText);

  const entries: EvalEntry[] = [];
  const stats: EvalSetStats = { written: 0, unpaired: 0, skippedEmpty: 0, expectedItems: 0, parseErrors: errors.length };

  for (const entry of manifest) {
    const barcode = entry.barcode ?? (entry.invoice ? barcodeByInvoice.get(entry.invoice) : undefined);
    const receipt = barcode ? byHash.get(hashFor(barcode)) : undefined;
    if (!receipt) {
      stats.unpaired++;
      continue;
    }
    const expected = expectedFor(receipt);
    if (expected.items.length === 0) {
      stats.skippedEmpty++;
      continue;
    }
    const base = basename(entry.file).replace(/\.png$/i, '');
    entries.push({ base, file: entry.file, expected });
    stats.written++;
    stats.expectedItems += expected.items.length;
  }
  return { entries, stats };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = resolve(args.manifest);
  const outDir = resolve(args.out);
  mkdirSync(outDir, { recursive: true });

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ManifestEntry[];
  const exportText = readFileSync(resolve(args.json), 'utf8');
  const { entries, stats } = buildEvalSet(manifest, exportText);
  if (stats.parseErrors > 0) console.warn(`[eval-set] export had ${stats.parseErrors} unparseable record(s)`);

  let missingImages = 0;
  for (const entry of entries) {
    const src = resolve(dirname(manifestPath), entry.file);
    if (!existsSync(src)) {
      missingImages++;
      continue;
    }
    copyFileSync(src, join(outDir, `${entry.base}.png`));
    writeFileSync(join(outDir, `${entry.base}.expected.json`), `${JSON.stringify(entry.expected, null, 2)}\n`);
  }

  console.log(
    `[eval-set] wrote ${entries.length - missingImages} receipt(s) with ${stats.expectedItems} gradeable line item(s) to ${outDir}` +
      ` (unpaired: ${stats.unpaired}, skipped with no nameable items: ${stats.skippedEmpty}, missing images: ${missingImages})`,
  );
  console.log(`[eval-set] run: RECEIPT_EVAL_DIR=${args.out} npm run vision:eval`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
