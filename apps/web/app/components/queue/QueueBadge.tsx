import { Badge, type BadgeProps } from '@/components/ui/badge';
import type { QueueItemType } from '../../../../../modules/finance/core/queue/types';

const BADGE_CONFIG: Record<
  QueueItemType,
  { label: string; variant: BadgeProps['variant'] }
> = {
  sku_resolution: { label: 'SKU Resolution', variant: 'warning' },
  ambiguous_match: { label: 'Ambiguous Match', variant: 'info' },
  unmatched_txn: { label: 'Unmatched', variant: 'destructive' },
  flagged_receipt: { label: 'Flagged Receipt', variant: 'secondary' },
};

interface QueueBadgeProps {
  type: QueueItemType;
}

export function QueueBadge({ type }: QueueBadgeProps) {
  const { label, variant } = BADGE_CONFIG[type];
  return (
    <Badge variant={variant}>
      {label}
    </Badge>
  );
}
