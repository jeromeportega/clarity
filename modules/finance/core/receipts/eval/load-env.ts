/**
 * Setup for the `eval` Vitest project only: load the operator's local env
 * files so `npm run vision:eval` can authenticate to the AI Gateway the same
 * way the dev server does (`AI_GATEWAY_API_KEY`, or the `VERCEL_OIDC_TOKEN`
 * written by `vercel env pull`). Existing variables win; a missing file is
 * not an error. The offline `unit` project never runs this.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

for (const name of ['.env.local', '.env']) {
  const file = resolve(process.cwd(), name);
  if (!existsSync(file)) continue;
  try {
    process.loadEnvFile(file);
  } catch {
    // Unreadable or malformed: the eval simply skips for want of credentials.
  }
}
