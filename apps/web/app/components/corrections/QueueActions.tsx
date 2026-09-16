'use client';

import { useRouter } from 'next/navigation';

import type { QueueItem } from '../../../../../modules/finance/core/queue/types';
import { QueueItemActions } from './QueueItemActions';

/**
 * The queue page is server-rendered; after a decision lands the row must go
 * away, so the client re-fetches the page from the server rather than editing
 * a local copy of the list.
 */
export function QueueActions({ item }: { item: QueueItem }) {
  const router = useRouter();
  return <QueueItemActions item={item} onActed={() => router.refresh()} />;
}
