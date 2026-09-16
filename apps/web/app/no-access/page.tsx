import { UserButton } from '@clerk/nextjs';
import { redirect } from 'next/navigation';

import { getPrincipal, getSession } from '../lib/auth/session';

export const dynamic = 'force-dynamic';

/**
 * A signed-in person who has no household on this deployment. Sign-in is
 * open (Clerk's default); membership is not: only an operator-allowlisted
 * email is given a household of their own, and anyone else lands here —
 * signed in, with nothing to see and nothing to write.
 */
export default async function NoAccessPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  if (await getPrincipal()) redirect('/');
  return (
    <main className="mx-auto max-w-xl px-6 py-12">
      <h1 className="mb-2 text-2xl font-semibold">This deployment is private</h1>
      <p className="text-sm text-muted-foreground">
        You are signed in{session.email ? ` as ${session.email}` : ''}, but this deployment has no household for you.
        Ask its operator to add your email, then sign in again.
      </p>
      <div className="mt-6">
        <UserButton />
      </div>
    </main>
  );
}
