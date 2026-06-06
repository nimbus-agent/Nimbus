import { requestUrl } from "./request-url.ts";

/**
 * Replace `globalThis.fetch` with a stub that intercepts a single host and
 * records each request; requests to any other origin fall through to the real
 * fetch. The common interception preamble (URL resolution, origin gate, request
 * recording, and fetch restore) lives here so connector fake-server tests only
 * supply their connector-specific `record` and `respond` callbacks.
 *
 * @param base    Origin to intercept, e.g. `"https://api.canva.com"`.
 * @param record  Builds the recorded-request entry from the parsed URL + init.
 * @param respond Builds the Response for an intercepted request.
 */
export function installHostInterceptFetch<Req>(opts: {
  base: string;
  record: (url: URL, init: RequestInit | undefined) => Req;
  respond: (req: Req, url: URL, init: RequestInit | undefined) => Response | Promise<Response>;
}): { requests: Req[]; fetch: typeof globalThis.fetch; restore: () => void } {
  const realFetch = globalThis.fetch;
  const requests: Req[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const urlStr = requestUrl(input);
    if (new URL(urlStr).origin !== opts.base) {
      return realFetch(input, init);
    }
    const url = new URL(urlStr);
    const req = opts.record(url, init);
    requests.push(req);
    return opts.respond(req, url, init);
  }) as typeof globalThis.fetch;
  globalThis.fetch = fakeFetch;
  return {
    requests,
    fetch: fakeFetch,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}
