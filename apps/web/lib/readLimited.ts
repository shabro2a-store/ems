/**
 * The request body, read up to `maxBytes` and no further.
 *
 * req.formData() and friends read the whole body before anything can look at
 * its size, so one large upload could fill the web container's memory. This
 * refuses a body that says it is too large without reading it, and stops - and
 * cancels the rest - the moment a body without a length passes the limit.
 */
export async function readBodyLimited(req: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | 'TOO_LARGE'> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await req.body?.cancel().catch(() => {});
    return 'TOO_LARGE';
  }
  if (!req.body) return new Uint8Array(new ArrayBuffer(0));

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return 'TOO_LARGE';
    }
    chunks.push(value);
  }
  const out = new Uint8Array(new ArrayBuffer(total));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}
