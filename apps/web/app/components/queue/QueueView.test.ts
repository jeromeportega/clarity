// The queue page's split: questions in the main table, "Receipts you could
// add" in its own section below, newest charge first, amounts as a person says
// them. React.createElement + renderToStaticMarkup: no DOM needed. Lives beside
// the component (not in tests/) because the component uses the `@/` alias,
// which only apps/web's tsconfig resolves.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { QueueItem } from '../../../../../modules/finance/core/queue/types';
import { QueueView } from './QueueView';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const sku: QueueItem = { id: 'ri-1', type: 'sku_resolution', reason: 'Low-confidence SKU resolution: "KS AA BATTRY"', amountCents: 1799 };
const older: QueueItem = { id: 'txn-old', type: 'missing_receipt', reason: 'Target charge — upload the receipt for an item breakdown', amountCents: -2000, transaction: { merchant: 'Target', postedDate: '2026-09-01' } };
const newer: QueueItem = { id: 'txn-new', type: 'missing_receipt', reason: 'Costco charge — upload the receipt for an item breakdown', amountCents: -8412, transaction: { merchant: 'Costco', postedDate: '2026-09-16' } };

describe('QueueView', () => {
  it('puts questions first and offers in their own counted section, newest charge first, without a minus sign', () => {
    const html = renderToStaticMarkup(React.createElement(QueueView, { items: [older, sku, newer] }));
    const t = text(html);
    expect(t).toContain('SKU Resolution');
    expect(t).toMatch(/Receipts you could add\s*\(\s*2\s*\)/);
    expect(t.indexOf('KS AA BATTRY')).toBeLessThan(t.indexOf('Receipts you could add'));
    expect(t.indexOf('Costco')).toBeLessThan(t.indexOf('Target'));
    expect(t).toContain('$84.12');
    expect(t).not.toContain('-$84.12');
    expect(t).not.toMatch(/Unmatched/);
    // The section says "receipt wanted" once, in its heading — rows carry store · date · amount.
    expect(html).toContain('data-queue-section="missing_receipt"');
    expect(html).not.toContain('Receipt wanted');
  });

  it('with only offers, says nothing needs a decision; with nothing at all, shows the empty state', () => {
    const offersOnly = text(renderToStaticMarkup(React.createElement(QueueView, { items: [newer] })));
    expect(offersOnly).toContain('Nothing needs a decision');
    expect(offersOnly).toMatch(/Receipts you could add\s*\(\s*1\s*\)/);
    const empty = text(renderToStaticMarkup(React.createElement(QueueView, { items: [] })));
    expect(empty).toContain('All caught up');
    expect(empty).not.toContain('Receipts you could add');
  });

  it('renders the actions slot for offers when writable', () => {
    const html = renderToStaticMarkup(React.createElement(QueueView, { items: [newer], renderActions: (item) => React.createElement('span', { 'data-actions-for': item.id }, 'acts') }));
    expect(html).toContain('data-actions-for="txn-new"');
  });
});
