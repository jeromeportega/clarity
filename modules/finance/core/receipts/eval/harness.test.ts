import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EVAL_DIR,
  EVAL_PASS_FRACTION,
  MIN_EVAL_RECEIPTS,
  discoverReceipts,
  evalKeyPresent,
  evalTimeoutMs,
  expectedPathFor,
  gradeReceipt,
  meetsThreshold,
  mimeTypeForFile,
  resolveEvalDir,
  resolveEvalLimit,
  resolveEvalRatio,
  sampleEvenly,
  type ExpectedReceipt,
  type GradedItem,
} from './harness';

// =============================================================================
// Default-gate (offline, no key) tests for the eval harness. These exercise the
// pure grading/discovery/gate logic and assert the project-level wiring that
// keeps the live accuracy harness isolated from `npm test` and E2E. The live
// ≥80% assertion itself lives in vision.eval.test.ts and runs ONLY under a key.
// =============================================================================

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');

describe('evalKeyPresent — the skip gate (FR-18, ADR-006)', () => {
  it('is false when ANTHROPIC_API_KEY is absent (eval SKIPS, never fails)', () => {
    expect(evalKeyPresent({})).toBe(false);
  });

  it('is false when the key is blank', () => {
    expect(evalKeyPresent({ ANTHROPIC_API_KEY: '   ' })).toBe(false);
  });

  it('is true when a key is set', () => {
    expect(evalKeyPresent({ ANTHROPIC_API_KEY: 'sk-ant-xxx' })).toBe(true);
  });
});

describe('resolveEvalDir / resolveEvalRatio (NFR-3 configurability)', () => {
  it('defaults to the committed sample dir', () => {
    expect(resolveEvalDir({})).toBe(DEFAULT_EVAL_DIR);
  });

  it('honors a RECEIPT_EVAL_DIR override', () => {
    expect(resolveEvalDir({ RECEIPT_EVAL_DIR: '/tmp/real-receipts' })).toBe('/tmp/real-receipts');
  });

  it('defaults the match ratio to 0.85', () => {
    expect(resolveEvalRatio({})).toBe(0.85);
  });

  it('honors a RECEIPT_EVAL_RATIO override and ignores garbage', () => {
    expect(resolveEvalRatio({ RECEIPT_EVAL_RATIO: '0.9' })).toBe(0.9);
    expect(resolveEvalRatio({ RECEIPT_EVAL_RATIO: 'nope' })).toBe(0.85);
  });
});

describe('mimeTypeForFile', () => {
  it('maps supported receipt extensions', () => {
    expect(mimeTypeForFile('a.jpg')).toBe('image/jpeg');
    expect(mimeTypeForFile('a.JPEG')).toBe('image/jpeg');
    expect(mimeTypeForFile('a.png')).toBe('image/png');
    expect(mimeTypeForFile('a.pdf')).toBe('application/pdf');
  });

  it('returns null for unsupported types', () => {
    expect(mimeTypeForFile('a.heic')).toBeNull();
    expect(mimeTypeForFile('a.expected.json')).toBeNull();
    expect(mimeTypeForFile('a')).toBeNull();
  });
});

describe('expectedPathFor', () => {
  it('swaps the receipt extension for .expected.json', () => {
    expect(expectedPathFor('/x/costco-01.pdf')).toBe('/x/costco-01.expected.json');
    expect(expectedPathFor('/x/y.jpeg')).toBe('/x/y.expected.json');
  });
});

