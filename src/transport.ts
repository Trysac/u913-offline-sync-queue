import type { Transport, TransportRequest, TransportResponse } from "./types.js";

/**
 * Creates a default `Transport` backed by `fetch`.
 *
 * @param fetchImpl - Custom `fetch` implementation (defaults to `globalThis.fetch`).
 */
export function createFetchTransport(fetchImpl: typeof fetch = globalThis.fetch): Transport {
  return {
    async send(req: TransportRequest): Promise<TransportResponse> {
      const init: RequestInit = {
        method: req.method,
        headers: req.headers,
        signal: req.signal,
      };
      if (req.body !== undefined) {
        init.body = req.body;
      }
      const res = await fetchImpl(req.url, init);
      const headers: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      let body: unknown;
      const contentType = headers["content-type"] ?? "";
      const text = await res.text();
      if (text.length > 0) {
        if (contentType.includes("application/json")) {
          try {
            body = JSON.parse(text);
          } catch {
            body = text;
          }
        } else {
          body = text;
        }
      }
      return {
        status: res.status,
        headers,
        body,
      };
    },
  };
}
