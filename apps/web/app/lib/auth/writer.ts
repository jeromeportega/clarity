import { headers } from 'next/headers';

import { DEMO_HOUSEHOLD_ID } from '../../../../../modules/finance/core/scope';
import { getPrincipal, type Principal } from './session';
import { isValidMutationToken, mutationTokenFromHeaders } from './token';

/**
 * Who is allowed to write, and to which household.
 *
 *   session — a signed-in person, acting on their own household;
 *   token   — a script holding the server-side mutation token, acting on the
 *             demo household (the operator's credential for imports and
 *             eval runs; the bank route additionally checks the account).
 *
 * Every mutation route and server action resolves its household from THIS,
 * never from the request body or a constant.
 */
export type Writer =
  | { via: 'session'; householdId: string; principal: Principal }
  | { via: 'token'; householdId: string };

/**
 * A session write must come from our own pages. Browsers attach cookies to a
 * cross-site top-level navigation but never to a cross-site `fetch` with
 * `SameSite=Lax` cookies; this check is the belt to that braces for API
 * routes, where a session cookie alone is the credential.
 */
function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true; // same-origin fetches and non-browser clients send none
  try {
    return new URL(origin).host === new URL(req.url).host;
  } catch {
    return false;
  }
}

/** For route handlers: the writer, or a 401/403 Response to return as is. */
export async function requireWriter(req: Request): Promise<Writer | Response> {
  const principal = await getPrincipal();
  if (principal) {
    if (!isSameOrigin(req)) return new Response('Forbidden', { status: 403 });
    return { via: 'session', householdId: principal.householdId, principal };
  }
  const token = mutationTokenFromHeaders((name) => req.headers.get(name));
  if (isValidMutationToken(token)) return { via: 'token', householdId: DEMO_HOUSEHOLD_ID };
  return new Response('Unauthorized', { status: 401 });
}

/** For server actions: the writer, or a thrown Error (actions have no Response). */
export async function requireWriterFromAction(): Promise<Writer> {
  const principal = await getPrincipal();
  if (principal) return { via: 'session', householdId: principal.householdId, principal };
  const h = await headers();
  const token = mutationTokenFromHeaders((name) => h.get(name));
  if (isValidMutationToken(token)) return { via: 'token', householdId: DEMO_HOUSEHOLD_ID };
  throw new Error('Unauthorized');
}
