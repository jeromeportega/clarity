import { readdirSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
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
// Calibrated on the committed fixture sample in `full` name mode; a run over any
// other directory or mode is a measurement, not a gate (see `isGatedRun`).
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

// How canonical names are compared. `full`: the name as written on both sides
// (a retailer's catalogue name carries pack size — "…, 4.5 oz, 12-count").
// `identity`: the pack-size segments a catalogue APPENDS to a name are stripped
// from BOTH sides before comparing, which is what the resolver is asked to
// produce (the size lives in its own fields) and what a dictionary keyed by
// item number needs. Only appended segments go: a number inside the head of
// the name ("10-Gallon Wastebasket Liner", "Diapers Size 2", "Omega-3 1000 mg",
// "HDMI Cable 6ft", "65 inch TV") is the product's identity and stays.
export type EvalNameMode = 'full' | 'identity';

export function resolveEvalNameMode(env: NodeJS.ProcessEnv = process.env): EvalNameMode {
  return env.RECEIPT_EVAL_NAME_MODE?.trim().toLowerCase() === 'identity' ? 'identity' : 'full';
}

// The 80% bar means something only for the sample it was calibrated on, graded
// the way it was calibrated. Anything else is a measurement run: report, never assert.
export function isGatedRun(dir: string, mode: EvalNameMode): boolean {
  return resolve(dir) === resolve(DEFAULT_EVAL_DIR) && mode === 'full';
}

// Pack, weight, volume and container nouns — never dimensions (in, ft, gal)
// or doses (mg, mcg, IU), which name a different product rather than a
// different pack.
const UNITS =
  '(?:fl\\s*oz|oz|ounces?|lbs?|pounds?|g|kg|ml|l|liters?|litres?|qt|quarts?|pt|pints?|' +
  'ct|count|pk|packs?|pcs?|pieces?|rolls?|sheets?|bars?|pods?|tabs?|tablets?|capsules?|softgels?|gummies|' +
  'servings?|loads?|ply|bottles?|cans?|wipes?|gloves?|bags?|pouches?|cups?|sticks?|units?|each|ea)';
// A comma-separated segment that is a size and nothing else: "4.5 oz",
// "12-count", "2 x 1 lb", "12 Individually Wrapped Rolls", "3-piece Set",
// "1750 count", "150 Softgels" — optionally followed by a couple of words.
const SIZE_SEGMENT = new RegExp(
  `^\\d+(?:[.,/]\\d+)?\\s*(?:x\\s*\\d+(?:[.,/]\\d+)?\\s*)?-?\\s*(?:[a-z]+\\s+){0,2}?${UNITS}\\b\\.?(?:\\s+[a-z]+){0,2}$`,
  'i',
);
// "Per Lb" / "per oz" / "per each" on weighed items, anywhere in the name.
const PER_UNIT = /,?\s*\bper\s+(?:lb|lbs|oz|kg|g|each|ea)\b\.?/gi;
// A parenthetical that is a size: "(4 x 1 lb packs)", "(2-pack)".
const SIZE_PAREN = /\s*\(\s*\d[^)]*\)/g;
// A trailing size on the head of the name, without a comma: "… Tennessee 1L",
// "WD-40 11 oz", "Salmon 1 lb each". Only a closed set of pack words may
// follow the unit — any word would eat the product noun when a size sits
// mid-name ("3 lb Ground Coffee").
const TRAILING_SIZE = new RegExp(
  `\\s+\\d+(?:[.,/]\\d+)?\\s*-?\\s*${UNITS}\\b\\.?(?:\\s+(?:each|ea|packs?|bags?|box|tub|jar|avg\\s+wt))?$`,
  'i',
);

/** The product identity in a catalogue name: the name without its appended pack-size segments. */
export function identityName(name: string): string {
  const withoutParens = name.replace(SIZE_PAREN, ' ').replace(PER_UNIT, ' ');
  const segments = withoutParens
    .split(',')
    .map((seg) => seg.replace(/\s{2,}/g, ' ').trim())
    .filter((seg) => seg.length > 0);
  if (segments.length === 0) return name.trim();
  const [head, ...rest] = segments;
  const kept = [head!.replace(TRAILING_SIZE, '').trim(), ...rest.filter((seg) => !SIZE_SEGMENT.test(seg))];
  const out = kept
    .filter((seg) => seg.length > 0)
    .join(', ')
    .replace(/\s+([,.])/g, '$1')
    .trim();
  // Never grade against nothing: a name that was all size ("12 ct", "2 x 1 lb")
  // keeps its full form.
  return /[a-z]{2,}/i.test(out) ? out : name.trim();
}

