'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { CorrectionDialog } from './CorrectionDialog';
import type { QueueItem } from '../../../../../modules/finance/core/queue/types';
import type { CorrectionVariant } from '../../../../../modules/finance/core/corrections/apply';

interface QueueItemActionsProps {
  item: QueueItem;
  token: string;
  onActed?: (itemId: string) => void;
}

export function QueueItemActions({ item, token, onActed }: QueueItemActionsProps) {
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);

  async function performAction(
    action: 'confirm' | 'dismiss',
  ): Promise<void> {
    if (pending) return;
    setPending(true);
    try {
      const res = await fetch(`/api/queue/${item.id}/${action}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ itemType: item.type }),
      });
      if (res.ok) {
        onActed?.(item.id);
      }
    } finally {
      setPending(false);
    }
  }

  async function performCorrection(correction: CorrectionVariant): Promise<void> {
    if (pending) return;
    setPending(true);
    try {
      const res = await fetch(`/api/queue/${item.id}/correct`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ itemType: item.type, correction }),
      });
      if (res.ok) {
        onActed?.(item.id);
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex gap-1 justify-end">
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => void performAction('confirm')}
        aria-label={`Confirm item ${item.id}`}
      >
        Confirm
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => setDialogOpen(true)}
        aria-label={`Correct item ${item.id}`}
      >
        Correct
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        onClick={() => void performAction('dismiss')}
        aria-label={`Dismiss item ${item.id}`}
      >
        Dismiss
      </Button>

      <CorrectionDialog
        item={item}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSubmit={(correction) => void performCorrection(correction)}
      />
    </div>
  );
}
