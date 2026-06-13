import { createHash } from 'node:crypto';

/** SHA-256 hex digest of a UTF-8 string. Adapters use it to compute `sourceRowHash`. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Field separator for canonicalization. A NUL byte cannot appear inside any
 * field (UUIDs, ISO dates, normalized merchant text), so two distinct field
 * tuples can never collapse to the same canonical string.
 */
const FIELD_SEP = String.fromCharCode(0);

/**
 * The transaction idempotency key (FR-16): SHA-256 hex of the canonicalized
 * (account + posted date + signed amount + normalized merchant + source-row
 * hash). Called by `persist.ts`, NOT by adapters, and enforced at the DB by the
 * `ux_transactions_dedup` unique index.
 */
export function transactionDedupKey(p: {
  accountId: string;
  postedDate: string;
  amountCents: number;
  normalizedMerchant: string;
  sourceRowHash: string;
}): string {
  const canonical = [
    p.accountId,
    p.postedDate,
    String(p.amountCents),
    p.normalizedMerchant,
    p.sourceRowHash,
  ].join(FIELD_SEP);
  return sha256Hex(canonical);
}
