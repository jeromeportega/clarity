import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { sha256Hex } from '../../../idempotency/keys';
import type { NormalizedReceipt } from '../../../model/normalized';
import { costcoAdapter } from '../costco.adapter';
import { COSTCO_DIGITAL_SOURCE, parseCostcoReceipts } from '../parse';

// modules/finance/core/adapters/costco/__tests__ → modules/finance/fixtures
const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', '..', 'fixtures', 'costco', 'warehouse-receipts.json',
);
const fixtureText = () => readFileSync(FIXTURE, 'utf8');
const fixtureJson = () => JSON.parse(fixtureText()) as Array<Record<string, unknown>>;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** The invariant every persisted receipt must satisfy. */
function expectArithmetic(r: NormalizedReceipt): void {
  const sum = r.items.reduce((s, i) => s + i.linePriceCents - i.discountCents, 0);
  expect(sum + (r.taxCents ?? 0)).toBe(r.totalCents);
}

describe('parseCostcoReceipts — the sanitized fixture', () => {
  const { receipts, errors } = parseCostcoReceipts(fixtureText());
  const sale = receipts[0]!;
  const refund = receipts[1]!;
  const gas = receipts[2]!;

  it('yields three receipts and no errors', () => {
    expect(errors).toEqual([]);
    expect(receipts).toHaveLength(3);
  });

  it('maps receipt-level fields: source, bank-clean store, local date, cents, last4, hash', () => {
    expect(sale.source).toBe(COSTCO_DIGITAL_SOURCE);
    expect(sale.store).toBe('COSTCO WHSE');
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

  it("uses Costco's catalog name as the canonical name", () => {
    expect(sale.items[0]!.canonicalName).toBe('Bounty Advanced Paper Towels, 12-count');
    expect(sale.items[0]!.needsReview).toBe(false);
    expect(sale.items[1]!.canonicalName).toBe('Eggo Homestyle Waffles, 60-count');
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
    expect(bushwood.canonicalName).toBeNull();
    expect(bushwood.needsReview).toBe(true);
  });

  it('every fixture receipt reconciles: Σ line − Σ discount + tax = total, and the sign matches the source', () => {
    const source = fixtureJson();
    receipts.forEach((r, i) => {
      expectArithmetic(r);
      expect(Math.sign(r.totalCents)).toBe(Math.sign(Number(source[i]!.total)));
    });
  });

  it("a refund receipt keeps the source's negative signs and records the refund destination; a Shop Card yields no last4", () => {
    expect(refund.totalCents).toBe(-1099);
    expect(refund.subtotalCents).toBe(-1099);
    expect(refund.items).toHaveLength(1);
    expect(refund.items[0]!.linePriceCents).toBe(-1099);
    expect(refund.items[0]!.refundDestination).toBe('gift_card');
    expect(refund.paymentLast4).toBeNull();
    expect(refund.needsReview).toBe(false);
  });

  it('a gas receipt (documentType FuelReceipts) uses the gas merchant string and gallon quantity / per-gallon unit price', () => {
    expect((fixtureJson()[2] as { documentType: string }).documentType).toBe('FuelReceipts');
    expect(gas.store).toBe('COSTCO GAS');
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
    expect(out).not.toContain('DEMOVILLE');
  });

  it('assigns line numbers 1..n excluding folded savings lines, with stable per-line hashes', () => {
    expect(sale.items.map((i) => i.lineNo)).toEqual([1, 2, 3, 4]);
    const hashes = sale.items.map((i) => i.sourceRowHash);
    expect(new Set(hashes).size).toBe(4);
    expect(parseCostcoReceipts(fixtureText()).receipts[0]!.items.map((i) => i.sourceRowHash)).toEqual(hashes);
  });
});

describe('parseCostcoReceipts — signs are validated, never rewritten', () => {
  const sale = () => clone(fixtureJson()[0]!);

  it('a "Refund" receipt printed with POSITIVE amounts is kept as printed and flagged (not silently inverted)', () => {
    const r = sale();
    r.transactionType = 'Refund';
    const { receipts, errors } = parseCostcoReceipts(JSON.stringify([r]));
    expect(errors).toEqual([]);
    expect(receipts[0]!.totalCents).toBe(10900);
    expect(receipts[0]!.items[0]!.linePriceCents).toBe(2849);
    expect(receipts[0]!.needsReview).toBe(true);
  });

  it('a "Sales" receipt with a negative total is flagged', () => {
    const r = clone(fixtureJson()[1]!);
    r.transactionType = 'Sales';
    const { receipts } = parseCostcoReceipts(JSON.stringify([r]));
    expect(receipts[0]!.totalCents).toBe(-1099);
    expect(receipts[0]!.needsReview).toBe(true);
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
    const { receipts, errors } = parseCostcoReceipts(JSON.stringify([r]));
    expect(errors).toEqual([]);
    const receipt = receipts[0]!;
    expect(receipt.items).toHaveLength(1);
    expect(receipt.items[0]!.linePriceCents).toBe(-2289);
    expect(receipt.items[0]!.discountCents).toBe(0);
    expect(receipt.taxCents).toBe(-160);
    expect(receipt.needsReview).toBe(false);
    expectArithmetic(receipt);
  });

  it('a sale with a negative non-savings line keeps it as printed and still reconciles', () => {
    const r = sale();
    r.itemArray = [
      { itemNumber: '1', itemDescription01: 'WIDGET', itemActualName: 'Widget, 2-pack', amount: 20, unit: 1 },
      { itemNumber: '2', itemDescription01: 'MANUAL ADJ', itemActualName: 'Manual adjustment', amount: -5, unit: 1 },
    ];
    r.subTotal = 15;
    r.taxes = 1;
    r.total = 16;
    const { receipts } = parseCostcoReceipts(JSON.stringify([r]));
    expect(receipts[0]!.items.map((i) => i.linePriceCents)).toEqual([2000, -500]);
    expect(receipts[0]!.needsReview).toBe(false);
    expectArithmetic(receipts[0]!);
  });

  it('a multi-unit return keeps its quantity (unit: -2 → 2)', () => {
    const r = clone(fixtureJson()[1]!);
    r.itemArray = [{ itemNumber: '2038673', itemDescription01: 'EGGOS 60CT', itemActualName: 'Eggo Homestyle Waffles, 60-count', amount: -21.98, unit: -2 }];
    r.subTotal = -21.98;
    r.total = -21.98;
    const { receipts } = parseCostcoReceipts(JSON.stringify([r]));
    expect(receipts[0]!.items[0]!.quantity).toBe(2);
    expect(receipts[0]!.items[0]!.linePriceCents).toBe(-2198);
  });
});

describe('parseCostcoReceipts — savings lines only fold onto the item printed right before them', () => {
  const sale = () => clone(fixtureJson()[0]!);

  it('a savings line as the FIRST line is an error and flags the receipt — no phantom item', () => {
    const r = sale();
    r.itemArray = [
      { itemNumber: '388550', itemDescription01: '/BOUNTY', amount: -5.6, unit: 1 },
      { itemNumber: '2038673', itemDescription01: 'EGGOS 60CT', itemActualName: 'Eggo Homestyle Waffles, 60-count', amount: 10.99, unit: 1 },
    ];
    r.subTotal = 5.39;
    r.taxes = 0;
    r.total = 5.39;
    const { receipts, errors } = parseCostcoReceipts(JSON.stringify([r]));
    expect(receipts[0]!.items).toHaveLength(1);
    expect(receipts[0]!.items[0]!.rawDescription).toBe('EGGOS 60CT');
    expect(receipts[0]!.needsReview).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.reason).toMatch(/no preceding item/);
  });

  it('a savings line after a skipped row is NOT attached to an earlier product', () => {
    const r = sale();
    r.itemArray = [
      { itemNumber: '2038673', itemDescription01: 'EGGOS 60CT', itemActualName: 'Eggo Homestyle Waffles, 60-count', amount: 10.99, unit: 1 },
      { itemNumber: '999', itemDescription01: 'BROKEN ROW', amount: null },
      { itemNumber: '388550', itemDescription01: '/BOUNTY', amount: -5, unit: 1 },
    ];
    const { receipts, errors } = parseCostcoReceipts(JSON.stringify([r]));
    expect(receipts[0]!.items).toHaveLength(1);
    expect(receipts[0]!.items[0]!.discountCents).toBe(0);
    expect(receipts[0]!.needsReview).toBe(true);
    expect(errors.map((e) => e.reason)).toEqual([
      expect.stringMatching(/without a numeric amount/),
      expect.stringMatching(/no preceding item/),
    ]);
  });
});

describe('parseCostcoReceipts — fee lines', () => {
  const sale = () => clone(fixtureJson()[0]!);

  it('an unrecognized department-0 line never takes the catalog name and is flagged for review', () => {
    const r = sale();
    r.itemArray = [
      { itemNumber: '7', itemDescription01: 'ENV FEE T', itemActualName: 'Kirkland Signature Bath Tissue, 30-count', itemDepartmentNumber: 0, amount: 0.25, unit: 1 },
    ];
    r.subTotal = 0.25;
    r.taxes = 0;
    r.total = 0.25;
    const { receipts } = parseCostcoReceipts(JSON.stringify([r]));
    const line = receipts[0]!.items[0]!;
    expect(line.canonicalName).toBeNull();
    expect(line.needsReview).toBe(true);
  });

  it('a product whose name merely contains "deposit" is not a fee', () => {
    const r = sale();
    r.itemArray = [
      { itemNumber: '8', itemDescription01: 'SAFE DEPOSIT BX', itemActualName: 'Fireproof Deposit Box', itemDepartmentNumber: 23, amount: 49.99, unit: 1 },
    ];
    r.subTotal = 49.99;
    r.taxes = 0;
    r.total = 49.99;
    const { receipts } = parseCostcoReceipts(JSON.stringify([r]));
    expect(receipts[0]!.items[0]!.canonicalName).toBe('Fireproof Deposit Box');
  });
});

describe('parseCostcoReceipts — input handling', () => {
  const base = fixtureJson();
  const sale = () => clone(base[0]!);

  it('rejects invalid JSON with one file-level error', () => {
    const { receipts, errors } = parseCostcoReceipts('{not json');
    expect(receipts).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.reason).toMatch(/not valid JSON/);
  });

  it('tolerates a UTF-8 BOM', () => {
    const { receipts, errors } = parseCostcoReceipts(`﻿${fixtureText()}`);
    expect(errors).toEqual([]);
    expect(receipts).toHaveLength(3);
  });

  it('accepts the GraphQL envelope and a { receipts: [] } wrapper', () => {
    const wrapped = JSON.stringify({ data: { receiptsWithCounts: { receipts: base } } });
    expect(parseCostcoReceipts(wrapped).receipts).toHaveLength(3);
    expect(parseCostcoReceipts(JSON.stringify({ receipts: base })).receipts).toHaveLength(3);
    expect(parseCostcoReceipts('{"foo":1}').errors[0]!.reason).toMatch(/expected an array/);
  });

  it('names a fuel line from its printed grade when the catalog name is only an echo', () => {
    const g = clone(base[2]!);
    g.itemArray = [
      { itemNumber: '1', itemDescription01: 'REGULAR GAS', itemActualName: 'REGULAR GAS', fuelGradeDescription: 'Regular', fuelUnitQuantity: 9.032, fuelUomCode: 'GAL', itemUnitPriceAmount: 5.659, amount: 51.11, unit: 1 },
    ];
    g.subTotal = 51.11;
    g.taxes = 0;
    g.total = 51.11;
    const { receipts } = parseCostcoReceipts(JSON.stringify([g]));
    const fuel = receipts[0]!.items[0]!;
    expect(fuel.canonicalName).toBe('Regular Gasoline');
    expect(fuel.needsReview).toBe(false);
    expect(fuel.quantity).toBeCloseTo(9.032);
  });

  it('rejects an unknown documentType but accepts both receipt kinds', () => {
    const odd = sale();
    odd.documentType = 'OnlineOrderDetail';
    const { receipts, errors } = parseCostcoReceipts(JSON.stringify([odd]));
    expect(receipts).toHaveLength(0);
    expect(errors[0]!.reason).toMatch(/unsupported documentType/);
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

  it('takes only the last four digits of a CARD tender, and null for cash or a Shop Card', () => {
    const r = sale();
    r.tenderArray = [{ displayAccountNumber: '4242424242424242', tenderDescription: 'Visa' }];
    expect(parseCostcoReceipts(JSON.stringify([r])).receipts[0]!.paymentLast4).toBe('4242');
    r.tenderArray = [{ displayAccountNumber: 'XXXXXXXXXXXX9999', tenderDescription: 'Costco Shop Card' }];
    expect(parseCostcoReceipts(JSON.stringify([r])).receipts[0]!.paymentLast4).toBeNull();
    r.tenderArray = [{ displayAccountNumber: null, tenderDescription: 'Cash' }];
    expect(parseCostcoReceipts(JSON.stringify([r])).receipts[0]!.paymentLast4).toBeNull();
    r.tenderArray = [];
    expect(parseCostcoReceipts(JSON.stringify([r])).receipts[0]!.paymentLast4).toBeNull();
  });

  it('prefers the local transactionDateTime over the UTC timestamp when transactionDate is missing', () => {
    const r = clone(base[2]!); // gas: ISO says 2026-09-04T00:12Z, local is 2026-09-03
    delete r.transactionDate;
    r.transactionDateTime = '2026-09-03T17:12:00';
    expect(parseCostcoReceipts(JSON.stringify([r])).receipts[0]!.purchasedAt).toBe('2026-09-03');
    delete r.transactionDateTime;
    expect(parseCostcoReceipts(JSON.stringify([r])).receipts[0]!.purchasedAt).toBe('2026-09-04');
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
