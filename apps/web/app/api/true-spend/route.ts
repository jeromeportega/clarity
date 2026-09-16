import { resolveReadScope } from '../../../lib/public-mode';
import { fetchBreakdown } from '../../../lib/truespend';

// Every API route serves live household data; never prerender.
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const scope = await resolveReadScope();
  if (!scope) return new Response('Forbidden', { status: 403 });

  const { searchParams } = new URL(request.url);
  const rawMonth = searchParams.get('month');
  if (rawMonth !== null && !/^\d{4}-\d{2}$/.test(rawMonth)) {
    return new Response('Bad Request: month must be YYYY-MM', { status: 400 });
  }
  const month = rawMonth ?? undefined;

  const breakdown = await fetchBreakdown(scope, month);
  return Response.json(breakdown);
}
