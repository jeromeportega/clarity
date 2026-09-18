'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { CorrectionDialog } from './CorrectionDialog';
import type { QueueItem } from '../../../../../modules/finance/core/queue/types';
import type { CorrectionVariant } from '../../../../../modules/finance/core/corrections/apply';
import { confirmItem, dismissItem, correctItem } from '@/app/actions/queue';
import { readReceiptAgain } from '@/app/actions/receipts';

interface QueueItemActionsProps {
  item: QueueItem;
  onActed?: (itemId: string) => void;
}

const READ_AGAIN_MESSAGES: Record<string, string> = {
  still_unreadable: 'Still could not read this photo. Try a clearer picture, or dismiss it.',
  not_found: 'This receipt is no longer here.',
  has_items: 'This receipt already has line items; decide it here instead.',
  no_image: 'The photo for this receipt is not stored, so it cannot be read again.',
  unsupported_image: 'The stored photo is not a type the reader supports.',
  image_mismatch: 'The stored photo does not match this receipt.',
};

export function QueueItemActions({ item, onActed }: QueueItemActionsProps) {
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // An unreadable photo can be read again: on a readable result the row
  // changes or disappears (refresh); on another unreadable result nothing was
  // written and the person is told rather than left wondering.
  async function performReadAgain(): Promise<void> {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await readReceiptAgain(item.id);
      if (!result.ok) {
        setError(READ_AGAIN_MESSAGES[result.code] ?? 'Could not read the receipt again.');
        return;
      }
      onActed?.(item.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed. Please try again.');
    } finally {
      setPending(false);
    }
  }

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
        {item.type === 'flagged_receipt' && item.unreadable && (
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => void performReadAgain()}
            aria-label={`Read receipt ${item.id} again`}
          >
            Read again
          </Button>
        )}
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
