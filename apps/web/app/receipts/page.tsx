// Explicit React import for vitest/esbuild compatibility (classic JSX transform).
import React from 'react';

import { receiptCapableMerchant } from '../../../../modules/finance/core/queue/receipt-capable';
import { createDb, type FinanceDb } from '../../../../modules/finance/db/client';
import { resolveReadScope } from '../../lib/public-mode';
import { fetchChargeSummary } from '../../lib/transactions';
import { ReceiptDrop } from '../components/receipts/ReceiptDrop';

let _db: FinanceDb | undefined;
function getDb(): FinanceDb {
  _db ??= createDb();
  return _db;
}

/** A charge, as a person says it: "$84.12", never "-$84.12". */
function formatCharge(cents: number): string {
  return `$${(Math.abs(cents) / 100).toFixed(2)}`;
}

export const dynamic = 'force-dynamic';

// Browser uploads ride the session cookie: a signed-in person uploads into
// their own household. The public demo (read-only scope) and a deployment
// without sign-in keep uploads disabled in the UI; the API route remains
// available to token-holding scripts.
export default async function ReceiptsPage({ searchParams }: { searchParams?: Record<string, string | string[] | undefined> }) {
  const scope = await resolveReadScope();
  const enabled = scope !== null && scope.readonly !== true;
  // Arrived from a "Receipt wanted" row: name the charge, scoped to this
  // household — an id from another household shows nothing.
  const txnParam = searchParams?.txn;
  const txnId = typeof txnParam === 'string' && txnParam.length > 0 && txnParam.length <= 128 ? txnParam : null;
  const charge = scope && txnId ? await fetchChargeSummary(getDb(), scope, txnId) : null;
  return (
    <main className="mx-auto max-w-xl px-4 py-12">
      <h1 className="mb-2 text-2xl font-semibold">Upload a Receipt</h1>
      {charge ? (
        <p className="mb-8 text-sm text-muted-foreground" data-upload-for={charge.id}>
          For the {receiptCapableMerchant(charge.merchant) ?? charge.merchant} charge of {formatCharge(charge.amountCents)} on{' '}
          {charge.postedDate}. Once read, Clarity will try to match the receipt to this charge, and the charge becomes
          items with categories.
        </p>
      ) : (
        <div className="mb-8" />
      )}
      <ReceiptDrop enabled={enabled} />
    </main>
  );
}
