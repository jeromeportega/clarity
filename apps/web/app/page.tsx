import { createDb } from '../../../modules/finance/db/client';
import { gatewayFor } from '../../../modules/finance/core/reconciliation/gateway';
import { assembleQueue } from '../../../modules/finance/core/queue/assemble';
import { DEMO_HOUSEHOLD_ID } from '../../../modules/finance/core/scope';
import { QueueView } from './components/queue/QueueView';

export default async function Home() {
  const scope = { householdId: DEMO_HOUSEHOLD_ID };
  const db = createDb();
  const gw = gatewayFor(process.env as Parameters<typeof gatewayFor>[0]);
  const items = await assembleQueue(scope, gw, db);

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
