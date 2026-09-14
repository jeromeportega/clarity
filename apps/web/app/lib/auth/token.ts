import { timingSafeEqual } from 'node:crypto';

/**
 * The shared-secret mutation gate. This module is the ONLY place that reads
 * RECONCILE_MUTATION_TOKEN (a test enforces it), and it exposes boolean checks
 * only — nothing here returns, logs, or serializes the secret.
 *
 * Header contract: `x-reconcile-token` (primary) or `Authorization: Bearer`
 * (deprecated — emits console.warn when used).
 */

const HEADER = 'x-reconcile-token';

/**
 * Constant-time check of a caller-supplied token against the configured secret.
 * Fails closed when the secret is unset or empty. Both sides are trimmed so a
 * trailing newline in an env value can't silently 401 every write.
 */
export function isValidMutationToken(provided: string | null | undefined): boolean {
  const secret = process.env.RECONCILE_MUTATION_TOKEN?.trim();
  if (!secret) return false;

  const candidate = (provided ?? '').trim();
  if (!candidate) return false;

  const secretBuf = Buffer.from(secret, 'utf8');
  const providedBuf = Buffer.from(candidate, 'utf8');

  // Compare against a buffer padded/truncated to the secret's byte-length so
  // timingSafeEqual never receives unequal-length inputs; a separate length
  // check still rejects any token whose byte-length differs from the secret's.
  // Both are computed before branching — no early exit.
  const compareBuf = Buffer.alloc(secretBuf.length, 0);
  providedBuf.copy(compareBuf);
  const lengthMatch = secretBuf.length === providedBuf.length;
  const contentMatch = timingSafeEqual(secretBuf, compareBuf);
  return lengthMatch && contentMatch;
}

/** Extract the caller's token from a header accessor (Request or next/headers). */
export function mutationTokenFromHeaders(get: (name: string) => string | null): string | null {
  const direct = get(HEADER);
  if (direct !== null) return direct;

  const auth = get('authorization');
  if (auth?.startsWith('Bearer ')) {
    console.warn(`[requireMutationToken] Authorization: Bearer is deprecated; switch to ${HEADER}`);
    return auth.slice('Bearer '.length);
  }
  return null;
}

/**
 * Returns null if the request carries a valid mutation token, or a Response(401) if not.
 * Usage: `const denied = requireMutationToken(req); if (denied) return denied;`
 */
export function requireMutationToken(req: Request): Response | null {
  const provided = mutationTokenFromHeaders((name) => req.headers.get(name));
  return isValidMutationToken(provided) ? null : new Response('Unauthorized', { status: 401 });
}
