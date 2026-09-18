import { createDb, type FinanceDb } from '../../../../modules/finance/db/client';
import { fetchBanks, type BankAccountView } from '../../lib/banks';
import { isPlaidConfigured, plaidEnv } from '../../lib/plaid/client';
import { readScopeOrRedirect } from '../../lib/public-mode';
import { BankActions } from '../components/banks/BankActions';

export const dynamic = 'force-dynamic';

let _db: FinanceDb | undefined;
function getDb(): FinanceDb {
  _db ??= createDb();
  return _db;
}

function AccountRows({ rows }: { rows: BankAccountView[] }) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No accounts yet.</p>;
  return (
    <ul className="divide-y rounded border">
      {rows.map((a) => (
        <li key={a.id} className="flex items-center justify-between gap-4 px-3 py-2 text-sm" data-account-id={a.id}>
          <div className="min-w-0">
            <div className="truncate font-medium">{a.name}</div>
            <div className="text-xs text-muted-foreground">
              {[a.type, a.source === 'plaid' ? 'synced' : a.source].filter(Boolean).join(' · ')}
            </div>
          </div>
          <div className="shrink-0 text-right text-xs text-muted-foreground tabular-nums">
            {a.transactionCount} transaction{a.transactionCount === 1 ? '' : 's'}
            {a.latestPostedDate ? ` · latest ${a.latestPostedDate}` : ''}
          </div>
        </li>
      ))}
    </ul>
  );
}

const STATUS_LABEL: Record<string, string> = {
  ok: 'Connected',
  error: 'Last sync failed',
  login_required: 'Needs re-authentication at the bank',
};

/**
 * Banks: the household's connected institutions (Plaid Items) with their
 * accounts and sync state, plus any accounts that came from files. Writes
 * (sync, sandbox connect) are for a signed-in person; the public demo and a
 * deployment without Plaid configured see a read-only list.
 */
export default async function BanksPage() {
  const scope = await readScopeOrRedirect();
  const banks = await fetchBanks(getDb(), scope);
  const configured = isPlaidConfigured();
  const canWrite = scope.readonly !== true && configured;

  return (
    <main className="mx-auto max-w-4xl px-6 py-8">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Banks</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Connected institutions and their accounts. Transactions sync from the bank through Plaid and land in the
        review queue and True Spend like any other statement.
        {!configured ? ' Plaid is not configured on this deployment.' : ''}
        {scope.readonly ? ' This is the public demo: connecting and syncing are disabled.' : ''}
      </p>

      {canWrite && (
        <div className="mb-8">
          <BankActions sandbox={plaidEnv() === 'sandbox'} hasBanks={banks.connected.length > 0} />
        </div>
      )}

      <section aria-label="Connected banks" className="space-y-6">
        {banks.connected.length === 0 ? (
          <p className="text-sm text-muted-foreground">No banks connected yet.</p>
        ) : (
          banks.connected.map((bank) => (
            <div key={bank.plaidItemId} className="space-y-2" data-plaid-item-id={bank.plaidItemId}>
              <div className="flex items-baseline justify-between gap-4">
                <h2 className="text-lg font-medium">{bank.institutionName ?? 'Bank'}</h2>
                <span className="text-xs text-muted-foreground">
                  {STATUS_LABEL[bank.status] ?? bank.status}
                  {bank.lastSyncedAt ? ` · synced ${bank.lastSyncedAt.slice(0, 16).replace('T', ' ')}` : ' · never synced'}
                </span>
              </div>
              {bank.status === 'error' && (
                <p className="text-xs text-destructive" role="alert">
                  The last sync did not complete. Try Sync now; if it keeps failing, the details are in the server log.
                </p>
              )}
              {bank.status === 'login_required' && (
                <p className="text-xs text-destructive" role="alert">
                  The bank needs you to sign in again before more activity can be pulled.
                </p>
              )}
              <AccountRows rows={bank.accounts} />
            </div>
          ))
        )}
      </section>

      {banks.other.length > 0 && (
        <section aria-label="Other accounts" className="mt-10 space-y-2">
          <h2 className="text-lg font-medium">Other accounts</h2>
          <p className="text-xs text-muted-foreground">From statement files or made by hand.</p>
          <AccountRows rows={banks.other} />
        </section>
      )}
    </main>
  );
}
