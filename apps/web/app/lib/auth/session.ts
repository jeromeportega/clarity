import { auth, currentUser } from '@clerk/nextjs/server';

import { resolveMembership } from '../../../../../modules/finance/core/auth/membership';
import { createDb, type FinanceDb } from '../../../../../modules/finance/db/client';

/**
 * The signed-in person, resolved to the household they act on. This is the
 * ONLY place the identity provider is consulted; everything else in the app
 * asks for a Principal and never sees a session, a cookie or a Clerk id.
 */
export interface Principal {
  userId: string;
  email: string | null;
  householdId: string;
  role: 'owner' | 'member';
}

/**
 * Sign-in exists only when Clerk is configured. Without the keys — tests, the
 * public demo, a fresh clone — there is no session anywhere: reads fall back
 * to demo mode where enabled, writes to the script token, and nothing here
 * ever throws for want of configuration.
 */
export function isClerkConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim() && env.CLERK_SECRET_KEY?.trim());
}

let _db: FinanceDb | undefined;
function getDb(): FinanceDb {
  _db ??= createDb();
  return _db;
}

/**
 * The current request's principal, or null when nobody is signed in (or
 * sign-in is not configured). A first sign-in provisions the person's own
 * household (see `core/auth/membership.ts`).
 */
export async function getPrincipal(db: FinanceDb = getDb()): Promise<Principal | null> {
  if (!isClerkConfigured()) return null;

  let userId: string | null;
  try {
    ({ userId } = await auth());
  } catch {
    // Outside a request (a build-time render, a test) there is no session.
    return null;
  }
  if (!userId) return null;

  const user = await currentUser().catch(() => null);
  const email = user?.primaryEmailAddress?.emailAddress ?? user?.emailAddresses[0]?.emailAddress ?? null;
  const displayName = user?.fullName ?? user?.firstName ?? null;

  const membership = await resolveMembership(db, { userId, email, displayName });
  return { userId, email, householdId: membership.householdId, role: membership.role };
}
