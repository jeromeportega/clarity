import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { decryptToken, encryptToken, parseTokenKey } from './token-cipher';

describe('Plaid token cipher', () => {
  const key = parseTokenKey(randomBytes(32).toString('hex'));

  it('round-trips a token and never stores it in the clear', () => {
    const stored = encryptToken('access-sandbox-abc', key);
    expect(stored.startsWith('v1:')).toBe(true);
    expect(stored).not.toContain('access-sandbox');
    expect(decryptToken(stored, key)).toBe('access-sandbox-abc');
  });

  it('uses a fresh nonce every time', () => {
    expect(encryptToken('same', key)).not.toBe(encryptToken('same', key));
  });

  it('refuses a tampered ciphertext and a wrong key', () => {
    const stored = encryptToken('access-sandbox-abc', key);
    const parts = stored.split(':');
    const body = Buffer.from(parts[3]!, 'base64');
    body[0] = body[0]! ^ 0xff;
    parts[3] = body.toString('base64');
    expect(() => decryptToken(parts.join(':'), key)).toThrow();
    expect(() => decryptToken(stored, parseTokenKey(randomBytes(32).toString('hex')))).toThrow();
  });

  it('requires a 32-byte hex key and rejects an unknown storage version', () => {
    expect(() => parseTokenKey('abc')).toThrow(/64 hex/);
    expect(() => parseTokenKey(undefined)).toThrow(/64 hex/);
    expect(() => decryptToken('v0:a:b:c', key)).toThrow(/not in a form/);
  });
});
