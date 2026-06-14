'use client';

import { useState } from 'react';
import type { TrueSpendCategory } from '../../../../../modules/finance/core/truespend/assemble';

function formatCents(cents: number): string {
  const abs = Math.abs(cents);
  const dollars = (abs / 100).toFixed(2);
  return cents < 0 ? `-$${dollars}` : `$${dollars}`;
}

interface CategoryRowProps {
  category: TrueSpendCategory;
}

export function CategoryRow({ category }: CategoryRowProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <tr
        data-testid="category-row"
        data-category={category.category}
        className="border-b border-border"
      >
        <td className="py-3 px-4">
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${category.category}`}
            className="flex items-center gap-2 font-medium capitalize text-foreground hover:text-primary transition-colors"
            onClick={() => setExpanded((v) => !v)}
          >
            <span
              className="inline-block w-4 text-muted-foreground transition-transform duration-150"
              aria-hidden="true"
              style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
            >
              ▶
            </span>
            {category.category.replace(/_/g, ' ')}
          </button>
        </td>
        <td className="py-3 px-4 text-right tabular-nums font-medium">
          {formatCents(category.netCents)}
        </td>
        <td className="py-3 px-4 text-right text-muted-foreground text-sm">
          {category.items.length} {category.items.length === 1 ? 'item' : 'items'}
        </td>
      </tr>
      {expanded &&
        category.items.map((item) => (
          <tr
            key={item.id}
            data-testid="spend-item"
            data-item-id={item.id}
            className="border-b border-border bg-muted/30"
          >
            <td className="py-2 px-8 text-sm text-muted-foreground">{item.description}</td>
            <td className="py-2 px-4 text-right tabular-nums text-sm">
              {formatCents(item.amountCents)}
            </td>
            <td className="py-2 px-4 text-right">
              <a
                href={`/true-spend/evidence/${item.id}`}
                aria-label={`View evidence for ${item.description}`}
                className="text-xs text-primary underline underline-offset-2 hover:opacity-80"
                data-testid="evidence-link"
              >
                Evidence
              </a>
            </td>
          </tr>
        ))}
    </>
  );
}
