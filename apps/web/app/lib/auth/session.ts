import * as React from 'react';
import { auth, currentUser } from '@clerk/nextjs/server';

/**
 * Memoise a lookup for the life of one request. Next's bundled React has
 * `cache`; the stable React the test runner resolves does not, and there a
 * plain call is the same thing (no request spans two calls).
 */
function perRequest<F extends (...args: never[]) => unknown>(fn: F): F {
  const cache = (React as { cache?: <G>(fn: G) => G }).cache;
  return cache ? cache(fn) : fn;
}

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

/** Who Clerk says is signed in — before we know whether they belong anywhere. */
export interface Session {
  userId: string;
  email: string | null;
  displayName: string | null;
}

/**
 * Sign-in exists only when Clerk is configured AND this is not the public
 * demo. Without the keys — tests, a fresh clone — there is no session
 * anywhere; with `PUBLIC_DEMO_MODE=1` the keys are ignored outright, so a
 * demo can never show one household's page with another household's
 * writer behind it. Nothing here ever throws for want of configuration.
 */
export function isClerkConfigured(env: Record<string, string | undefined> = process.env): boolean {
  if (env.PUBLIC_DEMO_MODE === '1') return false;
  return Boolean(env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim() && env.CLERK_SECRET_KEY?.trim());
}

/**
 * Who may be given a household of their own on first sign-in: the operator's
 * email(s), `CLARITY_OPERATOR_EMAILS` (comma-separated, case-insensitive).
 * Unset means nobody — a deployment with sign-in but no allowlist admits no
 * one, rather than everyone who finds the URL.
 */
export function isProvisionAllowed(email: string | null, env: Record<string, string | undefined> = process.env): boolean {
  if (!email) return false;
  const allowed = (env.CLARITY_OPERATOR_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
  return allowed.includes(email.trim().toLowerCase());
}

let _db: FinanceDb | undefined;
function getDb(): FinanceDb {
  _db ??= createDb();
  return _db;
}

/**
 * The current request's Clerk session, or null (nobody signed in, sign-in
 * not configured, or no request context — a build-time render, a test).
 * Cached per request: the layout, the pages and the routes all ask.
 */
export const getSession = perRequest(async (): Promise<Session | null> => {
  if (!isClerkConfigured()) return null;
  let userId: string | null;
  try {
    ({ userId } = await auth());
  } catch {
    return null;
  }
  if (!userId) return null;
  const user = await currentUser().catch(() => null);
  return {
    userId,
    email: user?.primaryEmailAddress?.emailAddress ?? user?.emailAddresses[0]?.emailAddress ?? null,
    displayName: user?.fullName ?? user?.firstName ?? null,
  };
});

/**
 * The current request's principal, or null when nobody is signed in, or the
 * signed-in person has no household here and may not be given one. A first
 * sign-in by an allowlisted email provisions their household
 * (see `core/auth/membership.ts`). Cached per request.
 */
export const getPrincipal = perRequest(async (db?: FinanceDb): Promise<Principal | null> => {
  const session = await getSession();
  if (!session) return null;
  const membership = await resolveMembership(db ?? getDb(), session, {
    provision: isProvisionAllowed(session.email),
  });
  if (!membership) return null;
  return { userId: session.userId, email: session.email, householdId: membership.householdId, role: membership.role };
});
