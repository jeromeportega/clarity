'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { CorrectionDialog } from './CorrectionDialog';
import type { QueueItem } from '../../../../../modules/finance/core/queue/types';
import type { CorrectionVariant } from '../../../../../modules/finance/core/corrections/apply';
import { confirmItem, dismissItem, correctItem } from '@/app/actions/queue';

interface QueueItemActionsProps {
  item: QueueItem;
  onActed?: (itemId: string) => void;
}

export function QueueItemActions({ item, onActed }: QueueItemActionsProps) {
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function performAction(action: 'confirm' | 'dismiss'): Promise<void> {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const fn = action === 'confirm' ? confirmItem : dismissItem;
      await fn(item.id, item.type);
      onActed?.(item.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed. Please try again.');
    } finally {
      setPending(false);
    }
  }

  async function performCorrection(correction: CorrectionVariant): Promise<void> {
    await correctItem(item.id, item.type, correction);
    onActed?.(item.id);
    // Any error propagates to CorrectionDialog's handleSubmit, which keeps the dialog open
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-1">
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
      </div>

      {error && (
        <p className="text-xs text-destructive" role="alert">{error}</p>
      )}

      <CorrectionDialog
        item={item}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSubmit={performCorrection}
      />
    </div>
  );
}
