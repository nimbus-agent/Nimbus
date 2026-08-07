// packages/gateway/src/sync/targeted-fetch.ts

import { canonicalizeUrl } from "../util/url-canonical.ts";
import { type FetchableService, serviceForHost } from "./fetch-host-boundary.ts";
import type { FetchOneResult, Syncable, SyncContext } from "./types.ts";

/** How long a targeted fetch will wait for a rate-limit token before answering `rate_limited`. */
const ACQUIRE_TIMEOUT_MS = 5_000;

export type TargetedFetchOutcome =
  | { readonly status: "indexed"; readonly itemId: string }
  | { readonly status: "not_found" }
  | { readonly status: "unsupported_url" }
  | { readonly status: "no_targeted_fetch"; readonly service: string }
  | { readonly status: "not_configured" }
  | { readonly status: "rate_limited" };

export interface TargetedFetchDeps {
  /**
   * The derived host boundary (`deriveFetchHostMap`, `fetch-host-boundary.ts`) — the ONLY source
   * of "is this host fetchable, and for which service". A miss is `not_configured`, never a
   * guess: every connector's URL regex matches ANY host and then fetches a CONSTRUCTED provider
   * API URL under the user's stored credential, so this lookup MUST run before that connector is
   * ever reached.
   */
  readonly hostMap: ReadonlyMap<string, FetchableService>;
  /**
   * Looks up the registered connector for a service the host boundary already claimed.
   * `undefined` when the service is not wired up in this binary (distinct from the host simply
   * being unclaimed, which never reaches this lookup at all).
   */
  readonly syncableFor: (service: FetchableService) => Syncable | undefined;
  /** Builds the `SyncContext` a connector's `fetchOne` needs (vault, db, rate limiter, ...). */
  readonly contextFor: (service: FetchableService) => SyncContext;
  /**
   * The literal `scheme://host[:port]` (a `URL.origin`-shaped string, no trailing slash) of a
   * service's OWN configured origin — but ONLY when that origin is itself `http:`. Returns `null`
   * for a SaaS-only service or one configured over `https:`, since neither has an `http:`
   * exception to grant.
   *
   * The host boundary keys on host alone and structurally cannot distinguish `http://` from
   * `https://` for the same host, so THIS is the one place a caller-supplied `http:` URL can ever
   * be accepted — and only when it matches this value exactly. The scheme is never caller-chosen:
   * accepting any `http:` URL a caller supplies would send the connector's stored credential in
   * cleartext to whatever host that URL names.
   */
  readonly httpOriginFor: (service: FetchableService) => string | null;
  /**
   * Appends ONE `sync` egress row. Called BEFORE the outbound call; throwing aborts the fetch —
   * fail-closed, no row means no fetch. Kept as an injected closure rather than importing
   * `appendEgressEntry` directly into this module, because the static D22 rule confines that
   * literal identifier to `egress/*`; the real implementation lives there (see
   * `egress/agent-brief-egress.ts` for the established shape) and is wired in by the caller that
   * constructs `TargetedFetchDeps`.
   */
  readonly appendEgress: (row: {
    readonly destination: string;
    readonly sourceType: "sync";
    readonly method: string;
  }) => void;
  /** Injected so the acquire timeout below is testable without real time. */
  readonly sleep: (ms: number) => Promise<void>;
}

/**
 * The query-stripped canonical key — rung 2, mirroring `resolveItemByUrl`'s `withoutQuery`
 * (`index/resolve-by-url.ts`) exactly: strip every query param, then re-canonicalize (dropping the
 * fragment/tracking params/trailing slash again, in case removing the query changes anything).
 */
function queryStrippedCanonical(canonicalUrl: string): string {
  const u = new URL(canonicalUrl);
  u.search = "";
  return canonicalizeUrl(u.toString());
}

/**
 * Calls `fetchOne` with the canonicalized URL (rung 1). If and only if that answers
 * `unsupported_url` — meaning the connector's `$`-anchored regex rejected it before making any
 * outbound call — retries once with ALL query params stripped (rung 2). Never retries on
 * `not_found`: that attempt already made a real request, so trying again would double it. At most
 * one attempt ever reaches the network, because `unsupported_url` is returned before the
 * connector calls `fetch`.
 */
async function fetchOneWithRetry(
  fetchOne: NonNullable<Syncable["fetchOne"]>,
  ctx: SyncContext,
  canonicalUrl: string,
): Promise<FetchOneResult> {
  const first = await fetchOne(ctx, canonicalUrl);
  if (first.status !== "unsupported_url") {
    return first;
  }
  const stripped = queryStrippedCanonical(canonicalUrl);
  if (stripped === canonicalUrl) {
    // Nothing left to strip: the regex rejected the URL for some other reason (a malformed path,
    // an unsupported shape, ...), and a second, identical call cannot succeed where the first did
    // not.
    return first;
  }
  return fetchOne(ctx, stripped);
}

