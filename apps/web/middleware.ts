import { clerkMiddleware } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

/**
 * Clerk's middleware attaches the session to every request so `auth()` works
 * in pages, route handlers and server actions. It is only mounted when Clerk
 * is configured; without the keys (tests, the public demo, a fresh clone)
 * every request passes through and there is simply no session. Pages and
 * routes decide for themselves what a missing session means (redirect to
 * sign-in, 403, or the read-only demo) — nothing is protected here.
 */
const configured = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim() && process.env.CLERK_SECRET_KEY?.trim());

export default configured ? clerkMiddleware() : () => NextResponse.next();

export const config = {
  // Everything except Next internals and static assets.
  matcher: ['/((?!_next|.*\\..*).*)', '/(api|trpc)(.*)'],
};
