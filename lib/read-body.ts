/**
 * A request body, or null once it is past `maxBytes`. Zero imports: the unit
 * suite loads this file directly.
 *
 * For the routes `proxy.ts` lets through without a session, where nothing else
 * limits the body. `request.text()` buffers all of it before anything can look,
 * and a chunked request declares no length, so a header check alone leaves the
 * process to run out of memory. The declared length is still the cheap first
 * refusal; after that the bytes are counted as they arrive and the stream is
 * dropped at the cap.
 */
export async function readBodyCapped(request: Request, maxBytes: number): Promise<Buffer | null> {
  if (Number.parseInt(request.headers.get("content-length") ?? "0", 10) > maxBytes) return null;
  if (!request.body) return Buffer.alloc(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
}
