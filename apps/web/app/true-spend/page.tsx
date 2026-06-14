import { notFound } from 'next/navigation';
import { fetchBreakdown, resolveHouseholdScope } from '../../lib/truespend';
import { TrueSpendView } from '../components/truespend/TrueSpendView';

export const dynamic = 'force-dynamic';

interface TrueSpendPageProps {
  searchParams: { month?: string } | Promise<{ month?: string }>;
}

export default async function TrueSpendPage({ searchParams }: TrueSpendPageProps) {
  if (!process.env.PUBLIC_DEMO_MODE) {
    notFound();
  }

  const params = searchParams instanceof Promise ? await searchParams : searchParams;
  const month = params.month;

  const scope = resolveHouseholdScope();
  const breakdown = await fetchBreakdown(scope, month);

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">True Spend</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Item-level category breakdown
          {month ? ` for ${month}` : ''}.
          Totals reflect any corrections made in the review queue.
        </p>
      </div>
      <TrueSpendView breakdown={breakdown} />
    </main>
  );
}
