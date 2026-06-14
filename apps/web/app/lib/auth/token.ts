import { timingSafeEqual } from 'node:crypto';

/**
 * Returns null if the request carries a valid mutation token, or a Response(401) if not.
 *
 * Accepts x-reconcile-token (primary) and Authorization: Bearer <token> (deprecated —
 * emits console.warn when used). Uses constant-time comparison (Security T6) so
 * timingSafeEqual never receives unequal-length buffers; a separate length check still
 * rejects tokens whose byte-length differs from the secret's.
 *
 * Usage: `const denied = requireMutationToken(req); if (denied) return denied;`
 */
export function requireMutationToken(req: Request): Response | null {
  const secret = process.env.RECONCILE_MUTATION_TOKEN;
  if (!secret) {
    return new Response('Unauthorized', { status: 401 });
  }

  let provided = req.headers.get('x-reconcile-token');
  if (provided === null) {
    const authHeader = req.headers.get('authorization');
    if (authHeader?.startsWith('Bearer ')) {
      provided = authHeader.slice('Bearer '.length);
      console.warn(
        '[requireMutationToken] Authorization: Bearer is deprecated; switch to x-reconcile-token',
      );
    }
  }

  if (!provided) {
    return new Response('Unauthorized', { status: 401 });
  }

  const secretBuf = Buffer.from(secret, 'utf8');
  const providedBuf = Buffer.from(provided, 'utf8');

  // Normalize provided to the same byte-length as secret so timingSafeEqual
  // never receives unequal-length inputs; the separate length check rejects
  // any token whose byte-length differs from the secret's.
  const compareBuf = Buffer.alloc(secretBuf.length, 0);
  providedBuf.copy(compareBuf);

  const lengthMatch = secretBuf.length === providedBuf.length;
  const contentMatch = timingSafeEqual(secretBuf, compareBuf);

  if (!lengthMatch || !contentMatch) {
    return new Response('Unauthorized', { status: 401 });
  }

  return null;
}
