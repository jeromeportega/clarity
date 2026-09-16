import { readdirSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_RECEIPT_CONFIG } from '../config';
import { isCorrectlyResolved, similarityRatio } from '../resolver/similarity';
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

// The expected record sitting beside each receipt file. `category` may be null
// when the ground truth carries no category (e.g. a retailer's own digital
// receipt export, which names products but does not classify them); such items
// are graded on the canonical name alone.
export interface ExpectedItem {
  sku: string | null;
  name: string;
  category: string | null;
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

// The eval suite runs only when a live model call can be authenticated — an AI
// Gateway API key, or the Vercel OIDC token `vercel env pull` writes; otherwise
// it SKIPS (never fails — ADR-006), keeping the default gate offline.
export function evalKeyPresent(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.AI_GATEWAY_API_KEY?.trim() || env.VERCEL_OIDC_TOKEN?.trim());
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

// Match an expected item to a not-yet-claimed resolved one: an exact SKU match
// wins; otherwise the unclaimed item whose canonical name is most similar.
// Never positional — the extracted list may carry rows the reference does not
// (a separate instant-savings line, a fee line the ground truth excludes), and
// a positional fallback would shift every later match by one.
function pickActual(actual: GradedItem[], claimed: Set<number>, expected: ExpectedItem): number | undefined {
  if (expected.sku) {
    const bySku = actual.findIndex((a, i) => !claimed.has(i) && a.sku !== null && a.sku === expected.sku);
    if (bySku >= 0) return bySku;
  }
  let best: number | undefined;
  let bestScore = -1;
  actual.forEach((a, i) => {
    if (claimed.has(i)) return;
    const score = similarityRatio(a.canonicalName ?? '', expected.name);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}

// Count how many EXPECTED items were correctly resolved (canonical-name Dice
// ratio >= `ratio` AND exact category equality, via `isCorrectlyResolved`; when
// the expected category is null, the name alone decides). Each actual item can
// satisfy at most one expected item. The denominator is the expected count, so
// a missed/extra actual item lowers the score rather than being silently ignored.
export function gradeReceipt(
  actual: GradedItem[],
  expected: ExpectedItem[],
  ratio: number,
): { correct: number; total: number } {
  let correct = 0;
  const claimed = new Set<number>();
  for (const exp of expected) {
    const idx = pickActual(actual, claimed, exp);
    if (idx === undefined) continue;
    claimed.add(idx);
    if (isCorrectlyResolved(asResolution(actual[idx]!), { name: exp.name, category: exp.category }, ratio)) {
      correct++;
    }
  }
  return { correct, total: expected.length };
}

// The misses behind a gradeReceipt score, for the operator's eyes: which
// expected item was not resolved, and what the pipeline produced for it
// (or nothing, when no line could be paired with it). Same pairing as the grade.
export interface EvalMiss {
  expected: ExpectedItem;
  actual: GradedItem | null;
}
export function explainMisses(actual: GradedItem[], expected: ExpectedItem[], ratio: number): EvalMiss[] {
  const misses: EvalMiss[] = [];
  const claimed = new Set<number>();
  for (const exp of expected) {
    const idx = pickActual(actual, claimed, exp);
    if (idx === undefined) {
      misses.push({ expected: exp, actual: null });
      continue;
    }
    claimed.add(idx);
    const got = actual[idx]!;
    if (!isCorrectlyResolved(asResolution(got), { name: exp.name, category: exp.category }, ratio)) {
      misses.push({ expected: exp, actual: got });
    }
  }
  return misses;
}

// Optional cap on how many receipts a live run grades (RECEIPT_EVAL_LIMIT), for
// cheap smoke runs over a large real-data set. Unset or invalid ⇒ no cap.
export function resolveEvalLimit(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.RECEIPT_EVAL_LIMIT?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

// A deterministic, evenly spaced sample of a sorted list. Files sort by date
// (and gas receipts after warehouse ones on the same day), so taking the first
// N would always grade the oldest, warehouse-only receipts; spreading the
// picks across the list covers the whole period and both layouts.
export function sampleEvenly<T>(items: readonly T[], limit: number | null): T[] {
  if (limit === null || limit >= items.length) return [...items];
  if (limit <= 0) return [];
  const step = items.length / limit;
  const out: T[] = [];
  for (let i = 0; i < limit; i++) out.push(items[Math.floor(i * step)]!);
  return out;
}

// One vision call per receipt plus one resolver call per line item, with room
// for retries: budget the whole-sample timeout from both counts.
export function evalTimeoutMs(receipts: number, lineItems: number): number {
  return Math.max(180_000, receipts * 15_000 + lineItems * 5_000);
}

// The single threshold assertion's predicate: the correctly-resolved fraction
// across the whole sample is at or above the pass bar.
export function meetsThreshold(correct: number, total: number, fraction = EVAL_PASS_FRACTION): boolean {
  return total > 0 && correct / total >= fraction;
}
