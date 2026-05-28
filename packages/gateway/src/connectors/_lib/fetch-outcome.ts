import type { Provider } from "../../sync/rate-limiter.ts";
import type { SyncContext } from "../../sync/types.ts";

export type FetchOutcome =
  | { kind: "ok"; parsed: unknown; bytes: number }
  | { kind: "http_error"; bytes: number; status: number }
  | { kind: "parse_error"; bytes: number };

type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

export async function connectorFetch(
  ctx: SyncContext,
  serviceId: Provider,
  url: string,
  init: RequestInit = {},
  fetchFn: FetchFn = globalThis.fetch as FetchFn,
): Promise<FetchOutcome> {
  await ctx.rateLimiter.acquire(serviceId);
  const res = await fetchFn(url, init);
  const text = await res.text();
  const bytes = text.length;
  if (!res.ok) {
    ctx.logger.warn({ serviceId, status: res.status, url }, "connector fetch failed");
    return { kind: "http_error", bytes, status: res.status };
  }
  try {
    return { kind: "ok", parsed: JSON.parse(text) as unknown, bytes };
  } catch {
    return { kind: "parse_error", bytes };
  }
}
