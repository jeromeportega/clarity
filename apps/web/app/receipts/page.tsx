// Explicit React import for vitest/esbuild compatibility (classic JSX transform).
import React from 'react';

import { resolveReadScope } from '../../lib/public-mode';
import { ReceiptDrop } from '../components/receipts/ReceiptDrop';

export const dynamic = 'force-dynamic';

// Browser uploads ride the session cookie: a signed-in person uploads into
// their own household. The public demo (read-only scope) and a deployment
// without sign-in keep uploads disabled in the UI; the API route remains
// available to token-holding scripts.
export default async function ReceiptsPage() {
  const scope = await resolveReadScope();
  const enabled = scope !== null && scope.readonly !== true;
  return (
    <main className="mx-auto max-w-xl px-4 py-12">
      <h1 className="mb-8 text-2xl font-semibold">Upload a Receipt</h1>
      <ReceiptDrop enabled={enabled} />
    </main>
  );
}
