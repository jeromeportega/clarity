/**
 * The model ids the live seams use, in AI Gateway form (`provider/model`).
 *
 * The core never chooses a model at runtime — the composition root
 * (`apps/web/lib/receipt-pipeline.ts`) and the eval harness read these and
 * pass a model in. Both are overridable by environment so an operator can move
 * to a newer model, or a cheaper one, without a code change:
 *
 *   CLARITY_VISION_MODEL    — reads the receipt image (needs image + PDF input)
 *   CLARITY_RESOLVER_MODEL  — resolves one abbreviated line to a product + category
 *
 * Ids come from https://ai-gateway.vercel.sh/v1/models; a wrong id fails at
 * the first request, never silently.
 */
export const DEFAULT_VISION_MODEL_ID = 'anthropic/claude-opus-5';
export const DEFAULT_RESOLVER_MODEL_ID = 'anthropic/claude-sonnet-5';

export function visionModelId(env: Record<string, string | undefined> = process.env): string {
  return env.CLARITY_VISION_MODEL?.trim() || DEFAULT_VISION_MODEL_ID;
}

export function resolverModelId(env: Record<string, string | undefined> = process.env): string {
  return env.CLARITY_RESOLVER_MODEL?.trim() || DEFAULT_RESOLVER_MODEL_ID;
}

/**
 * Whether live model calls are on. `RECEIPT_AI=live|recorded` decides
 * outright; otherwise a credential in the environment decides — an AI Gateway
 * API key (local scripts, CI, other hosts) or a pulled Vercel OIDC token
 * (local dev after `vercel env pull`). Merely running on Vercel is NOT enough:
 * a deployment's OIDC token is delivered per request, not as an env var, and
 * only when the project has OIDC federation on — so a deployment opts in with
 * `RECEIPT_AI=live` (or an API key) rather than being billed by default; every
 * preview and the public demo stay on recorded fixtures.
 */
export function liveModelsAvailable(env: Record<string, string | undefined> = process.env): boolean {
  const forced = env.RECEIPT_AI?.trim().toLowerCase();
  if (forced === 'live') return true;
  if (forced === 'recorded') return false;
  return Boolean(env.AI_GATEWAY_API_KEY?.trim() || env.VERCEL_OIDC_TOKEN?.trim());
}
