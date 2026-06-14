import { fetchBreakdown, resolveHouseholdScope } from '../../../lib/truespend';

export async function GET(request: Request): Promise<Response> {
  if (!process.env.PUBLIC_DEMO_MODE) {
    return new Response('Forbidden', { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const rawMonth = searchParams.get('month');
  if (rawMonth !== null && !/^\d{4}-\d{2}$/.test(rawMonth)) {
    return new Response('Bad Request: month must be YYYY-MM', { status: 400 });
  }
  const month = rawMonth ?? undefined;

  const scope = resolveHouseholdScope();
  const breakdown = await fetchBreakdown(scope, month);
  return Response.json(breakdown);
}
