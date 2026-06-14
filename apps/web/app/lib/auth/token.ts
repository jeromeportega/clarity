import { timingSafeEqual } from 'node:crypto';

/**
 * Throws a Response(401) if the request does not carry a valid x-reconcile-token.
 *
 * Uses constant-time comparison (Security T6) to prevent timing attacks. The
 * comparison buffer is normalised to the secret's byte-length so timingSafeEqual
 * never receives unequal-length inputs; a separate length check still rejects
 * tokens of a different length.
 */
export function requireMutationToken(req: Request): void {
  const secret = process.env.RECONCILE_MUTATION_TOKEN;
  if (!secret) {
    throw new Response('Unauthorized', { status: 401 });
  }

  const provided = req.headers.get('x-reconcile-token') ?? '';

  const secretBuf = Buffer.from(secret, 'utf8');
  const providedBuf = Buffer.from(provided, 'utf8');

  // Normalize provided to the same byte-length as secret. timingSafeEqual
  // requires equal-length buffers; the separate length check below rejects
  // any token whose byte-length differs from the secret's.
  const compareBuf = Buffer.alloc(secretBuf.length, 0);
  providedBuf.copy(compareBuf);

  const lengthMatch = secretBuf.length === providedBuf.length;
  const contentMatch = timingSafeEqual(secretBuf, compareBuf);

  if (!lengthMatch || !contentMatch) {
    throw new Response('Unauthorized', { status: 401 });
  }
}