/**
 * Fetch and index one item named by a URL, server-side. The single chokepoint every targeted
 * fetch passes through.
 *
 * This is what makes it SAFE that every connector's `fetchOne` parses the caller's URL with a
 * regex that matches any host and then fetches a CONSTRUCTED provider API URL under the user's
 * stored credential: the gateway re-derives `{service}` from the URL's HOST against the derived
 * boundary before a connector is ever reached, and it never dereferences the supplied URL or
 * trusts a caller's classification of it.
 *
 * Order of operations, all fail-closed:
 *   1. Parse the URL and pin its scheme: `https:` always proceeds; `http:` proceeds only when it
 *      is exactly a service's own configured (self-hosted) origin, never caller-chosen.
 *   2. Resolve the host against the derived fetch-host boundary. A miss is `not_configured`.
 *   3. Look up the registered connector for that service, and its `fetchOne`.
 *   4. Append ONE `sync` egress row. A throw here aborts — no row, no fetch.
 *   5. Acquire a rate-limit token from the SAME bucket the scheduler uses (bounded by a timeout,
 *      since `acquire` waits rather than throwing).
 *   6. Call `fetchOne`, canonicalizing the URL first and retrying once query-stripped.
 */
export async function targetedFetch(
  deps: TargetedFetchDeps,
  url: string,
): Promise<TargetedFetchOutcome> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { status: "unsupported_url" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { status: "unsupported_url" };
  }

  // The host boundary runs BEFORE anything else touches a connector — every connector's URL
  // regex matches ANY host, so an unclaimed host must never reach `syncableFor`/`fetchOne`.
  const service = serviceForHost(deps.hostMap, parsed.host);
  if (service === null) {
    // Absent credentials a service is not in the map at all, so "unknown host" and "service not
    // configured" are the same fact and get the same honest answer (mirrors
    // fetch-host-boundary.ts's own framing).
    return { status: "not_configured" };
  }

  if (parsed.protocol === "http:") {
    const allowedOrigin = deps.httpOriginFor(service);
    // `https:` needs no exception. A caller-chosen `http:` would send the stored credential in
    // cleartext, so it is accepted ONLY when it is exactly this service's own self-hosted origin
    // — matched on the full origin (scheme+host+port), not merely the host the boundary already
    // matched.
    if (allowedOrigin === null || allowedOrigin !== parsed.origin) {
      return { status: "unsupported_url" };
    }
  }

  const syncable = deps.syncableFor(service);
  if (syncable === undefined) {
    return { status: "not_configured" };
  }
  const fetchOne = syncable.fetchOne;
  if (fetchOne === undefined) {
    return { status: "no_targeted_fetch", service };
  }

  // BEFORE the outbound call. A throw here propagates and no fetch happens — fail-closed, no row
  // means no fetch.
  deps.appendEgress({ destination: service, sourceType: "sync", method: "items.fetch" });

  const ctx = deps.contextFor(service);
  // The SAME bucket the scheduler uses, so a targeted fetch can neither starve nor bypass it.
  //
  // `ProviderRateLimiter.acquire` WAITS — it sleeps in a loop until tokens refill or a penalty
  // window passes, and never throws `RateLimitError` (it throws only for a bad token count or an
  // unknown provider; see `sync/rate-limiter.ts`). This route needs a bounded wait, so it races
  // the wait against an injected `sleep`. Racing is sound here because `acquire` is genuinely
  // async (an awaited mutex plus a real sleep) — unlike a sync FFI call, which no `Promise.race`
  // could ever bound.
  const acquired = await Promise.race([
    ctx.rateLimiter.acquire(service).then(() => true),
    deps.sleep(ACQUIRE_TIMEOUT_MS).then(() => false),
  ]);
  if (!acquired) {
    // The losing `acquire()` keeps running and will eventually take its token — over-consuming
    // the bucket by one for a request we abandoned here. Deliberately the SAFE direction: it can
    // only make us more conservative toward the provider, never let this path starve or bypass
    // the scheduler.
    return { status: "rate_limited" };
  }

  // Mirrors `resolveItemByUrl`'s first two rungs (`index/resolve-by-url.ts`) so fetch-on-miss never
  // declines a URL that resolve reports `fetchable: true` for. `canonicalizeUrl` is REUSED, never
  // reimplemented here — `externalIdFor` hashes its output, so a divergent rule in this module
  // would not just miss fetches, it would change identity elsewhere.
  const canonical = canonicalizeUrl(parsed.toString());
  return fetchOneWithRetry(fetchOne, ctx, canonical);
}
