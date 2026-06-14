import { describe, expect, it } from 'vitest';
import { reconcile } from './reconcile';
import type { ExtractedLineItem, ExtractedReceipt } from './vision/vision-provider';

const line = (overrides: Partial<ExtractedLineItem> = {}): ExtractedLineItem => ({
  sku: null,
  rawDescription: 'ITEM',
  quantity: 1,
  unitPrice: null,
  linePrice: 0,
  discount: 0,
  ...overrides,
});

const receipt = (overrides: Partial<ExtractedReceipt> = {}): ExtractedReceipt => ({
  readable: true,
  store: 'COSTCO',
  purchasedAt: '2026-06-13',
  total: null,
  tax: 0,
  fees: [],
  paymentHint: null,
  lineItems: [],
  ...overrides,
});

// Tolerance used across the in/out-of-bounds cases (the default ±2¢).
const TOL = 2;

describe('reconcile (FR-15, integer cents)', () => {
  it('reconciles an exact match (delta 0)', () => {
    const r = receipt({
      lineItems: [line({ linePrice: 1000 }), line({ linePrice: 500 })],
      tax: 80,
      total: 1580,
    });
    expect(reconcile(r, TOL)).toEqual({
      ok: true,
      computedTotalCents: 1580,
      printedTotalCents: 1580,
      deltaCents: 0,
    });
  });

  it('reconciles within −2¢ (printed is 2¢ over computed)', () => {
    const r = receipt({ lineItems: [line({ linePrice: 1500 })], tax: 80, total: 1582 });
    const out = reconcile(r, TOL);
    expect(out.ok).toBe(true);
    expect(out.deltaCents).toBe(-2);
  });

  it('reconciles within +2¢ (printed is 2¢ under computed)', () => {
    const r = receipt({ lineItems: [line({ linePrice: 1500 })], tax: 80, total: 1578 });
    const out = reconcile(r, TOL);
    expect(out.ok).toBe(true);
    expect(out.deltaCents).toBe(2);
  });

  it('fails at −3¢', () => {
    const r = receipt({ lineItems: [line({ linePrice: 1500 })], tax: 80, total: 1583 });
    const out = reconcile(r, TOL);
    expect(out.ok).toBe(false);
    expect(out.deltaCents).toBe(-3);
  });

  it('fails at +3¢', () => {
    const r = receipt({ lineItems: [line({ linePrice: 1500 })], tax: 80, total: 1577 });
    const out = reconcile(r, TOL);
    expect(out.ok).toBe(false);
    expect(out.deltaCents).toBe(3);
  });

  it('subtracts discounts from the computed total', () => {
    const r = receipt({
      lineItems: [line({ linePrice: 1000, discount: 150 })],
      tax: 0,
      total: 850,
    });
    const out = reconcile(r, TOL);
    expect(out.ok).toBe(true);
    expect(out.computedTotalCents).toBe(850);
  });

  it('includes CRV / bag / bottle fees in the computed total', () => {
    const r = receipt({
      lineItems: [line({ linePrice: 1000 })],
      tax: 0,
      fees: [
        { kind: 'crv', label: 'CRV', amount: 50 },
        { kind: 'bag', label: 'Bag fee', amount: 10 },
        { kind: 'bottle', label: 'Bottle deposit', amount: 5 },
      ],
      total: 1065,
    });
    const out = reconcile(r, TOL);
    expect(out.ok).toBe(true);
    expect(out.computedTotalCents).toBe(1065);
  });

  it('reconciles a receipt with a signed return line (negative linePrice)', () => {
    const r = receipt({
      lineItems: [line({ linePrice: 1000 }), line({ linePrice: -300, rawDescription: 'RETURN' })],
      tax: 0,
      total: 700,
    });
    const out = reconcile(r, TOL);
    expect(out.ok).toBe(true);
    expect(out.computedTotalCents).toBe(700);
  });

  it('handles a null printed total deterministically (never ok, delta vs 0)', () => {
    const r = receipt({ lineItems: [line({ linePrice: 1000 })], tax: 0, total: null });
    const out = reconcile(r, TOL);
    expect(out.ok).toBe(false);
    expect(out.printedTotalCents).toBeNull();
    expect(out.computedTotalCents).toBe(1000);
    expect(out.deltaCents).toBe(1000);
  });

  it('respects a custom tolerance (0¢ rejects a 1¢ delta)', () => {
    const r = receipt({ lineItems: [line({ linePrice: 1000 })], tax: 0, total: 1001 });
    expect(reconcile(r, 0).ok).toBe(false);
    expect(reconcile(r, 2).ok).toBe(true);
  });
});
