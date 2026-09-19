import type { ReactNode } from 'react';
import { TableCell, TableRow } from '@/components/ui/table';
import type { QueueItem, QueueItemContext } from '../../../../../modules/finance/core/queue/types';
import { QueueBadge } from './QueueBadge';
import { ReceiptThumb } from './ReceiptThumb';

function formatCents(cents: number): string {
  const abs = Math.abs(cents);
  const dollars = (abs / 100).toFixed(2);
  return cents < 0 ? `-$${dollars}` : `$${dollars}`;
}

interface QueueItemRowProps {
  item: QueueItem;
  renderActions?: (item: QueueItem) => ReactNode;
}

/** One line of what the person needs to decide: where, when, and the model's current answer. */
function contextLine(item: QueueItem, ctx: QueueItemContext): string {
  const where = [ctx.store, ctx.purchasedAt].filter((v): v is string => Boolean(v)).join(' · ');
  if (item.type === 'sku_resolution') {
    const answer = ctx.canonicalName
      ? `read as “${ctx.canonicalName}”${ctx.categoryId ? ` (${ctx.categoryId})` : ''}`
      : 'no name resolved';
    const qty = ctx.quantity && ctx.quantity !== 1 ? ` × ${ctx.quantity}` : '';
    const code = ctx.sku ? `item ${ctx.sku}` : 'no item number';
    return [where, `${code}${qty}`, answer].filter(Boolean).join(' · ');
  }
  const lines = ctx.itemCount === undefined ? '' : `${ctx.itemCount} line${ctx.itemCount === 1 ? '' : 's'} read`;
  return [where, lines].filter(Boolean).join(' · ');
}

export function QueueItemRow({ item, renderActions }: QueueItemRowProps) {
  const ctx = item.context;
  return (
    <TableRow data-queue-item-id={item.id} data-queue-item-type={item.type}>
      <TableCell>
        <QueueBadge type={item.type} />
      </TableCell>
      <TableCell>
        <div className="flex items-start gap-3">
          {ctx?.hasImage && <ReceiptThumb receiptId={ctx.receiptId} alt={ctx.store ?? 'receipt'} />}
          <div className="min-w-0">
            <div className="text-muted-foreground">{item.reason}</div>
            {item.transaction && (
              <div className="mt-0.5 text-xs text-muted-foreground/80" data-queue-context>
                {item.transaction.merchant} · {item.transaction.postedDate}
              </div>
            )}
            {ctx && (
              <div className="mt-0.5 text-xs text-muted-foreground/80" data-queue-context>
                {contextLine(item, ctx)}
                {item.type === 'sku_resolution' && (
                  <>
                    {' · '}
                    <a href={`/true-spend/evidence/${encodeURIComponent(item.id)}`} className="underline underline-offset-2 hover:text-foreground">
                      evidence
                    </a>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {item.amountCents !== undefined ? formatCents(item.amountCents) : null}
      </TableCell>
      {renderActions && (
        <TableCell className="text-right">{renderActions(item)}</TableCell>
      )}
    </TableRow>
  );
}
