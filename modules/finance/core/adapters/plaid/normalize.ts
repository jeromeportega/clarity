import { cleanBankMerchant } from '../bank/merchant';
import { sha256Hex } from '../../idempotency/keys';
import type { NormalizedTransaction } from '../../model/normalized';
import type { PlaidAccount, PlaidTransaction } from './plaid-client';

// =============================================================================
// Plaid → the house model. Same conventions as the file adapters so the
// reconciler, True Spend and the queue see one kind of transaction:
//   - integer cents, SIGNED: debits (money out) are negative, credits positive;
//     Plaid reports the opposite sign in dollars, so the sign flips here.
//   - `normalizedMerchant` through the same cleaner the bank adapter uses.
//   - `sourceRowHash` is stable per Plaid transaction id, so the dedup key is
//     stable across syncs regardless of how the bank rewords the line.
// =============================================================================

export interface NormalizedPlaidTransaction extends NormalizedTransaction {
  externalId: string;
  pending: boolean;
  pendingExternalId: string | null;
  categoryHint: string | null;
}

export function toCents(amountDollars: number): number {
  // Plaid amounts are decimal dollars (two places in practice); round to the
  // cent rather than truncate float noise. Math.round rounds a half toward +∞.
  return Math.round(amountDollars * 100);
}

export function normalizePlaidTransaction(t: PlaidTransaction): NormalizedPlaidTransaction {
  const amountCents = -toCents(t.amount);
  const rawMerchant = t.merchantName ?? t.name;
  return {
    postedDate: t.date,
    amountCents,
    direction: amountCents < 0 ? 'debit' : 'credit',
    rawMerchant,
    normalizedMerchant: cleanBankMerchant(rawMerchant),
    sourceRowHash: sha256Hex(`plaid:${t.transactionId}`),
    externalId: t.transactionId,
    pending: t.pending,
    pendingExternalId: t.pendingTransactionId,
    categoryHint: t.categoryDetailed,
  };
}

/** Our `accounts.type`: the subtype for deposit accounts, else Plaid's type. */
export function accountTypeFor(a: PlaidAccount): string {
  if (a.type === 'depository') return a.subtype ?? 'depository';
  if (a.type === 'credit') return 'credit';
  return a.type;
}

/** A display name: the bank's official name when it has one, else Plaid's. */
export function accountNameFor(a: PlaidAccount): string {
  const base = (a.officialName ?? a.name).trim();
  return a.mask ? `${base} ····${a.mask}` : base;
}
