import { fetchQueue, resolveHouseholdScope } from '@/lib/queue';

export async function GET(): Promise<Response> {
  const scope = resolveHouseholdScope();
  const items = await fetchQueue(scope);
  return Response.json(items);
}
