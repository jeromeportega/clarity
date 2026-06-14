import { fetchBreakdown, resolveHouseholdScope } from '../../../lib/truespend';

export async function GET(request: Request): Promise<Response> {
  if (!process.env.PUBLIC_DEMO_MODE) {
    return new Response('Forbidden', { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const month = searchParams.get('month') ?? undefined;

  const scope = resolveHouseholdScope();
  const breakdown = await fetchBreakdown(scope, month);
  return Response.json(breakdown);
}
