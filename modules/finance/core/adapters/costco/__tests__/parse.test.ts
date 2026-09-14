import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { sha256Hex } from '../../../idempotency/keys';
import { costcoAdapter } from '../costco.adapter';
import { COSTCO_DIGITAL_SOURCE, parseCostcoReceipts } from '../parse';

// modules/finance/core/adapters/costco/__tests__ → modules/finance/fixtures
const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', '..', 'fixtures', 'costco', 'warehouse-receipts.json',
);
const fixtureText = () => readFileSync(FIXTURE, 'utf8');

describe('parseCostcoReceipts — the sanitized fixture', () => {
  const { receipts, errors } = parseCostcoReceipts(fixtureText());
  const sale = receipts[0]!;
  const refund = receipts[1]!;
  const gas = receipts[2]!;

  it('yields three receipts and no errors', () => {
    expect(errors).toEqual([]);
    expect(receipts).toHaveLength(3);
  });

  it('maps receipt-level fields: source, bank-style store string, local date, cents, last4, hash', () => {
    expect(sale.source).toBe(COSTCO_DIGITAL_SOURCE);
    expect(sale.store).toBe('COSTCO WHSE #0021');
    expect(sale.purchasedAt).toBe('2026-09-08');
    expect(sale.subtotalCents).toBe(10297);
    expect(sale.taxCents).toBe(603);
    expect(sale.totalCents).toBe(10900);
    expect(sale.paymentLast4).toBe('1234');
    expect(sale.sourceHash).toBe(sha256Hex('costco:210021001234'));
    expect(sale.needsReview).toBe(false);
  });

  it('folds the instant-savings line into the preceding item as a discount (line price stays gross)', () => {
    expect(sale.items).toHaveLength(4);
    expect(sale.items.some((i) => i.rawDescription.startsWith('/'))).toBe(false);
    const bounty = sale.items[0]!;
    expect(bounty.sku).toBe('1919326');
    expect(bounty.linePriceCents).toBe(2849);
    expect(bounty.discountCents).toBe(560);
    expect(bounty.rawDescription).toBe('***BOUNTY*** 669SF TALL PACK SAS P20');
  });

  it("uses Costco's catalog name as the canonical name at full confidence", () => {
    const bounty = sale.items[0]!;
    expect(bounty.canonicalName).toBe('Bounty Advanced Paper Towels, 12-count');
    expect(bounty.needsReview).toBe(false);
    const eggos = sale.items[1]!;
    expect(eggos.canonicalName).toBe('Eggo Homestyle Waffles, 60-count');
  });

  it('keeps a CRV line as a fee item with a fixed name, ignoring the bogus catalog name', () => {
    const crv = sale.items[2]!;
    expect(crv.rawDescription).toBe('CA REDEMP VAL T EI/681700');
    expect(crv.canonicalName).toBe('California Redemption Value (CRV)');
    expect(crv.linePriceCents).toBe(10);
    expect(crv.needsReview).toBe(false);
  });

  it('treats an ALL-CAPS echo of the receipt text as no canonical name and flags the line', () => {
    const bushwood = sale.items[3]!;
    expect(bushwood.rawDescription).toBe('BUSHWOOD SB KENTUCKY 6/750ML');
    expect(bushwood.canonicalName).toBeNull();
    expect(bushwood.needsReview).toBe(true);
  });

  it('arithmetic reconciles for the sale: Σ line − Σ discount + tax = total', () => {
    const sum = sale.items.reduce((s, i) => s + i.linePriceCents - i.discountCents, 0);
    expect(sum + (sale.taxCents ?? 0)).toBe(sale.totalCents);
  });

  it('a refund receipt is negative end to end and records the refund destination from the tender', () => {
    expect(refund.totalCents).toBe(-1099);
    expect(refund.subtotalCents).toBe(-1099);
    expect(refund.items).toHaveLength(1);
    expect(refund.items[0]!.linePriceCents).toBe(-1099);
    expect(refund.items[0]!.refundDestination).toBe('gift_card');
    expect(refund.paymentLast4).toBe('5678');
    expect(refund.needsReview).toBe(false);
  });

  it('a gas receipt uses the gas merchant string and gallon quantity / per-gallon unit price', () => {
    expect(gas.store).toBe('COSTCO GAS #0021');
    expect(gas.purchasedAt).toBe('2026-09-03');
    const fuel = gas.items[0]!;
    expect(fuel.quantity).toBeCloseTo(12.345);
    expect(fuel.unitPriceCents).toBe(460);
    expect(fuel.linePriceCents).toBe(5677);
    expect(fuel.canonicalName).toBe('Regular Unleaded Gasoline');
  });

  it('never copies membership numbers, tender account numbers, or warehouse addresses', () => {
    const out = JSON.stringify(receipts);
    expect(out).not.toContain('111111111111');
    expect(out).not.toContain('XXXXXXXXXXXX');
    expect(out).not.toContain('Example Way');
    expect(out).not.toContain('example.invalid');
    expect(out).not.toContain('catEntryId');
  });

  it('assigns line numbers 1..n excluding folded savings lines, with stable per-line hashes', () => {
    expect(sale.items.map((i) => i.lineNo)).toEqual([1, 2, 3, 4]);
    const hashes = sale.items.map((i) => i.sourceRowHash);
    expect(new Set(hashes).size).toBe(4);
    expect(parseCostcoReceipts(fixtureText()).receipts[0]!.items.map((i) => i.sourceRowHash)).toEqual(hashes);
  });
});

