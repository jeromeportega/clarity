import { fetchQueue, resolveHouseholdScope } from '@/lib/queue';

export async function GET(): Promise<Response> {
  // Demo-mode gate: this route serves household financial data without a user
  // session. It must only be reachable when PUBLIC_DEMO_MODE is explicitly
  // enabled. Story-004-007 adds full auth; this guard prevents silent exposure
  // if that env var is never set in a non-demo deploy.
  if (!process.env.PUBLIC_DEMO_MODE) {
    return new Response('Forbidden', { status: 403 });
  }

  const scope = resolveHouseholdScope();
  const items = await fetchQueue(scope);
  return Response.json(items);
}
