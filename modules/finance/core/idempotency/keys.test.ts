import { describe, expect, it } from 'vitest';

import { sha256Hex, transactionDedupKey } from './keys';

describe('sha256Hex', () => {
  it('is deterministic and returns 64 lowercase hex chars', () => {
    const digest = sha256Hex('hello');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex('hello')).toBe(digest);
    expect(sha256Hex('world')).not.toBe(digest);
  });

  it('matches the published SHA-256 test vector for "abc"', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('transactionDedupKey', () => {
  const base = {
    accountId: 'acc-1',
    postedDate: '2026-01-05',
    amountCents: -1299,
    normalizedMerchant: 'ACME',
    sourceRowHash: 'row-1',
  };

  it('is stable for identical inputs', () => {
    expect(transactionDedupKey(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(transactionDedupKey(base)).toBe(transactionDedupKey({ ...base }));
  });

  it('changes when any contributing field changes', () => {
    const key = transactionDedupKey(base);
    expect(transactionDedupKey({ ...base, accountId: 'acc-2' })).not.toBe(key);
    expect(transactionDedupKey({ ...base, postedDate: '2026-01-06' })).not.toBe(key);
    expect(transactionDedupKey({ ...base, amountCents: -1300 })).not.toBe(key);
    expect(transactionDedupKey({ ...base, normalizedMerchant: 'OTHER' })).not.toBe(key);
    expect(transactionDedupKey({ ...base, sourceRowHash: 'row-2' })).not.toBe(key);
  });

  it('does not collide when field boundaries shift (delimited canonicalization)', () => {
    const a = transactionDedupKey({ ...base, accountId: 'a', postedDate: 'b' });
    const b = transactionDedupKey({ ...base, accountId: 'ab', postedDate: '' });
    expect(a).not.toBe(b);
  });
});
