import type { ReactNode } from 'react';
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { QueueItem } from '../../../../../modules/finance/core/queue/types';
import { EmptyState } from './EmptyState';
import { QueueItemRow } from './QueueItemRow';

interface QueueViewProps {
  items: QueueItem[];
  /** Optional action renderer; omit for a read-only queue. */
  renderActions?: (item: QueueItem) => ReactNode;
  /** Optional slot rendered above the table; used for upload controls etc. */
  headerSlot?: ReactNode;
}

export function QueueView({ items, renderActions, headerSlot }: QueueViewProps) {
  return (
    <section aria-label="Review queue">
      {headerSlot}
      {items.length === 0 ? (
        <EmptyState />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-40">Type</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead className="w-32 text-right">Amount</TableHead>
              {renderActions && <TableHead className="w-24 text-right">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <QueueItemRow key={`${item.type}::${item.id}`} item={item} renderActions={renderActions} />
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
