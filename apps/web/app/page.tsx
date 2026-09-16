import { redirect } from 'next/navigation';

import { fetchQueue } from '@/lib/queue';
import { resolveReadScope } from '@/lib/public-mode';
import { QueueActions } from './components/corrections/QueueActions';
import { QueueView } from './components/queue/QueueView';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const scope = await resolveReadScope();
  if (!scope) redirect('/sign-in');
  const items = await fetchQueue(scope);

  return (
    <main className="mx-auto max-w-4xl px-6 py-8">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Review Queue</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Items needing judgment — low-confidence SKU resolutions, ambiguous matches,
        unmatched transactions, and flagged receipts.
        {scope.readonly ? ' This is the public demo: decisions are disabled.' : ''}
      </p>
      <QueueView
        items={items}
        renderActions={scope.readonly ? undefined : (item) => <QueueActions item={item} />}
      />
    </main>
  );
}