function gradingName(name: string, mode: EvalNameMode): string {
  return mode === 'identity' ? identityName(name) : name;
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

// Item numbers as printed vs as read: whitespace and leading zeros are not identity.
function normalizeSku(sku: string): string {
  return sku.trim().replace(/^0+(?=\d)/, '');
}

// Match an expected item to a not-yet-claimed resolved one: an exact SKU match
// wins; otherwise the unclaimed item whose canonical name is most similar.
// Never positional — the extracted list may carry rows the reference does not
// (a separate instant-savings line, a fee line the ground truth excludes), and
// a positional fallback would shift every later match by one.
function pickActual(actual: GradedItem[], claimed: Set<number>, expected: ExpectedItem, mode: EvalNameMode = 'full'): number | undefined {
  if (expected.sku) {
    const want = normalizeSku(expected.sku);
    const bySku = actual.findIndex((a, i) => !claimed.has(i) && a.sku !== null && normalizeSku(a.sku) === want);
    if (bySku >= 0) return bySku;
  }
  let best: number | undefined;
  let bestScore = -1;
  actual.forEach((a, i) => {
    if (claimed.has(i)) return;
    const score = similarityRatio(gradingName(a.canonicalName ?? '', mode), gradingName(expected.name, mode));
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}

/** One pairing shared by every metric: each expected item and the extracted line matched to it, if any. */
export interface Pairing {
  expected: ExpectedItem;
  actual: GradedItem | null;
}
export function pairItems(actual: GradedItem[], expected: ExpectedItem[], mode: EvalNameMode = 'full'): Pairing[] {
  const claimed = new Set<number>();
  return expected.map((exp) => {
    const idx = pickActual(actual, claimed, exp, mode);
    if (idx === undefined) return { expected: exp, actual: null };
    claimed.add(idx);
    return { expected: exp, actual: actual[idx]! };
  });
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
  mode: EvalNameMode = 'full',
): { correct: number; total: number } {
  // One pairing, one verdict: the score is what is left after the misses.
  return { correct: expected.length - explainMisses(actual, expected, ratio, mode).length, total: expected.length };
}

// Item numbers, counted over the shared pairing. Because pairing is
// number-first, `read` is a MULTISET count of the receipt's numbers (a number
// duplicated on the receipt needs as many extracted lines): it says the
// number was read, not that it landed on the right line — a number attached
// to the wrong line's text is caught by the name grade, not here. `read` is
// recall over expected items that have a number; `unexpected` is the
// precision side — extracted numbers that belong to no expected line
// (mis-read digits, invented numbers, over-extraction).
export interface SkuReadStats {
  read: number;
  withSku: number;
  unexpected: number;
  extractedWithSku: number;
}
export function countSkuReads(actual: GradedItem[], expected: ExpectedItem[], mode: EvalNameMode = 'full'): SkuReadStats {
  const pairs = pairItems(actual, expected, mode);
  const withSku = pairs.filter((p) => p.expected.sku !== null);
  const read = withSku.filter((p) => p.actual?.sku != null && normalizeSku(p.actual.sku) === normalizeSku(p.expected.sku!)).length;
  const expectedSkus = new Set(expected.filter((e) => e.sku !== null).map((e) => normalizeSku(e.sku!)));
  const extracted = actual.filter((a) => a.sku !== null);
  const unexpected = extracted.filter((a) => !expectedSkus.has(normalizeSku(a.sku!))).length;
  return { read, withSku: withSku.length, unexpected, extractedWithSku: extracted.length };
}

// The misses behind a gradeReceipt score, for the operator's eyes: which
// expected item was not resolved, and what the pipeline produced for it
// (or nothing, when no line could be paired with it). Same pairing as the grade.
export interface EvalMiss {
  expected: ExpectedItem;
  actual: GradedItem | null;
}
export function explainMisses(actual: GradedItem[], expected: ExpectedItem[], ratio: number, mode: EvalNameMode = 'full'): EvalMiss[] {
  const misses: EvalMiss[] = [];
  for (const { expected: exp, actual: got } of pairItems(actual, expected, mode)) {
    if (got === null) {
      misses.push({ expected: exp, actual: null });
      continue;
    }
    const resolution = asResolution(got);
    const graded = { ...resolution, canonicalName: gradingName(resolution.canonicalName, mode) };
    if (!isCorrectlyResolved(graded, { name: gradingName(exp.name, mode), category: exp.category }, ratio)) {
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
// picks across the list covers the whole period and both layouts. It is a
// convenience sample for smoke runs, not a held-out split: tune against the
// full directory, not against it.
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
