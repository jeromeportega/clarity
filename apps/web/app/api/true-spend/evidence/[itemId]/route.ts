import { resolveReadScope } from '../../../../../lib/public-mode';
import { fetchEvidence } from '../../../../../lib/truespend';

// Every API route serves live household data; never prerender.
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  context: { params: { itemId: string } | Promise<{ itemId: string }> },
): Promise<Response> {
  const scope = await resolveReadScope();
  if (!scope) return new Response('Forbidden', { status: 403 });

  const params = context.params instanceof Promise
    ? await context.params
    : context.params;
  const { itemId } = params;

  if (!itemId) {
    return new Response('Bad Request', { status: 400 });
  }

  const evidence = await fetchEvidence(itemId, scope);

  if (evidence.kind === 'not_found') {
    return new Response('Not Found', { status: 404 });
  }

  return Response.json(evidence);
}
