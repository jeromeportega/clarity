/**
 * Reject a request whose declared body exceeds `maxBytes` BEFORE it is
 * buffered by `request.formData()` / `request.json()`.
 *
 * Opportunistic by nature: only enforced when Content-Length is present
 * (chunked multipart uploads may omit it), so the per-file size checks that
 * run after parsing still apply. Call it after the auth gate.
 */
export function rejectOversizedBody(req: Request, maxBytes: number): Response | null {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return Response.json({ error: 'Payload too large' }, { status: 413 });
  }
  return null;
}
