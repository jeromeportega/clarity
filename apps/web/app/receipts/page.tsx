// Explicit React import for vitest/esbuild compatibility (classic JSX transform).
import React from 'react';

import { ReceiptDrop } from '../components/receipts/ReceiptDrop';

// Browser-initiated uploads have no legitimate auth path yet: the only write
// credential is the server-side mutation token, which must never be sent to
// the client. Uploads stay disabled in the UI until real sign-in exists; the
// API route remains available to token-holding scripts.
const UPLOADS_ENABLED = false;

export default function ReceiptsPage() {
  return (
    <main className="mx-auto max-w-xl px-4 py-12">
      <h1 className="mb-8 text-2xl font-semibold">Upload a Receipt</h1>
      <ReceiptDrop enabled={UPLOADS_ENABLED} />
    </main>
  );
}
