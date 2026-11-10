// packages/gateway/src/connectors/same-origin-fetch.ts

/**
 * The ONE redirect rule for every gateway-side fetch that carries the GitHub PAT (sync, targeted
 * fetch, PR files, Actions runs, the credential probe).
 *
 * The global `fetch` follows redirects by default and keeps `Authorization` on a same-origin hop;
 * it also follows a `Location` to another host or to `http:` for a request whose header the
 * runtime did not strip. With a GitHub Enterprise Server base typed by the owner, a hostile or
 * compromised instance could answer a call with a 3xx pointing anywhere. So every such call uses
 * `redirect: "manual"`: a 3xx is followed only when its `Location` is the SAME origin as the
 * request (the base is https-only, so an http-to-https upgrade never arises), re-checked on every
 * hop, at most `MAX_SAME_ORIGIN_HOPS` hops. Anything else throws a fixed error that carries no URL.
 */

export const MAX_SAME_ORIGIN_HOPS = 3;

/** Statuses that name a `Location` to follow. 304 and 300 are NOT redirects to follow. */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

export class RedirectRefusedError extends Error {
  constructor() {
    super("redirected to another origin or too many redirects; refused");
    this.name = "RedirectRefusedError";
  }
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export async function fetchSameOriginOnly(
  url: string,
  init: RequestInit = {},
  fetchImpl: FetchFn = globalThis.fetch as FetchFn,
): Promise<Response> {
  const origin = new URL(url).origin;
  let current = url;
  for (let hop = 0; hop <= MAX_SAME_ORIGIN_HOPS; hop++) {
    const res = await fetchImpl(current, { ...init, redirect: "manual" }); // NOSONAR S9382: each hop depends on the previous response's Location
    if (!REDIRECT_STATUSES.has(res.status)) {
      return res;
    }
    const method = (init.method ?? "GET").toUpperCase();
    const location = res.headers.get("location");
    if (location === null || (method !== "GET" && method !== "HEAD")) {
      throw new RedirectRefusedError();
    }
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new RedirectRefusedError();
    }
    if (next.origin !== origin) {
      throw new RedirectRefusedError();
    }
    // Release the followed 3xx's connection before the next hop; a cancel error never masks the flow.
    try {
      await res.body?.cancel(); // NOSONAR S9382: each hop depends on the previous response, so its body is released before the next request
    } catch {
      // ignored: the redirect body is discarded either way
    }
    current = next.toString();
  }
  throw new RedirectRefusedError();
}
