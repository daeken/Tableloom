/** Bound streamed bytes before allocating a complete private download. */
export async function readTransferBytes(
  response: Response,
  limit: number,
  signal: AbortSignal,
) {
  const declared = response.headers.get("content-length");
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      response.headers.get("content-type") ?? "",
    ) ||
    (declared !== null &&
      (!/^\d+$/.test(declared) || Number(declared) > limit)) ||
    !response.body
  ) {
    await response.body?.cancel();
    throw new Error("Unexpected download response.");
  }
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("Download limit exceeded.");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
