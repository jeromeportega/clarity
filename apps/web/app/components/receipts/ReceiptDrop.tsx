'use client';

// Explicit React import for vitest/esbuild compatibility (classic JSX transform).
import React, { useRef, useState } from 'react';

import type { ReceiptItemRecord } from '../../../../../modules/finance/core/receipts/store/receipt-store';
import type { UploadedReceiptResult } from '../../../../../modules/finance/core/receipts/upload';

// Pure presentational component — exported for unit tests.
export function ReceiptItemList({ items }: { items: ReceiptItemRecord[] }) {
  if (items.length === 0) return null;
  return (
    <ul role="list" className="mt-4 divide-y divide-border rounded-lg border text-sm">
      {items.map((item) => (
        <li
          key={item.id}
          role="listitem"
          className="flex items-center justify-between px-4 py-2"
        >
          <span>{item.rawDescription}</span>
          <span className="tabular-nums text-muted-foreground">
            ${(item.linePriceCents / 100).toFixed(2)}
          </span>
        </li>
      ))}
    </ul>
  );
}

type UploadState =
  | { phase: 'idle' }
  | { phase: 'uploading' }
  | { phase: 'done'; result: UploadedReceiptResult }
  | { phase: 'error'; message: string };

export function ReceiptDrop() {
  const [state, setState] = useState<UploadState>({ phase: 'idle' });
  const inputRef = useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    setState({ phase: 'uploading' });

    const form = new FormData();
    form.append('file', file);

    try {
      const res = await fetch('/api/receipts/upload', {
        method: 'POST',
        headers: { 'x-reconcile-token': process.env.NEXT_PUBLIC_RECONCILE_MUTATION_TOKEN ?? '' },
        body: form,
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setState({ phase: 'error', message: body.error ?? `Upload failed (${res.status})` });
        return;
      }

      const result = (await res.json()) as UploadedReceiptResult;
      setState({ phase: 'done', result });
    } catch {
      setState({ phase: 'error', message: 'Network error — please try again.' });
    }
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) void upload(file);
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) void upload(file);
  }

  return (
    <div className="space-y-4">
      <div
        role="region"
        aria-label="Receipt upload"
        onDrop={onDrop}
        onDragOver={(e) => e.preventDefault()}
        onClick={() => inputRef.current?.click()}
        className="flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-muted-foreground/40 p-8 text-center transition hover:border-muted-foreground/70"
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/*,application/pdf"
          onChange={onFileChange}
          className="sr-only"
          aria-label="Choose receipt file"
        />
        {state.phase === 'uploading' ? (
          <p className="text-muted-foreground">Processing receipt…</p>
        ) : (
          <>
            <p className="font-medium">Drop a receipt photo or PDF here</p>
            <p className="mt-1 text-sm text-muted-foreground">or click to browse</p>
          </>
        )}
      </div>

      {state.phase === 'error' && (
        <p role="alert" className="text-sm text-destructive">
          {state.message}
        </p>
      )}

      {state.phase === 'done' && (
        <div>
          <p className="text-sm text-muted-foreground">
            {state.result.idempotent ? 'Already processed — showing existing items.' : `Found ${state.result.items.length} item(s).`}
          </p>
          <ReceiptItemList items={state.result.items} />
        </div>
      )}
    </div>
  );
}

export default ReceiptDrop;
