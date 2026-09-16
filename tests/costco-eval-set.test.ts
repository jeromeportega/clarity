// The eval-set builder pairs captured receipt images with the JSON export by
// the parser's own hash, never by record position, and derives expected items
// with the product's rules. Lives in tests/ because scripts/ is outside the
// module test globs.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CRV_FEE_NAME } from '../modules/finance/core/adapters/costco/parse';
import { buildEvalSet, type ManifestEntry } from '../scripts/costco/build-eval-set';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const exportText = () => readFileSync(join(repoRoot, 'modules/finance/fixtures/costco/warehouse-receipts.json'), 'utf8');

// The sanitized fixture: sale 210021001234 (5 raw lines → savings folded, CRV
// + an un-nameable line excluded ⇒ 2 gradeable items), refund 210021001235
// (1 item), gas 210021001236 (invoice absent in the fixture; see below).
const manifest: ManifestEntry[] = [
  { barcode: '210021001234', invoice: null, kind: 'receipt', layout: 'warehouse', date: '2026-09-08', file: '2026-09-08_210021001234.png' },
  { barcode: '210021001235', invoice: null, kind: 'return', layout: 'warehouse', date: '2026-09-08', file: '2026-09-08_210021001235_return.png' },
];

describe('buildEvalSet', () => {
  it('pairs by barcode and derives expected items with the parser rules', () => {
    const { entries, stats } = buildEvalSet(manifest, exportText());
    expect(stats).toMatchObject({ written: 2, unpaired: 0, skippedEmpty: 0, parseErrors: 0 });

    const sale = entries.find((e) => e.base === '2026-09-08_210021001234')!;
    expect(sale.expected.store).toBe('COSTCO WHSE');
    expect(sale.expected.totalCents).toBe(10900);
    expect(sale.expected.items.map((i) => i.name)).toEqual([
      'Bounty Advanced Paper Towels, 12-count',
      'Eggo Homestyle Waffles, 60-count',
    ]);
    expect(sale.expected.items.every((i) => i.category === null)).toBe(true);
    expect(sale.expected.items.some((i) => i.name === CRV_FEE_NAME)).toBe(false);

    const refund = entries.find((e) => e.base === '2026-09-08_210021001235_return')!;
    expect(refund.expected.totalCents).toBe(-1099);
    expect(refund.expected.items).toHaveLength(1);
  });

  it('pairs a gas capture through its printed Invoice# via the export', () => {
    const records = JSON.parse(exportText()) as Array<Record<string, unknown>>;
    records[2]!.invoiceNumber = 38015; // the gas receipt
    const gasManifest: ManifestEntry[] = [
      { barcode: null, invoice: '38015', kind: 'receipt', layout: 'gas', date: '2026-09-03', file: '2026-09-03_gas-38015.png' },
    ];
    const { entries, stats } = buildEvalSet(gasManifest, JSON.stringify(records));
    expect(stats.written).toBe(1);
    expect(entries[0]!.expected.store).toBe('COSTCO GAS');
    expect(entries[0]!.expected.items.map((i) => i.name)).toEqual(['Regular Unleaded Gasoline']);
  });

  it('is immune to records the parser rejects for non-barcode reasons (no positional drift)', () => {
    const records = JSON.parse(exportText()) as Array<Record<string, unknown>>;
    // A barcode-bearing record with no total, placed FIRST: the parser rejects
    // it; a positional pairing would attribute the next receipt's items to it
    // and shift every later pairing by one.
    const pending = { ...records[0], transactionBarcode: 'AAA000000000', total: null };
    const { entries, stats } = buildEvalSet(
      [{ barcode: 'AAA000000000', invoice: null, kind: 'receipt', date: '2026-09-09', file: 'x.png' }, ...manifest],
      JSON.stringify([pending, ...records]),
    );
    expect(stats.parseErrors).toBe(1);
    expect(stats.unpaired).toBe(1); // the pending record itself
    expect(entries.map((e) => e.base)).toEqual(['2026-09-08_210021001234', '2026-09-08_210021001235_return']);
    expect(entries[0]!.expected.totalCents).toBe(10900);
  });

  it('counts a capture with no export record as unpaired and a receipt with no nameable items as skipped', () => {
    const records = JSON.parse(exportText()) as Array<Record<string, unknown>>;
    const unnameable = { ...records[1], transactionBarcode: '210021009999', itemArray: [{ itemNumber: '1', itemDescription01: 'ZZZ', itemActualName: 'ZZZ', amount: -10.99, unit: 1 }] };
    const { stats } = buildEvalSet(
      [
        { barcode: 'not-in-export', invoice: null, kind: 'receipt', date: '2026-01-01', file: 'a.png' },
        { barcode: '210021009999', invoice: null, kind: 'return', date: '2026-09-08', file: 'b.png' },
      ],
      JSON.stringify([...records, unnameable]),
    );
    expect(stats).toMatchObject({ written: 0, unpaired: 1, skippedEmpty: 1 });
  });
});
