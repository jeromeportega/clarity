'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { connectSandbox, syncBanks, type BankActionResult } from '@/app/actions/banks';

const MESSAGES: Record<string, string> = {
  demo: 'The public demo has no bank behind it.',
  plaid_not_configured: 'Plaid is not configured on this deployment.',
  sandbox_only: 'Test banks can only be connected in the Plaid sandbox.',
  already_connected: 'That test bank is already connected; use Sync now.',
  failed: 'That did not work. The error is in the server log.',
};

function describe(result: BankActionResult): string {
  if (!result.ok) return MESSAGES[result.code] ?? 'Something went wrong.';
  if ('connected' in result) {
    const base = `Connected: ${result.connected.accountsCreated} account(s), ${result.connected.added} transaction(s) pulled.`;
    return result.connected.stillPreparing ? `${base} The bank is still preparing its history — sync again in a minute.` : base;
  }
  const ok = result.result.items.filter((i) => i.ok);
  const added = ok.reduce((n, i) => n + (i.summary?.added ?? 0), 0);
  const modified = ok.reduce((n, i) => n + (i.summary?.modified ?? 0), 0);
  const removed = ok.reduce((n, i) => n + (i.summary?.removed ?? 0), 0);
  const preparing = ok.filter((i) => i.summary?.updateStatus === 'not_ready').length;
  const failed = result.result.items.length - ok.length;
  const parts = [`${added} new`, `${modified} changed`, `${removed} removed`];
  if (preparing > 0) parts.push(`${preparing} still preparing history`);
  if (failed > 0) parts.push(`${failed} bank(s) failed`);
  return `Synced ${ok.length} bank(s): ${parts.join(', ')}.`;
}

/**
 * The two things a person does on the Banks page today: pull new activity,
 * and — in the sandbox only — connect Plaid's test institution. Link (a real
 * bank) is the next step and will sit beside these.
 */
export function BankActions({ sandbox, hasBanks }: { sandbox: boolean; hasBanks: boolean }) {
  const router = useRouter();
  const [pending, setPending] = React.useState<'sync' | 'connect' | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);

  async function run(kind: 'sync' | 'connect') {
    if (pending) return;
    setPending(kind);
    setMessage(null);
    try {
      const result = kind === 'sync' ? await syncBanks() : await connectSandbox();
      setMessage(describe(result));
      if (result.ok) router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Action failed. Please try again.');
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={pending !== null || !hasBanks} onClick={() => void run('sync')} aria-label="Sync banks now">
          {pending === 'sync' ? 'Syncing…' : 'Sync now'}
        </Button>
        {sandbox && (
          <Button size="sm" variant="outline" disabled={pending !== null} onClick={() => void run('connect')} aria-label="Connect a sandbox test bank">
            {pending === 'connect' ? 'Connecting…' : 'Connect a test bank (sandbox)'}
          </Button>
        )}
      </div>
      {message && (
        <p className="text-sm text-muted-foreground" role="status">
          {message}
        </p>
      )}
    </div>
  );
}
