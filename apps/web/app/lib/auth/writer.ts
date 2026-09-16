import { headers } from 'next/headers';

import { DEMO_HOUSEHOLD_ID } from '../../../../../modules/finance/core/scope';
import { getPrincipal, type Principal } from './session';
import { isValidMutationToken, mutationTokenFromHeaders } from './token';

/**
 * Who is allowed to write, and to which household.
 *
 *   session — a signed-in person, acting on their own household and no other;
 *   token   — a script holding the server-side mutation token: the OPERATOR's
 *             credential. It defaults to the demo household, and two routes
 *             let it name another (`/api/ingest/bank` by account,
 *             `/api/reconcile` by household id) — it is cross-tenant by
 *             design, which is why it lives only in the server environment.
 *
 * Every mutation route and server action resolves its household from THIS;
 * a session writer's household never comes from the request.
 */
export type Writer =
  | { via: 'session'; householdId: string; principal: Principal }
  | { via: 'token'; householdId: string };

/**
 * A session write must come from our own pages; the session cookie alone is
 * the credential on an API route, so the request must prove it was not
 * cross-site. Browsers say so directly with `Sec-Fetch-Site` (`same-origin`,
 * or `none` for a user-typed navigation); older ones say it with `Origin`,
 * which must match the public host — read from `X-Forwarded-Host`/`Host` and
 * `X-Forwarded-Proto`, because behind a proxy `request.url` is the internal
 * address. A request that proves neither is refused: a session writer is
 * always a browser, and browsers always send one of the two.
 */
export function isSameOrigin(req: Request): boolean {
  const site = req.headers.get('sec-fetch-site');
  if (site) return site === 'same-origin' || site === 'none';

  const origin = req.headers.get('origin');
  const host = (req.headers.get('x-forwarded-host') ?? req.headers.get('host'))?.split(',')[0]?.trim();
  if (!origin || !host) return false;
  let proto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  try {
    proto ??= new URL(req.url).protocol.replace(':', '');
    const o = new URL(origin);
    return o.host === host && o.protocol === `${proto}:`;
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
