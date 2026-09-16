import { fetchQueue } from '@/lib/queue';
import { resolveReadScope } from '@/lib/public-mode';

// This handler reads no request data, so without this Next would prerender
// it at build time and serve a frozen queue until the next deploy.
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  // Household financial data: served to the public demo's read-only scope
  // when PUBLIC_DEMO_MODE is set, or to a signed-in person for their own
  // household. No scope, no data.
  const scope = await resolveReadScope();
  if (!scope) return new Response('Forbidden', { status: 403 });

  const items = await fetchQueue(scope);
  return Response.json(items);
}
