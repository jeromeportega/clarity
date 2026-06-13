import { readdirSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_RECEIPT_CONFIG } from '../config';
import { isCorrectlyResolved } from '../resolver/similarity';
import type { Resolution } from '../resolver/sku-resolver';
import { isSupportedMimeType, type SupportedMimeType } from '../vision/vision-provider';

// =============================================================================
// Pure (mostly I/O-free) helpers for the key-gated accuracy harness (FR-18).
//
// Kept out of the *.eval.test.ts file so the grading logic, the key gate, and
// the receipt-discovery glue can all be unit-tested in the DEFAULT offline gate
// (no key, no network). The live harness imports these and adds only the live
// `processReceipt` calls behind the key gate.
// =============================================================================

// The accuracy bar: at least 80% of expected line items must resolve correctly.
// A single threshold over the whole sample — never a per-item exact-string match.
export const EVAL_PASS_FRACTION = 0.8;

// At least this many sanitized receipts must run end-to-end under the harness.
export const MIN_EVAL_RECEIPTS = 5;

// The committed synthetic sample. The operator overrides it with RECEIPT_EVAL_DIR
// to point at the real (sanitized) receipt kit.
export const DEFAULT_EVAL_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'eval',
);

// The expected record sitting beside each receipt file (epic contract §9).
export interface ExpectedItem {
  sku: string | null;
  name: string;
  category: string;
}
export interface ExpectedReceipt {
  store: string | null;
  items: ExpectedItem[];
  totalCents: number;
}

// The slice of a resolved ReceiptItemRecord the grader needs (categoryId is the
// taxonomy member; mapped to `category` here so grading is store-shape-agnostic).
export interface GradedItem {
  sku: string | null;
  canonicalName: string | null;
  category: string | null;
}

// The eval suite runs only when an Anthropic key is present; otherwise it SKIPS
// (never fails — ADR-006), keeping the default gate offline.
export function evalKeyPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.trim());
}

// The receipt directory to grade: operator override, else the committed sample.
export function resolveEvalDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.RECEIPT_EVAL_DIR?.trim();
  return override ? override : DEFAULT_EVAL_DIR;
}

// The Sørensen–Dice match ratio for canonical names (default 0.85, configurable
// via env per NFR-3 / the shared config default).
export function resolveEvalRatio(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.RECEIPT_EVAL_RATIO?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : DEFAULT_RECEIPT_CONFIG.similarityRatio;
}

export function mimeTypeForFile(file: string): SupportedMimeType | null {
  const ext = extname(file).toLowerCase();
  const mime =
    ext === '.jpg' || ext === '.jpeg'
      ? 'image/jpeg'
      : ext === '.png'
        ? 'image/png'
        : ext === '.pdf'
          ? 'application/pdf'
          : null;
  return mime && isSupportedMimeType(mime) ? mime : null;
}

// The sibling expected-record path for a receipt file (`foo.pdf` -> `foo.expected.json`).
export function expectedPathFor(receiptFile: string): string {
  const ext = extname(receiptFile);
  return `${receiptFile.slice(0, receiptFile.length - ext.length)}.expected.json`;
}

// Every gradeable receipt file in `dir` (a supported image/pdf with a sibling
// expected record), sorted for deterministic ordering. `.expected.json` files
// are companions, never receipts themselves.
export function discoverReceipts(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => !name.endsWith('.expected.json'))
    .map((name) => join(dir, name))
    .filter((path) => mimeTypeForFile(path) !== null)
    .sort();
}

function asResolution(item: GradedItem): Resolution {
  // Confidence/source are irrelevant to correctness grading — only the canonical
  // name and category are compared — so they are filled with neutral values.
  return {
    canonicalName: item.canonicalName ?? '',
    category: item.category ?? '',
    nameConfidence: 1,
    categoryConfidence: 1,
    source: 'auto',
  };
}

// Match an expected item to a resolved one: prefer an exact SKU match (order is
// not guaranteed when SKUs are present), else fall back to positional order.
function pickActual(actual: GradedItem[], expected: ExpectedItem, index: number): GradedItem | undefined {
  if (expected.sku) {
    const bySku = actual.find((a) => a.sku !== null && a.sku === expected.sku);
    if (bySku) return bySku;
  }
  return actual[index];
}

// Count how many EXPECTED items were correctly resolved (canonical-name Dice
// ratio >= `ratio` AND exact category equality, via `isCorrectlyResolved`). The
// denominator is the expected count, so a missed/extra actual item lowers the
// score rather than being silently ignored.
export function gradeReceipt(
  actual: GradedItem[],
  expected: ExpectedItem[],
  ratio: number,
): { correct: number; total: number } {
  let correct = 0;
  for (let i = 0; i < expected.length; i++) {
    const match = pickActual(actual, expected[i], i);
    if (
      match &&
      isCorrectlyResolved(asResolution(match), { name: expected[i].name, category: expected[i].category }, ratio)
    ) {
      correct++;
    }
  }
  return { correct, total: expected.length };
}

// The single threshold assertion's predicate: the correctly-resolved fraction
// across the whole sample is at or above the pass bar.
export function meetsThreshold(correct: number, total: number, fraction = EVAL_PASS_FRACTION): boolean {
  return total > 0 && correct / total >= fraction;
}
