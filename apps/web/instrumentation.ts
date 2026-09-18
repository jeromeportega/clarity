export async function register() {
  const env = process.env;
  if (!env.RECONCILE_MUTATION_TOKEN) {
    console.error(
      '[startup] RECONCILE_MUTATION_TOKEN is not set. ' +
        'All mutation routes (confirm/correct/dismiss/upload) will return 401. ' +
        'Generate a value with: openssl rand -hex 32',
    );
  }
  // Plaid is all-or-nothing: credentials without the token key would leave
  // access tokens unencryptable, and an unknown PLAID_ENV would point the SDK
  // nowhere. Say so at startup rather than at the first sync.
  const plaidCreds = Boolean(env.PLAID_CLIENT_ID?.trim() && env.PLAID_SECRET?.trim());
  const plaidEnvOk = env.PLAID_ENV === 'sandbox' || env.PLAID_ENV === 'production';
  if (plaidCreds && (!plaidEnvOk || !env.PLAID_TOKEN_KEY?.trim())) {
    console.error(
      '[startup] Plaid credentials are set but ' +
        (!plaidEnvOk ? 'PLAID_ENV is not sandbox|production' : 'PLAID_TOKEN_KEY is missing') +
        '. Bank sync will refuse to run until both are set (PLAID_TOKEN_KEY: openssl rand -hex 32).',
    );
  }
  const clerkKeys = Boolean(env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim() && env.CLERK_SECRET_KEY?.trim());
  if (clerkKeys && env.PUBLIC_DEMO_MODE === '1') {
    console.error(
      '[startup] PUBLIC_DEMO_MODE=1 with Clerk keys set: the keys are ignored — the public demo has no sign-in. ' +
        'Unset one of the two.',
    );
  }
  if (clerkKeys && env.PUBLIC_DEMO_MODE !== '1' && !env.CLARITY_OPERATOR_EMAILS?.trim()) {
    console.error(
      '[startup] Sign-in is configured but CLARITY_OPERATOR_EMAILS is not set: nobody can be given a household, ' +
        'so every sign-in lands on /no-access. Set it to the operator email(s), comma-separated.',
    );
  }
}