describe('gradeReceipt (threshold grading, G-1 / NFR-5)', () => {
  const groceries = (sku: string | null, name: string): GradedItem => ({
    sku,
    canonicalName: name,
    category: 'groceries',
  });

  it('credits a fuzzy canonical-name match above ratio with exact category', () => {
    const actual = [groceries('1', 'Kirkland Organic Extra Virgin Olive Oil')];
    const expected = [{ sku: '1', name: 'Organic Extra Virgin Olive Oil, Kirkland', category: 'groceries' }];
    expect(gradeReceipt(actual, expected, 0.85)).toEqual({ correct: 1, total: 1 });
  });

  it('does NOT credit when the category differs even with a perfect name', () => {
    const actual = [{ sku: '1', canonicalName: 'Paper Towels', category: 'household' }];
    const expected = [{ sku: '1', name: 'Paper Towels', category: 'groceries' }];
    expect(gradeReceipt(actual, expected, 0.85)).toEqual({ correct: 0, total: 1 });
  });

  it('does NOT credit when the name is below ratio even with the right category', () => {
    const actual = [groceries('1', 'Tube Socks')];
    const expected = [{ sku: '1', name: 'Organic Bananas', category: 'groceries' }];
    expect(gradeReceipt(actual, expected, 0.85)).toEqual({ correct: 0, total: 1 });
  });

  it('aligns by SKU when extraction order differs', () => {
    const actual = [groceries('B', 'Bananas'), groceries('A', 'Apples')];
    const expected = [
      { sku: 'A', name: 'Apples', category: 'groceries' },
      { sku: 'B', name: 'Bananas', category: 'groceries' },
    ];
    expect(gradeReceipt(actual, expected, 0.85)).toEqual({ correct: 2, total: 2 });
  });

  it('falls back to positional alignment when SKUs are absent', () => {
    const actual = [groceries(null, 'Apples'), groceries(null, 'Bananas')];
    const expected = [
      { sku: null, name: 'Apples', category: 'groceries' },
      { sku: null, name: 'Bananas', category: 'groceries' },
    ];
    expect(gradeReceipt(actual, expected, 0.85)).toEqual({ correct: 2, total: 2 });
  });

  it('counts a missing actual item against the score (denominator is expected)', () => {
    const actual = [groceries('1', 'Apples')];
    const expected = [
      { sku: '1', name: 'Apples', category: 'groceries' },
      { sku: '2', name: 'Bananas', category: 'groceries' },
    ];
    expect(gradeReceipt(actual, expected, 0.85)).toEqual({ correct: 1, total: 2 });
  });

  it('grades on the name alone when the expected category is null (ground truth without categories)', () => {
    const actual = [{ sku: '1', canonicalName: 'Bounty Advanced Paper Towels, 12-count', category: 'household' }];
    const expected = [{ sku: '1', name: 'Bounty Advanced Paper Towels 12 count', category: null }];
    expect(gradeReceipt(actual, expected, 0.85)).toEqual({ correct: 1, total: 1 });
    const wrongName = [{ sku: '1', canonicalName: 'Charmin Bath Tissue', category: 'household' }];
    expect(gradeReceipt(wrongName, expected, 0.85)).toEqual({ correct: 0, total: 1 });
  });

  it('extra extracted rows (a savings line, a fee line) do not shift SKU-less matches', () => {
    // Ground truth excludes the savings and CRV rows; extraction emits them.
    const actual = [
      groceries(null, 'Bounty Paper Towels'),
      { sku: '388550', canonicalName: '/BOUNTY', category: 'other' },
      groceries(null, 'Organic Bananas'),
      { sku: '1254', canonicalName: 'California Redemption Value', category: 'other' },
      groceries(null, 'Eggo Waffles'),
    ];
    const expected = [
      { sku: null, name: 'Bounty Paper Towels', category: null },
      { sku: null, name: 'Organic Bananas', category: null },
      { sku: null, name: 'Eggo Waffles', category: null },
    ];
    expect(gradeReceipt(actual, expected, 0.85)).toEqual({ correct: 3, total: 3 });
  });

  it('each extracted row can satisfy at most one expected item', () => {
    const actual = [groceries(null, 'Bananas')];
    const expected = [
      { sku: null, name: 'Bananas', category: 'groceries' },
      { sku: null, name: 'Bananas', category: 'groceries' },
    ];
    expect(gradeReceipt(actual, expected, 0.85)).toEqual({ correct: 1, total: 2 });
  });
});

