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

function ItemsTable({ items, renderActions }: { items: QueueItem[]; renderActions?: (item: QueueItem) => ReactNode }) {
  return (
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
  );
}

/**
 * Two kinds of row, kept apart: questions the person has to answer, and
 * charges they could explain by adding a receipt. The offers come last, in
 * their own section with a count, newest charge first — a first import can
 * bring dozens, and they are an option, not a backlog.
 */
export function QueueView({ items, renderActions, headerSlot }: QueueViewProps) {
  const questions = items.filter((i) => i.type !== 'missing_receipt');
  const offers = items
    .filter((i) => i.type === 'missing_receipt')
    .sort((a, b) => (b.transaction?.postedDate ?? '').localeCompare(a.transaction?.postedDate ?? ''));
  return (
    <section aria-label="Review queue">
      {headerSlot}
      {questions.length === 0 && offers.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="space-y-10">
          {questions.length === 0 ? (
            <p className="text-sm text-muted-foreground" role="status">
              Nothing needs a decision right now.
            </p>
          ) : (
            <ItemsTable items={questions} renderActions={renderActions} />
          )}
          {offers.length > 0 && (
            <section aria-label="Receipts you could add" data-queue-section="missing_receipt">
              <h2 className="text-lg font-medium">
                Receipts you could add <span className="text-muted-foreground">({offers.length})</span>
              </h2>
              <p className="mb-3 mt-1 text-sm text-muted-foreground">
                Recent charges at stores whose receipts break down into items. Upload a receipt and the charge
                becomes items with categories; skip one and the charge simply stays as it is.
              </p>
              <ItemsTable items={offers} renderActions={renderActions} />
            </section>
          )}
        </div>
      )}
    </section>
  );
}
