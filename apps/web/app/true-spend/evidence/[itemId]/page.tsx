import { notFound } from 'next/navigation';
import { fetchEvidence } from '../../../lib/truespend';
import type { EvidenceRef } from '../../../../modules/finance/core/evidence/types';

interface EvidencePageProps {
  params: { itemId: string } | Promise<{ itemId: string }>;
}

export default async function EvidencePage({ params }: EvidencePageProps) {
  if (!process.env.PUBLIC_DEMO_MODE) {
    notFound();
  }

  const { itemId } = params instanceof Promise ? await params : params;
  const evidence = await fetchEvidence(itemId);

  if (evidence.kind === 'not_found') {
    notFound();
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Evidence</h1>
        <p className="mt-1 text-sm text-muted-foreground">Source record for item {itemId}</p>
      </div>
      <EvidenceDetail evidence={evidence} />
    </main>
  );
}

function EvidenceDetail({ evidence }: { evidence: EvidenceRef }) {
  if (evidence.kind === 'receipt_region') {
    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-border p-4">
          <p className="text-sm font-medium text-muted-foreground mb-2">Receipt image</p>
          {evidence.bbox ? (
            <p className="text-xs text-muted-foreground">
              Region: x={evidence.bbox.x.toFixed(3)}, y={evidence.bbox.y.toFixed(3)},
              w={evidence.bbox.width.toFixed(3)}, h={evidence.bbox.height.toFixed(3)}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">Full image (no region coordinates available)</p>
          )}
          <a
            href={evidence.imageUrl}
            aria-label="View full receipt image"
            className="mt-3 inline-block text-sm text-primary underline underline-offset-2 hover:opacity-80"
            target="_blank"
            rel="noreferrer"
          >
            View receipt image
          </a>
        </div>
      </div>
    );
  }

  if (evidence.kind === 'amazon_order_row') {
    return (
      <div className="rounded-lg border border-border p-4 space-y-2">
        <p className="text-sm font-medium text-muted-foreground">Amazon order</p>
        <p className="text-sm">Order ID: <span className="font-mono">{evidence.orderId}</span></p>
        <p className="text-sm">Item ID: <span className="font-mono">{evidence.orderItemId}</span></p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border p-4 space-y-2">
      <p className="text-sm font-medium text-muted-foreground">Bank transaction</p>
      <p className="text-sm">Transaction ID: <span className="font-mono">{evidence.transactionId}</span></p>
    </div>
  );
}
