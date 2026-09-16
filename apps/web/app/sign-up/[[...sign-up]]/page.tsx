import { SignUp } from '@clerk/nextjs';

import { isClerkConfigured } from '../../lib/auth/session';

export const dynamic = 'force-dynamic';

export default function SignUpPage() {
  if (!isClerkConfigured()) {
    return (
      <main className="mx-auto max-w-xl px-6 py-12">
        <h1 className="mb-2 text-2xl font-semibold">Sign-up is not set up on this deployment</h1>
        <p className="text-sm text-muted-foreground">
          This deployment has no identity provider configured; it serves the public demo only.
        </p>
      </main>
    );
  }
  return (
    <main className="mx-auto flex max-w-xl justify-center px-6 py-12">
      <SignUp />
    </main>
  );
}
