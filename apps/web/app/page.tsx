import { fetchQueue, resolveHouseholdScope } from '@/lib/queue';
import { QueueView } from './components/queue/QueueView';

export default async function Home() {
  const scope = resolveHouseholdScope();
  const items = await fetchQueue(scope);

  return (
    <main className="mx-auto max-w-4xl px-6 py-8">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Review Queue</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Items needing judgment — low-confidence SKU resolutions, ambiguous matches,
        unmatched transactions, and flagged receipts.
      </p>
      <QueueView items={items} />
    </main>
  );
}
