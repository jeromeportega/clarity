import { Badge, type BadgeProps } from '@/components/ui/badge';
import type { QueueItemType } from '../../../../../modules/finance/core/queue/types';

type BadgeConfig = { label: string; variant: BadgeProps['variant'] };

const BADGE_CONFIG = {
  sku_resolution: { label: 'SKU Resolution', variant: 'warning' },
  ambiguous_match: { label: 'Ambiguous Match', variant: 'info' },
  unmatched_txn: { label: 'Unmatched', variant: 'destructive' },
  flagged_receipt: { label: 'Flagged Receipt', variant: 'secondary' },
} as const satisfies Record<QueueItemType, BadgeConfig>;

interface QueueBadgeProps {
  type: QueueItemType;
}

export function QueueBadge({ type }: QueueBadgeProps) {
  const config: BadgeConfig = BADGE_CONFIG[type] ?? { label: type, variant: 'outline' };
  return (
    <Badge variant={config.variant}>
      {config.label}
    </Badge>
  );
}
