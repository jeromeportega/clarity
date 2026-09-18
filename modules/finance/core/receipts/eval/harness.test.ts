import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  countSkuReads,
  identityName,
  isGatedRun,
  resolveEvalNameMode,
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
  it('is false with no gateway credential at all (eval SKIPS, never fails)', () => {
    expect(evalKeyPresent({})).toBe(false);
  });

  it('is false when the credentials are blank', () => {
    expect(evalKeyPresent({ AI_GATEWAY_API_KEY: '   ', VERCEL_OIDC_TOKEN: '' })).toBe(false);
  });

  it('is true with an AI Gateway API key', () => {
    expect(evalKeyPresent({ AI_GATEWAY_API_KEY: 'vck_xxx' })).toBe(true);
  });

  it('is true with a pulled Vercel OIDC token', () => {
    expect(evalKeyPresent({ VERCEL_OIDC_TOKEN: 'eyJ.xxx' })).toBe(true);
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

describe('identityName — the product identity without its appended pack-size segments', () => {
  it('strips the size segments a retailer catalogue appends', () => {
    expect(identityName('Jimmy Dean Croissant Sausage Egg & Cheese, 4.5 oz, 12-count')).toBe('Jimmy Dean Croissant Sausage Egg & Cheese');
    expect(identityName('Kirkland Signature Bath Tissue, 2-Ply, 380 Sheets, 30 Rolls')).toBe('Kirkland Signature Bath Tissue');
    expect(identityName('Lysol Advanced Toilet Bowl Cleaner, 32 fl oz, 4-count')).toBe('Lysol Advanced Toilet Bowl Cleaner');
    expect(identityName('Kirkland Signature Sliced Bacon, 4 lb (4 x 1 lb packs)')).toBe('Kirkland Signature Sliced Bacon');
    expect(identityName('Q-Tips Cotton Swabs, 1750 count')).toBe('Q-Tips Cotton Swabs');
    expect(identityName('Kirkland Signature Paper Towels, 2-Ply, 160 Sheets, 12 Individually Wrapped Rolls')).toBe('Kirkland Signature Paper Towels');
    expect(identityName('Seville Classics Hyacinth & Rope Baskets, 3-piece Set')).toBe('Seville Classics Hyacinth & Rope Baskets');
    expect(identityName('Nature Made Vitamin D3 2000 IU, 600 Softgels')).toBe('Nature Made Vitamin D3 2000 IU');
    expect(identityName('Kirkland Signature Purified Drinking Water, 40 Bottles')).toBe('Kirkland Signature Purified Drinking Water');
    expect(identityName('Huggies Natural Care Baby Wipes, 900 Wipes')).toBe('Huggies Natural Care Baby Wipes');
    expect(identityName('Rotisserie Chicken  Per Lb')).toBe('Rotisserie Chicken');
    expect(identityName('Kirkland Signature Ready to Drink Old Fashioned Tennessee 1L')).toBe('Kirkland Signature Ready to Drink Old Fashioned Tennessee');
    expect(identityName('Salmon 1 lb each')).toBe('Salmon');
  });

  it('keeps a number that is part of the identity: dimensions, sizes, doses, model numbers', () => {
    expect(identityName('Kirkland Signature 10-Gallon Wastebasket Liner, Clear, 500-count')).toBe('Kirkland Signature 10-Gallon Wastebasket Liner, Clear');
    expect(identityName('Huggies Little Snugglers Plus Diapers Size 2, 174-count')).toBe('Huggies Little Snugglers Plus Diapers Size 2');
    expect(identityName('HDMI Cable 6ft')).toBe('HDMI Cable 6ft');
    expect(identityName('Samsung 65 inch Class QLED TV')).toBe('Samsung 65 inch Class QLED TV');
    expect(identityName('Omega-3 1000 mg Fish Oil')).toBe('Omega-3 1000 mg Fish Oil');
    expect(identityName('Kohler 47L Step Trash Can, Stainless Steel')).toBe('Kohler 47L Step Trash Can, Stainless Steel');
    expect(identityName('2 in 1 Shampoo and Conditioner')).toBe('2 in 1 Shampoo and Conditioner');
    expect(identityName('Rotisserie Chicken')).toBe('Rotisserie Chicken');
    expect(identityName('Reversible Cotton Throw, Assorted Colors')).toBe('Reversible Cotton Throw, Assorted Colors');
    expect(identityName('Glenfiddich 12 Years Single Malt Scotch Whiskey, Scotland, 750 ml')).toBe('Glenfiddich 12 Years Single Malt Scotch Whiskey, Scotland');
  });

  it('never collapses a name to nothing: an all-size name keeps its full form', () => {
    expect(identityName('1.5 L')).toBe('1.5 L');
    expect(identityName('12 ct')).toBe('12 ct');
    expect(identityName('500-count')).toBe('500-count');
  });

  it('resolveEvalNameMode defaults to full and accepts identity; isGatedRun is the fixture in full mode only', () => {
    expect(resolveEvalNameMode({})).toBe('full');
    expect(resolveEvalNameMode({ RECEIPT_EVAL_NAME_MODE: 'IDENTITY' })).toBe('identity');
    expect(resolveEvalNameMode({ RECEIPT_EVAL_NAME_MODE: 'garbage' })).toBe('full');
    expect(isGatedRun(DEFAULT_EVAL_DIR, 'full')).toBe(true);
    expect(isGatedRun(DEFAULT_EVAL_DIR, 'identity')).toBe(false);
    expect(isGatedRun('/somewhere/real', 'full')).toBe(false);
  });

  it('identity mode credits a size-less answer against a sized catalogue name; full mode does not; a wrong product is still wrong', () => {
    const actual = [{ sku: '1', canonicalName: 'Kirkland Signature Bath Tissue', category: null }];
    const expected = [{ sku: '1', name: 'Kirkland Signature Bath Tissue, 2-Ply, 380 Sheets, 30 Rolls', category: null }];
    expect(gradeReceipt(actual, expected, 0.85, 'full')).toEqual({ correct: 0, total: 1 });
    expect(gradeReceipt(actual, expected, 0.85, 'identity')).toEqual({ correct: 1, total: 1 });
    const wrong = [{ sku: '1', canonicalName: 'Kirkland Signature Paper Towels', category: null }];
    expect(gradeReceipt(wrong, expected, 0.85, 'identity')).toEqual({ correct: 0, total: 1 });
    // Known limit of the Dice comparison, in BOTH modes: a size inside the head
    // of the name ("10-Gallon" vs "30-Gallon") differs by two characters, and
    // two long, otherwise identical names score above the ratio. The
    // normaliser keeps such numbers (see the identityName tests) so the two
    // modes agree here, but only a stricter comparator would separate them.
  });

  it('a null extracted name never scores against a name that collapses to nothing', () => {
    expect(gradeReceipt([{ sku: '1', canonicalName: null, category: null }], [{ sku: '1', name: '12 ct', category: null }], 0.85, 'identity')).toEqual({ correct: 0, total: 1 });
  });
});

describe('countSkuReads — item numbers judged on the paired line', () => {
  const a = (sku: string | null, name: string): GradedItem => ({ sku, canonicalName: name, category: null });

  it('counts expected item numbers read on their own line, over those that have one, and the unexpected numbers', () => {
    const actual = [a('111', 'whatever'), a(null, 'no code'), a('333', 'x')];
    const expected = [
      { sku: '111', name: 'A', category: null },
      { sku: '222', name: 'B', category: null },
      { sku: null, name: 'C (no code on the receipt)', category: null },
    ];
    expect(countSkuReads(actual, expected)).toEqual({ read: 1, withSku: 2, unexpected: 1, extractedWithSku: 2 });
    expect(countSkuReads([], expected)).toEqual({ read: 0, withSku: 2, unexpected: 0, extractedWithSku: 0 });
  });

  it('two lines that swapped their numbers are two misses, not a perfect score', () => {
    const actual = [a('222', 'Apples'), a('111', 'Bananas')];
    const expected = [
      { sku: '111', name: 'Apples', category: null },
      { sku: '222', name: 'Bananas', category: null },
    ];
    // SKU pairing wins first, so each expected item pairs with the line carrying its number —
    // the line whose text is the OTHER product. Those are reads of the right number on the
    // wrong text; the name grade catches them. When the numbers are absent from the swapped
    // lines the pairing falls to names and the numbers do not match.
    const swappedText = [a('222', 'Bananas'), a('111', 'Apples')];
    expect(countSkuReads(swappedText, expected)).toEqual({ read: 2, withSku: 2, unexpected: 0, extractedWithSku: 2 });
    expect(countSkuReads([a(null, 'Apples'), a(null, 'Bananas')], expected)).toEqual({ read: 0, withSku: 2, unexpected: 0, extractedWithSku: 0 });
    void actual;
  });

  it('a duplicated item number on the receipt needs two extracted lines, not one', () => {
    const expected = [
      { sku: '123', name: 'Milk', category: null },
      { sku: '123', name: 'Milk', category: null },
    ];
    expect(countSkuReads([a('123', 'Milk')], expected)).toEqual({ read: 1, withSku: 2, unexpected: 0, extractedWithSku: 1 });
  });

  it('leading zeros and whitespace are not identity; fifty noise lines do not inflate reads', () => {
    const expected = [{ sku: '100487', name: 'X', category: null }];
    expect(countSkuReads([a(' 0100487 ', 'X')], expected)).toEqual({ read: 1, withSku: 1, unexpected: 0, extractedWithSku: 1 });
    const noise = Array.from({ length: 50 }, (_, i) => a(`9${i}`, `noise ${i}`));
    expect(countSkuReads([...noise, a('100487', 'X')], expected)).toEqual({ read: 1, withSku: 1, unexpected: 50, extractedWithSku: 51 });
  });
});
