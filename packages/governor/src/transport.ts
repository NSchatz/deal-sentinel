/**
 * THE ONLY MODULE IN THIS REPOSITORY THAT MAY REACH AN HTTP CLIENT.
 *
 * Ruling R2 of spec S0023-deal-sentinel-governor-2 leaves the choice of client
 * to the implementer, bounded by the repository's $0/month constraint and by
 * the requirement that exactly one module reaches it. Node 22's built-in
 * `fetch` is that client: no new runtime dependency, no supply chain, and one
 * module to allowlist.
 *
 * `test/unit/no-direct-http.test.ts` scans the whole tree for a second one and
 * fails the suite if it finds it, so the sentence at the top of this file is a
 * property of the repository rather than a promise in a comment. If you are
 * here to add a client call somewhere else: don't. Take a `HttpTransport` and
 * let the governor hand you one.
 *
 * The response body is read through a reader with a byte cap rather than with
 * `response.text()`, because the robots gate's parsing limit has to bound what
 * enters this process, not what survives after it is already here.
 */

import type { HttpTransport, TransportRequest, TransportResponse } from "./ports.ts";

export function createFetchTransport(): HttpTransport {
  return {
    async send(request: TransportRequest): Promise<TransportResponse> {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, request.timeoutMs);
      // An unref'd timer never holds the process open on its own.
      timer.unref?.();

      try {
        const response = await fetch(request.url, {
          method: request.method,
          headers: request.headers,
          redirect: "follow",
          signal: controller.signal,
        });

        const headers: Record<string, string> = {};
        response.headers.forEach((value, name) => {
          headers[name.toLowerCase()] = value;
        });

        const { body, truncated } = await readBounded(response, request.maxBytes);
        return { status: response.status, headers, body, truncated };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

async function readBounded(
  response: Response,
  maxBytes: number,
): Promise<{ body: string; truncated: boolean }> {
  if (response.body === null) return { body: "", truncated: false };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let read = 0;
  let truncated = false;

  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      if (read + chunk.byteLength > maxBytes) {
        chunks.push(chunk.subarray(0, maxBytes - read));
        read = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(chunk);
      read += chunk.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const joined = new Uint8Array(read);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { body: new TextDecoder("utf-8").decode(joined), truncated };
}
