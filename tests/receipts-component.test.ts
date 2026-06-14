// Light component tests for the receipt upload UI.
//
// Lives in tests/ (not modules/) so the framework-isolation guard in
// modules/finance/core/receipts does not flag the React import.
// Uses React.createElement (no JSX syntax) + renderToStaticMarkup so this
// runs in the default node environment without a DOM or browser.
// Interactive upload state (fetch-based flow) is verified via
// tests/receipts-upload-route.test.ts which imports the route directly.

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { ReceiptItemRecord } from '../modules/finance/core/receipts/store/receipt-store';
// ReceiptItemList is a pure presentational component exported alongside the
// stateful ReceiptDrop component. ReceiptDrop itself is the stateful upload UI.
import { ReceiptDrop, ReceiptItemList } from '../apps/web/app/components/receipts/ReceiptDrop';

function makeItem(overrides: Partial<ReceiptItemRecord> = {}): ReceiptItemRecord {
  return {
    id: 'item-1',
    receiptId: 'receipt-1',
    lineNo: 1,
    sku: null,
    rawDescription: 'KS AA BATTRY 48',
    canonicalName: null,
    categoryId: null,
    quantity: 1,
    unitPriceCents: 1799,
    linePriceCents: 1799,
    discountCents: 0,
    nameConfidence: null,
    categoryConfidence: null,
    refundDestination: null,
    needsReview: false,
    createdAt: '2026-06-13T00:00:00.000Z',
    ...overrides,
  };
}

// =============================================================================
// ReceiptDrop — initial render and token-gate
// =============================================================================

describe('ReceiptDrop', () => {
  it('renders the drop zone with browse prompt when a token is provided', () => {
    const html = renderToStaticMarkup(
      React.createElement(ReceiptDrop, { mutationToken: 'test-token' }),
    );
    expect(html).toContain('Drop a receipt photo or PDF here');
    expect(html).toContain('or click to browse');
  });

  it('renders the drop zone even when mutationToken is null (error shown on upload attempt only)', () => {
    const html = renderToStaticMarkup(
      React.createElement(ReceiptDrop, { mutationToken: null }),
    );
    // The idle state renders the drop zone — the null-token guard fires only on
    // a user upload attempt (client-side), not at initial render.
    expect(html).toContain('Drop a receipt photo or PDF here');
  });

  it('exposes the file input with the correct accepted MIME types', () => {
    const html = renderToStaticMarkup(
      React.createElement(ReceiptDrop, { mutationToken: 'test-token' }),
    );
    expect(html).toContain('accept="image/jpeg,image/png,application/pdf"');
  });
});

// =============================================================================
// ReceiptItemList — live line-item render
// =============================================================================

describe('ReceiptItemList', () => {
  it('renders item descriptions and prices as visible text', () => {
    const items: ReceiptItemRecord[] = [
      makeItem({ rawDescription: 'ORGANIC MILK', linePriceCents: 599 }),
      makeItem({ id: 'item-2', lineNo: 2, rawDescription: 'WHOLE WHEAT BREAD', linePriceCents: 349 }),
    ];
    const html = renderToStaticMarkup(React.createElement(ReceiptItemList, { items }));
    expect(html).toContain('ORGANIC MILK');
    expect(html).toContain('WHOLE WHEAT BREAD');
    expect(html).toContain('$5.99');
    expect(html).toContain('$3.49');
  });

  it('exposes accessible list roles so items are visible to assistive technology', () => {
    const html = renderToStaticMarkup(
      React.createElement(ReceiptItemList, { items: [makeItem()] }),
    );
    expect(html).toContain('role="list"');
    expect(html).toContain('role="listitem"');
    expect(html).toContain('KS AA BATTRY 48');
  });

  it('renders nothing for an empty items array', () => {
    const html = renderToStaticMarkup(React.createElement(ReceiptItemList, { items: [] }));
    expect(html).toBe('');
  });
});