describe('parseCostcoReceipts — edge cases', () => {
  const base = JSON.parse(fixtureText()) as Array<Record<string, unknown>>;
  const sale = () => JSON.parse(JSON.stringify(base[0])) as Record<string, unknown>;

  it('rejects invalid JSON with one file-level error', () => {
    const { receipts, errors } = parseCostcoReceipts('{not json');
    expect(receipts).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.reason).toMatch(/not valid JSON/);
  });

  it('accepts the GraphQL envelope and a { receipts: [] } wrapper', () => {
    const wrapped = JSON.stringify({ data: { receiptsWithCounts: { receipts: base } } });
    expect(parseCostcoReceipts(wrapped).receipts).toHaveLength(3);
    expect(parseCostcoReceipts(JSON.stringify({ receipts: base })).receipts).toHaveLength(3);
    expect(parseCostcoReceipts('{"foo":1}').errors[0]!.reason).toMatch(/expected an array/);
  });

  it('reports and skips a record without a barcode, keeping the rest', () => {
    const bad = sale();
    delete bad.transactionBarcode;
    const { receipts, errors } = parseCostcoReceipts(JSON.stringify([bad, base[2]]));
    expect(receipts).toHaveLength(1);
    expect(errors).toEqual([{ rowRef: 'receipt[0]', reason: 'missing transactionBarcode' }]);
  });

  it('flags a receipt whose arithmetic does not reconcile', () => {
    const off = sale();
    off.total = 999.99;
    const { receipts } = parseCostcoReceipts(JSON.stringify([off]));
    expect(receipts[0]!.needsReview).toBe(true);
    expect(receipts[0]!.totalCents).toBe(99999);
  });

  it('on a refund, a savings reversal is folded into the negative line price (net refund)', () => {
    const r = sale();
    r.transactionType = 'Refund';
    r.itemArray = [
      { itemNumber: '1919326', itemDescription01: '***BOUNTY***', itemActualName: 'Bounty Advanced Paper Towels, 12-count', amount: -28.49, unit: 1 },
      { itemNumber: '388550', itemDescription01: '/BOUNTY', amount: 5.6, unit: 1 },
    ];
    r.subTotal = -22.89;
    r.taxes = -1.6;
    r.total = -24.49;
    const { receipts } = parseCostcoReceipts(JSON.stringify([r]));
    const item = receipts[0]!.items[0]!;
    expect(receipts[0]!.items).toHaveLength(1);
    expect(item.linePriceCents).toBe(-2289);
    expect(item.discountCents).toBe(0);
    expect(receipts[0]!.taxCents).toBe(-160);
    expect(receipts[0]!.needsReview).toBe(false);
  });

  it('takes only the last four digits of any tender string, and null when there are none', () => {
    const r = sale();
    r.tenderArray = [{ displayAccountNumber: '4242424242424242', tenderDescription: 'Visa' }];
    expect(parseCostcoReceipts(JSON.stringify([r])).receipts[0]!.paymentLast4).toBe('4242');
    r.tenderArray = [{ displayAccountNumber: null, tenderDescription: 'Cash' }];
    expect(parseCostcoReceipts(JSON.stringify([r])).receipts[0]!.paymentLast4).toBeNull();
    r.tenderArray = [];
    expect(parseCostcoReceipts(JSON.stringify([r])).receipts[0]!.paymentLast4).toBeNull();
  });

  it('falls back to the ISO timestamp date and a plain COSTCO store when fields are missing', () => {
    const r = sale();
    delete r.transactionDate;
    delete r.warehouseNumber;
    const { receipts } = parseCostcoReceipts(JSON.stringify([r]));
    expect(receipts[0]!.purchasedAt).toBe('2026-09-08');
    expect(receipts[0]!.store).toBe('COSTCO');
  });
});

describe('costcoAdapter', () => {
  it('supports only kind=costco and fills the receipts array', () => {
    const bytes = new TextEncoder().encode(fixtureText());
    expect(costcoAdapter.kind).toBe('costco');
    expect(costcoAdapter.supports({ kind: 'costco', filename: 'r.json', bytes })).toBe(true);
    expect(costcoAdapter.supports({ kind: 'amazon', filename: 'r.json', bytes })).toBe(false);
    const batch = costcoAdapter.normalize({ kind: 'costco', filename: 'r.json', bytes });
    expect(batch.transactions).toEqual([]);
    expect(batch.orders).toEqual([]);
    expect(batch.receipts).toHaveLength(3);
    expect(batch.errors).toEqual([]);
  });
});
