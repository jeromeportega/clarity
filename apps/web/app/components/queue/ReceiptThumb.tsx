'use client';

import * as React from 'react';

/**
 * A small view of the photographed receipt behind a queue row, served by the
 * read-scoped image route. The route answers 404 when nothing is stored
 * (images predating durable storage, a store miss), so a failed load simply
 * removes the thumbnail rather than leaving a broken-image glyph.
 */
export function ReceiptThumb({ receiptId, alt }: { receiptId: string; alt: string }) {
  const [failed, setFailed] = React.useState(false);
  if (failed) return null;
  const src = `/api/receipts/image/${encodeURIComponent(receiptId)}`;
  return (
    <a href={src} target="_blank" rel="noopener" className="block shrink-0" aria-label={`Open the receipt photo: ${alt}`}>
      {/* A plain <img>: the source is a same-origin, cookie-gated API route, not a static asset. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} className="h-20 w-14 rounded border object-cover object-top" />
    </a>
  );
}
