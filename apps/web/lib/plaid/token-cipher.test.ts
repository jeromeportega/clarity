import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { decryptToken, encryptToken, keyId, parseTokenKey } from './token-cipher';

const freshKey = () => parseTokenKey(randomBytes(32).toString('hex'));
const binding = { householdId: 'hh-1', itemId: 'item-1' };

describe('Plaid token cipher', () => {
  const key = freshKey();

  it('round-trips a token and never stores it in the clear', () => {
    const stored = encryptToken('access-sandbox-abc', key, binding);
    expect(stored.startsWith(`v2:${keyId(key)}:`)).toBe(true);
    expect(stored).not.toContain('access-sandbox');
    expect(decryptToken(stored, key, binding)).toBe('access-sandbox-abc');
  });

  it('uses a fresh nonce every time', () => {
    expect(encryptToken('same', key, binding)).not.toBe(encryptToken('same', key, binding));
  });

  it('refuses a tampered ciphertext and a wrong key', () => {
    const stored = encryptToken('access-sandbox-abc', key, binding);
    const parts = stored.split(':');
    const body = Buffer.from(parts[4]!, 'base64');
    body[0] = body[0]! ^ 0xff;
    parts[4] = body.toString('base64');
    expect(() => decryptToken(parts.join(':'), key, binding)).toThrow(/does not belong/);
  });

  it('names the key it was written with, so a rotated PLAID_TOKEN_KEY fails with the reason rather than a bare auth error', () => {
    const stored = encryptToken('access-sandbox-abc', key, binding);
    expect(() => decryptToken(stored, freshKey(), binding)).toThrow(/different PLAID_TOKEN_KEY/);
  });

  it('is bound to the household and Item: a ciphertext copied onto another row does not decrypt', () => {
    const stored = encryptToken('access-sandbox-abc', key, binding);
    expect(() => decryptToken(stored, key, { householdId: 'hh-2', itemId: 'item-1' })).toThrow(/does not belong/);
    expect(() => decryptToken(stored, key, { householdId: 'hh-1', itemId: 'item-2' })).toThrow(/does not belong/);
  });

  it('requires a 32-byte hex key and rejects an unknown storage version', () => {
    expect(() => parseTokenKey('abc')).toThrow(/64 hex/);
    expect(() => parseTokenKey(undefined)).toThrow(/64 hex/);
    expect(() => decryptToken('v0:a:b:c:d', key, binding)).toThrow(/not in a form/);
  });

  it('a pre-release v1 row (no key id, no binding) fails closed with its own reason', () => {
    expect(() => decryptToken('v1:bm9uY2U=:dGFn:Ym9keQ==', key, binding)).toThrow(/earlier build; reconnect/);
  });

  it('binds the ids unambiguously: shifting the separator between them is a different binding', () => {
    const stored = encryptToken('access-sandbox-abc', key, { householdId: 'a:b', itemId: 'c' });
    expect(() => decryptToken(stored, key, { householdId: 'a', itemId: 'b:c' })).toThrow(/does not belong/);
  });
});
