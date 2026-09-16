import { clerkMiddleware } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

/**
 * Clerk's middleware attaches the session to every request so `auth()` works
 * in pages, route handlers and server actions. It is mounted only when Clerk
 * is configured and this is not the public demo; otherwise every request
 * passes through and there is simply no session. Pages and routes decide for
 * themselves what a missing session means (redirect to sign-in, 403, or the
 * read-only demo) — nothing is protected here.
 *
 * `authorizedParties` pins accepted session tokens to this deployment's own
 * origins (Clerk checks the token's `azp` only when this is set): the
 * production domain, this deployment's URL, and anything in
 * `CLERK_AUTHORIZED_PARTIES` (comma-separated, for custom domains).
 */
const env = process.env;
const configured =
  env.PUBLIC_DEMO_MODE !== '1' &&
  Boolean(env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim() && env.CLERK_SECRET_KEY?.trim());

const authorizedParties = [
  env.VERCEL_PROJECT_PRODUCTION_URL && `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`,
  env.VERCEL_URL && `https://${env.VERCEL_URL}`,
  ...(env.CLERK_AUTHORIZED_PARTIES ?? '').split(',').map((p) => p.trim()),
].filter((p): p is string => Boolean(p));

export default configured
  ? clerkMiddleware(authorizedParties.length > 0 ? { authorizedParties } : undefined)
  : () => NextResponse.next();

export const config = {
  // Everything except Next internals and static assets.
  matcher: ['/((?!_next|.*\\..*).*)', '/(api|trpc)(.*)'],
};
