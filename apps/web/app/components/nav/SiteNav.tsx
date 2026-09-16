import Link from 'next/link';
import { SignInButton, UserButton } from '@clerk/nextjs';

import { isClerkConfigured, getPrincipal } from '../../lib/auth/session';

/**
 * The header on every page: where to go, and who you are. Server component —
 * it reads the principal once per request and renders the right affordance:
 * the user menu when signed in, a sign-in button when sign-in exists, and a
 * "public demo" badge when it does not.
 */
export async function SiteNav() {
  const configured = isClerkConfigured();
  const principal = configured ? await getPrincipal() : null;
  const demo = process.env.PUBLIC_DEMO_MODE === '1';

  return (
    <header className="border-b">
      <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-6 py-3">
        <nav className="flex items-center gap-4 text-sm">
          <Link href="/" className="font-semibold tracking-tight">Clarity</Link>
          <Link href="/" className="text-muted-foreground hover:text-foreground">Review queue</Link>
          <Link href="/true-spend" className="text-muted-foreground hover:text-foreground">True spend</Link>
          <Link href="/receipts" className="text-muted-foreground hover:text-foreground">Receipts</Link>
        </nav>
        <div className="flex items-center gap-3 text-sm">
          {demo && !principal && (
            <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">public demo · read-only</span>
          )}
          {principal ? (
            <>
              <span className="hidden text-muted-foreground sm:inline">{principal.email ?? 'signed in'}</span>
              <UserButton />
            </>
          ) : configured ? (
            <SignInButton mode="modal">
              <button type="button" className="rounded border px-3 py-1 hover:bg-muted">Sign in</button>
            </SignInButton>
          ) : null}
        </div>
      </div>
    </header>
  );
}
