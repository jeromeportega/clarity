import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Plaid access tokens at rest. A token is a standing credential to a person's
 * bank data, so it never sits in the database in the clear: AES-256-GCM with a
 * server-side key (`PLAID_TOKEN_KEY`, 64 hex chars), a fresh nonce per token,
 * the auth tag bound to the ciphertext, and the ciphertext BOUND TO ITS ROW —
 * the household and the Plaid Item id are the additional authenticated data,
 * so a ciphertext copied into another household's row does not decrypt.
 *
 * Stored form: `v1:<key id>:<base64 nonce>:<base64 tag>:<base64 ciphertext>`.
 * The key id (a hash prefix of the key, never the key) names which key wrote
 * the row, so a rotated `PLAID_TOKEN_KEY` fails with a sentence, not a
 * cryptic authentication error.
 */
const VERSION = 'v1';

export interface TokenBinding {
  householdId: string;
  /** Plaid's item_id. */
  itemId: string;
}

export function parseTokenKey(hex: string | undefined): Buffer {
  const trimmed = hex?.trim() ?? '';
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error('PLAID_TOKEN_KEY must be 64 hex characters (32 bytes); generate one with `openssl rand -hex 32`');
  }
  return Buffer.from(trimmed, 'hex');
}

export function keyId(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8);
}

function aad(binding: TokenBinding): Buffer {
  return Buffer.from(`${binding.householdId}:${binding.itemId}`, 'utf8');
}

export function encryptToken(plain: string, key: Buffer, binding: TokenBinding): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad(binding));
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, keyId(key), nonce.toString('base64'), tag.toString('base64'), body.toString('base64')].join(':');
}

export function decryptToken(stored: string, key: Buffer, binding: TokenBinding): string {
  const [version, kid, nonce64, tag64, body64] = stored.split(':');
  if (version !== VERSION || !kid || !nonce64 || !tag64 || !body64) {
    throw new Error('stored Plaid token is not in a form this build can read');
  }
  if (kid !== keyId(key)) {
    throw new Error('stored Plaid token was encrypted with a different PLAID_TOKEN_KEY; reconnect the bank or restore the key');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce64, 'base64'));
  decipher.setAAD(aad(binding));
  decipher.setAuthTag(Buffer.from(tag64, 'base64'));
  try {
    return Buffer.concat([decipher.update(Buffer.from(body64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    // GCM failed to authenticate: tampered, or bound to another household / Item.
    throw new Error('stored Plaid token does not belong to this bank connection');
  }
}
