import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Plaid access tokens at rest. A token is a standing credential to a person's
 * bank data, so it never sits in the database in the clear: AES-256-GCM with a
 * server-side key (`PLAID_TOKEN_KEY`, 64 hex chars), a fresh nonce per token,
 * and the auth tag bound to the ciphertext. The stored form is
 * `v1:<base64 nonce>:<base64 tag>:<base64 ciphertext>` so the scheme can
 * change later without guessing at old rows.
 */
const VERSION = 'v1';

export function parseTokenKey(hex: string | undefined): Buffer {
  const trimmed = hex?.trim() ?? '';
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error('PLAID_TOKEN_KEY must be 64 hex characters (32 bytes); generate one with `openssl rand -hex 32`');
  }
  return Buffer.from(trimmed, 'hex');
}

export function encryptToken(plain: string, key: Buffer): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, nonce.toString('base64'), tag.toString('base64'), body.toString('base64')].join(':');
}

export function decryptToken(stored: string, key: Buffer): string {
  const [version, nonce64, tag64, body64] = stored.split(':');
  if (version !== VERSION || !nonce64 || !tag64 || !body64) {
    throw new Error('stored Plaid token is not in a form this build can read');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce64, 'base64'));
  decipher.setAuthTag(Buffer.from(tag64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(body64, 'base64')), decipher.final()]).toString('utf8');
}