describe('resolveEvalLimit / sampleEvenly / evalTimeoutMs', () => {
  it('limit is null when unset or invalid, else the positive integer', () => {
    expect(resolveEvalLimit({})).toBeNull();
    expect(resolveEvalLimit({ RECEIPT_EVAL_LIMIT: '0' })).toBeNull();
    expect(resolveEvalLimit({ RECEIPT_EVAL_LIMIT: 'ten' })).toBeNull();
    expect(resolveEvalLimit({ RECEIPT_EVAL_LIMIT: '10' })).toBe(10);
  });

  it('sampleEvenly spreads picks across the list instead of taking the head', () => {
    const files = Array.from({ length: 10 }, (_, i) => `f${i}`);
    expect(sampleEvenly(files, null)).toEqual(files);
    expect(sampleEvenly(files, 20)).toEqual(files);
    expect(sampleEvenly(files, 5)).toEqual(['f0', 'f2', 'f4', 'f6', 'f8']);
    expect(sampleEvenly(files, 3)).toEqual(['f0', 'f3', 'f6']);
    expect(sampleEvenly(files, 0)).toEqual([]);
  });

  it('evalTimeoutMs grows with both receipts and line items, never below 3 minutes', () => {
    expect(evalTimeoutMs(1, 1)).toBe(180_000);
    expect(evalTimeoutMs(83, 460)).toBe(83 * 15_000 + 460 * 5_000);
  });
});

describe('meetsThreshold — the single ≥80% assertion (NFR-5)', () => {
  it('passes at exactly 80%', () => {
    expect(meetsThreshold(4, 5)).toBe(true);
    expect(meetsThreshold(8, 10)).toBe(true);
  });

  it('fails below 80%', () => {
    expect(meetsThreshold(3, 5)).toBe(false);
    expect(meetsThreshold(7, 10)).toBe(false);
  });

  it('is false for an empty sample', () => {
    expect(meetsThreshold(0, 0)).toBe(false);
  });

  it('uses 0.8 as the default pass fraction', () => {
    expect(EVAL_PASS_FRACTION).toBe(0.8);
  });
});

describe('committed eval sample (FR-18: ≥5 receipts process end-to-end)', () => {
  const receipts = discoverReceipts(DEFAULT_EVAL_DIR);

  it('ships at least 5 sanitized receipts', () => {
    expect(receipts.length).toBeGreaterThanOrEqual(MIN_EVAL_RECEIPTS);
  });

  it('every receipt is a supported media type with a parseable expected record', () => {
    for (const receipt of receipts) {
      expect(mimeTypeForFile(receipt)).not.toBeNull();
      const expected = JSON.parse(readFileSync(expectedPathFor(receipt), 'utf8')) as ExpectedReceipt;
      expect(Array.isArray(expected.items)).toBe(true);
      expect(expected.items.length).toBeGreaterThan(0);
      expect(typeof expected.totalCents).toBe('number');
      for (const item of expected.items) {
        expect(typeof item.name).toBe('string');
        expect(item.category === null || typeof item.category === 'string').toBe(true);
      }
    }
  });
});

describe('vision:eval is a separate, isolated Vitest project (FR-18, G-3)', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const vitestConfig = readFileSync(join(repoRoot, 'vitest.config.ts'), 'utf8');

  it('npm test runs only the unit project; vision:eval runs only the eval project', () => {
    expect(pkg.scripts.test).toBe('vitest run --project unit');
    expect(pkg.scripts['vision:eval']).toBe('vitest run --project eval');
  });

  it('the default unit project EXCLUDES *.eval.test.ts', () => {
    expect(vitestConfig).toContain("name: 'unit'");
    expect(vitestConfig).toContain("'**/*.eval.test.ts'");
  });

  it('the eval project glob is scoped to eval/**/*.eval.test.ts and is not the unit glob', () => {
    expect(vitestConfig).toContain("name: 'eval'");
    expect(vitestConfig).toContain("'modules/finance/core/receipts/eval/**/*.eval.test.ts'");
  });
});
