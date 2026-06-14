export async function register() {
  if (!process.env.RECONCILE_MUTATION_TOKEN) {
    console.error(
      '[startup] RECONCILE_MUTATION_TOKEN is not set. ' +
        'All mutation routes (confirm/correct/dismiss/upload) will return 401. ' +
        'Generate a value with: openssl rand -hex 32',
    );
  }
}
