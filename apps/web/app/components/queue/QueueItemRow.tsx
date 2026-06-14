import type { ReactNode } from 'react';
import { TableCell, TableRow } from '@/components/ui/table';
import type { QueueItem } from '../../../../../modules/finance/core/queue/types';
import { QueueBadge } from './QueueBadge';

function formatCents(cents: number): string {
  const abs = Math.abs(cents);
  const dollars = (abs / 100).toFixed(2);
  return cents < 0 ? `-$${dollars}` : `$${dollars}`;
}

interface QueueItemRowProps {
  item: QueueItem;
  renderActions?: (item: QueueItem) => ReactNode;
}

export function QueueItemRow({ item, renderActions }: QueueItemRowProps) {
  return (
    <TableRow data-queue-item-id={item.id} data-queue-item-type={item.type}>
      <TableCell>
        <QueueBadge type={item.type} />
      </TableCell>
      <TableCell className="text-muted-foreground">{item.reason}</TableCell>
      <TableCell className="text-right tabular-nums">
        {item.amountCents !== undefined ? formatCents(item.amountCents) : null}
      </TableCell>
      {renderActions && (
        <TableCell className="text-right">{renderActions(item)}</TableCell>
      )}
    </TableRow>
  );
}
