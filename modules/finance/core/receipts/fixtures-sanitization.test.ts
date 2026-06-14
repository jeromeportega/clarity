import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// =============================================================================
// PII sanitization guard (NFR-4) — runs in the DEFAULT offline gate.
//
// Only sanitized receipts may live in fixtures: no full card numbers and no
// payment last-4 leaks. This guard fails `npm test` (no key, no network) the
// moment any committed fixture JSON contains a card-number-shaped run or a
// masked-PAN / "ending in NNNN" last-4 pattern — so the operator's real receipt
// PII can never land, even when no API key is present to gate the eval harness.
//
// What we deliberately DO and DO NOT flag, and why:
//   - DO flag a 13–19 digit run (a full PAN), including the common grouped
//     "4242 4242 4242 4242" / amex "3782 822463 10005" printed forms.
//   - DO flag a masked-PAN last-4 pattern: a run of mask glyphs (* x X # • ●)
//     followed by 4 digits ("VISA ****4242", "XXXXXXXXXXXX4242"), and the
//     English "ending in 4242" phrasing — the shapes a real receipt's printed
//     payment line actually takes.
//   - DO NOT flag a bare 4-digit value on its own (e.g. a structured
//     `"last4": "4242"` field, or any cents amount / quantity / SKU). A bare
//     4-digit number is indistinguishable from the prices and quantities that
//     fill every receipt, so flagging it would be all false positives — and
//     would also red the build on the synthetic test-card last-4s that the
//     vision story's recorded fixtures already carry (which this story may not
//     edit). The real leak vector is a FULL PAN or a MASKED card number; that
//     is what we catch. The eval fixtures this story authors carry no payment
//     data at all.
// =============================================================================

// A run of 13–19 consecutive digits — a full primary account number (PAN).
const PAN_RAW = /\b\d{13,19}\b/;
// Grouped PANs as printed on receipts: 4-4-4-4 (most cards) and 4-6-5 (amex),
// separated by a single space or hyphen.
const PAN_GROUPED = /\b(?:\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{4}|\d{4}[ -]\d{6}[ -]\d{5})\b/;
// A masked PAN reduced to its last 4: two-or-more mask glyphs then 4 digits,
// with an optional single separator ("****4242", "XXXX-4242").
const MASKED_LAST4 = /[*xX#•●]{2,}[ -]?\d{4}\b/;
// The English "ending in 4242" / "ending 4242" last-4 phrasing.
const ENDING_IN_LAST4 = /ending(?:\s+in)?\s*[:#-]?\s*\d{4}\b/i;

const PII_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'full PAN (13–19 digit run)', re: PAN_RAW },
  { name: 'grouped PAN', re: PAN_GROUPED },
  { name: 'masked card last-4', re: MASKED_LAST4 },
  { name: 'card "ending in" last-4', re: ENDING_IN_LAST4 },
];

// Pure detector: returns one human-readable violation per matched pattern.
export function findPiiViolations(text: string): string[] {
  const hits: string[] = [];
  for (const { name, re } of PII_PATTERNS) {
    const m = text.match(re);
    if (m) hits.push(`${name}: "${m[0]}"`);
  }
  return hits;
}

const moduleRoot = dirname(fileURLToPath(import.meta.url));
const fixturesRoot = join(moduleRoot, 'fixtures');

function collectJsonFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      out.push(...collectJsonFiles(full));
    } else if (entry.name.endsWith('.json')) {
      out.push(full);
    }
  }
  return out;
}

describe('findPiiViolations (pure detector, NFR-4)', () => {
  it('flags a raw 16-digit PAN', () => {
    expect(findPiiViolations('"pan": "4242424242424242"')).toContainEqual(
      expect.stringContaining('full PAN'),
    );
  });

  it('flags a 19-digit PAN run', () => {
    expect(findPiiViolations('1234567890123456789')).toContainEqual(
      expect.stringContaining('full PAN'),
    );
  });

  it('flags a space-grouped PAN', () => {
    expect(findPiiViolations('VISA 4242 4242 4242 4242')).toContainEqual(
      expect.stringContaining('grouped PAN'),
    );
  });

  it('flags a hyphen-grouped amex PAN', () => {
    expect(findPiiViolations('AMEX 3782-822463-10005')).toContainEqual(
      expect.stringContaining('grouped PAN'),
    );
  });

  it('flags a masked card last-4 (asterisks)', () => {
    expect(findPiiViolations('VISA ****4242')).toContainEqual(
      expect.stringContaining('masked card last-4'),
    );
  });

  it('flags a masked card last-4 (full X mask, no separator)', () => {
    expect(findPiiViolations('XXXXXXXXXXXX1111')).toContainEqual(
      expect.stringContaining('masked card last-4'),
    );
  });

  it('flags an "ending in NNNN" last-4', () => {
    expect(findPiiViolations('Card ending in 4242')).toContainEqual(
      expect.stringContaining('ending in'),
    );
  });

  it('passes clean receipt content with prices, quantities, and SKUs', () => {
    const clean = JSON.stringify({
      store: 'COSTCO WHOLESALE',
      total: 4748,
      tax: 351,
      lineItems: [
        { sku: '100487', rawDescription: 'KS PAPER TOWEL 12', quantity: 1, linePrice: 2199 },
        { sku: '200912', rawDescription: 'ORG QUINOA 4.5LB', quantity: 2, linePrice: 2198 },
      ],
    });
    expect(findPiiViolations(clean)).toEqual([]);
  });

  it('does NOT flag a bare structured 4-digit last-4 field (by design)', () => {
    // A standalone 4-digit value is indistinguishable from a price/quantity and
    // is not a usable PAN; only full or masked card numbers are flagged.
    expect(findPiiViolations('"paymentHint": { "method": "VISA", "last4": "4242" }')).toEqual([]);
  });
});

describe('committed fixtures are sanitized (NFR-4)', () => {
  const files = collectJsonFiles(fixturesRoot);

  it('finds fixture JSON to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s contains no PAN or last-4 leak', (file) => {
    const violations = findPiiViolations(readFileSync(file, 'utf8'));
    expect(violations, `${relative(moduleRoot, file)} leaked: ${violations.join('; ')}`).toEqual(
      [],
    );
  });
});
