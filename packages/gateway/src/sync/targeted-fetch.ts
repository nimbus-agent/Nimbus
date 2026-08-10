// packages/gateway/src/sync/targeted-fetch.ts

import { canonicalizeUrl } from "../util/url-canonical.ts";
import { type FetchableService, serviceForHost } from "./fetch-host-boundary.ts";
import type { FetchMissReason, FetchOneResult, Syncable, SyncContext } from "./types.ts";

/** How long a targeted fetch will poll for a rate-limit token before answering `rate_limited`. */
const ACQUIRE_TIMEOUT_MS = 5_000;
/**
 * Interval between `tryAcquire` polls. Small enough to feel responsive, large enough not to
 * hammer the per-provider mutex under contention. `ACQUIRE_TIMEOUT_MS / RATE_LIMIT_POLL_INTERVAL_MS`
 * attempts fit in the timeout budget.
 */
const RATE_LIMIT_POLL_INTERVAL_MS = 100;
const MAX_ACQUIRE_POLL_ATTEMPTS = Math.ceil(ACQUIRE_TIMEOUT_MS / RATE_LIMIT_POLL_INTERVAL_MS);

export type TargetedFetchOutcome =
  | { readonly status: "indexed"; readonly itemId: string }
  | { readonly status: "not_found"; readonly reason: FetchMissReason }
  | { readonly status: "unsupported_url" }
  | { readonly status: "no_targeted_fetch"; readonly service: string }
  | { readonly status: "not_configured"; readonly service?: string }
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
   * Pure, synchronous, NETWORK-FREE: does `service`'s `fetchOne` accept `url` — i.e. will it make
   * an outbound request for it, or decline with `unsupported_url` before touching the network?
   *
   * Exists so this module can decide whether to append an egress row WITHOUT first calling
   * `fetchOne` (I29 Critical 2). `fetchOne`'s own `unsupported_url` return is guaranteed
   * network-free by contract (`sync/types.ts`), but CONFIRMING that guarantee still requires
   * calling `fetchOne` — which the append-before-dispatch rule below forbids doing before the
   * append. This predicate answers the same question without paying that cost, by reusing each
   * connector's own URL-shape parser (never a reimplementation, so the two can never disagree).
   *
   * Each of the 5 fetch-on-miss connectors exports one: `githubFetchOneUrlIsSupported`,
   * `gitlabFetchOneUrlIsSupported`, `bitbucketFetchOneUrlIsSupported`,
   * `jenkinsFetchOneUrlIsSupported`, `jiraFetchOneUrlIsSupported`.
   */
  readonly urlIsSupported: (service: FetchableService, url: string) => boolean;
  /**
   * Appends ONE `sync` egress row. Called BEFORE the outbound call; throwing aborts the fetch —
   * fail-closed, no row means no fetch. Kept as an injected closure rather than importing
   * `appendEgressEntry` directly into this module, because the static D22 rule confines that
   * literal identifier to `egress/*`; the real implementation lives there (see
   * `egress/agent-brief-egress.ts` for the established shape) and is wired in by the caller that
   * constructs `TargetedFetchDeps`.
   *
   * Typed to return `undefined`, not `void` — TypeScript's `void`-return leniency would otherwise
   * accept an `async` function here silently. An async implementation's rejection would surface
   * as an unhandled promise rejection AFTER `targetedFetch` had already moved past this call
   * (since nothing here awaits it), which breaks the fail-closed contract: a failing append must
   * abort the fetch synchronously in this function's control flow, not fail invisibly later.
   */
  readonly appendEgress: (row: {
    readonly destination: FetchableService;
    readonly sourceType: "sync";
    readonly method: string;
  }) => undefined;
  /** Injected so the acquire poll loop below is testable without real time. */
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
 * `not_found`: the behaviour is still correct — a second attempt cannot succeed where the first
 * did not, since a query-stripped retry changes nothing about a missing credential, an
 * unauthorized/absent item, or an unreachable/erroring provider — but NOT because every
 * `not_found` attempt made a real request, which is no longer true. `reason: "no_credential"`
 * returns before any outbound call, exactly like `unsupported_url` does; the two arms differ in
 * what a caller should do next (a URL-shape retry can't help either one), not in whether a request
 * was made. At most one attempt ever reaches the network, because `unsupported_url` MUST be
 * returned before any outbound request (a contract stated on `Syncable.fetchOne` in
 * `sync/types.ts`, since this retry depends on it).
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
 * Polls `tryAcquire` (non-blocking) rather than racing the blocking `acquire` against a timeout.
 *
 * `acquire`'s retry loop runs entirely inside its per-provider mutex, holding it for the WHOLE
 * wait. Racing that call against a timeout and walking away on timeout (the earlier design) left
 * the losing `acquire()` running and queued: N abandoned callers left N full-wait-duration mutex
 * holds queued back-to-back, so a legitimate acquirer (the scheduler) arriving after them waited
 * behind ALL N — measured with a drained `github` bucket: 106ms baseline `acquire`, 1366ms after
 * 12 abandoned targeted-fetch attempts. `tryAcquire`'s mutex hold is a single synchronous
 * check-and-maybe-decrement, released immediately regardless of outcome, so any number of
 * concurrent pollers here can never serialize a legitimate `acquire` behind them — see
 * `sync/rate-limiter.ts`'s `tryAcquire` doc comment for the full account.
 */
async function acquireWithinTimeout(
  rateLimiter: SyncContext["rateLimiter"],
  service: FetchableService,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_ACQUIRE_POLL_ATTEMPTS; attempt++) {
    if (await rateLimiter.tryAcquire(service)) {
      return true;
    }
    await sleep(RATE_LIMIT_POLL_INTERVAL_MS);
  }
  return false;
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
 *   2. Resolve the host against the derived fetch-host boundary. A miss is a bare `not_configured`
 *      — there is no service to name yet at this point.
 *   3. Look up the registered connector for that service, and its `fetchOne`. A miss here is ALSO
 *      `not_configured`, but — unlike step 2's — names the `service`, since the boundary already
 *      resolved one.
 *   4. Acquire a rate-limit token from the SAME bucket the scheduler uses, polling the
 *      non-blocking `tryAcquire` (bounded by a timeout) rather than the blocking `acquire`. A
 *      timeout returns `rate_limited` and appends NOTHING — `fetchOne` deterministically never
 *      runs past this point, so there is nothing to record. NOTE `rate_limited` has a SECOND
 *      provenance: a connector's `fetchOne` returns it for a provider 429, and that one DOES
 *      carry an appended row, because the request genuinely left the machine. Both are correct
 *      for I29 — the ledger records ONLY real egress in both cases — so do not read this arm as
 *      "no egress row".
 *   5. Append ONE `sync` egress row. A throw here aborts — no row, no fetch. Deliberately AFTER
 *      the acquire (not before it): appending before a rate-limit timeout would have recorded
 *      `authorized` egress for a call that never left the machine — still fail-closed either way,
 *      since this still runs before any outbound request.
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
  // Caller-controlled userinfo (`user:pass@host`) plays no role in host or scheme resolution
  // (`.host`/`.origin` never include it) and every connector today discards the authority when
  // it parses `fetchOne`'s `url` argument — but it must not be given the chance to ride along
  // regardless. Cleared before `parsed` is ever serialized back into a string.
  parsed.username = "";
  parsed.password = "";

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
    // The boundary already resolved a service here, so naming it is a fact, not a
    // guess. The host-miss return above stays bare: there is genuinely nothing to
    // name, and guessing is what the boundary exists to refuse.
    return { status: "not_configured", service };
  }
  const fetchOne = syncable.fetchOne;
  if (fetchOne === undefined) {
    return { status: "no_targeted_fetch", service };
  }

  const ctx = deps.contextFor(service);
  // The SAME bucket the scheduler uses, so a targeted fetch can neither starve nor bypass it —
  // polled non-blockingly (see `acquireWithinTimeout`'s doc comment for why this is `tryAcquire`
  // and not a raced, abandonable `acquire()`).
  //
  // Deliberately BEFORE the egress append, not after: a rate-limit timeout below means `fetchOne`
  // is NEVER called (see the `rate_limited` return), so an append made before this point would
  // record `authorized` egress for a call that deterministically never left the machine — the
  // exact over-claim the `sync` class must not make (see `egress/sync-egress.ts`'s
  // `LOCAL_ONLY_SYNC_SERVICES` for the same principle applied to a different cause). Placing the
  // append AFTER the acquire keeps it no less fail-closed: it still runs before `fetchOneWithRetry`
  // ever reaches the network, so a throw here still aborts before any outbound request.
  const acquired = await acquireWithinTimeout(ctx.rateLimiter, service, deps.sleep);
  if (!acquired) {
    return { status: "rate_limited" };
  }

  // Mirrors `resolveItemByUrl`'s first two rungs (`index/resolve-by-url.ts`) for the three cases
  // they close: a fragment, one extra (non-tracking) query param, and a non-root trailing slash.
  // `canonicalizeUrl` is REUSED, never reimplemented here — `externalIdFor` hashes its output, so
  // a divergent rule in this module would not just miss fetches, it would change identity
  // elsewhere.
  //
  // NOT mirrored: resolve's third rung, which trims up to three trailing path segments. `resolve`
  // reports `fetchable: true` from the host alone, so a URL like `.../pull/1/files`,
  // `.../commits`, a GitLab `.../-/merge_requests/7/diffs`, or a Jenkins `.../12/console` gets
  // `fetchable: true` from resolve and then `unsupported_url` here. That is a known asymmetry, not
  // a loop — a decline is terminal and free (it never reaches the network) — it just means those
  // URL shapes cannot be targeted-fetched today.
  const canonical = canonicalizeUrl(parsed.toString());

  // I29 Critical 2: know in advance — via `deps.urlIsSupported`, never by calling `fetchOne` — that
  // BOTH the shape `fetchOneWithRetry` will try first (rung 1) AND its query-stripped retry
  // (rung 2) will decline before appending anything. A URL shape `fetchOne` would reject (e.g. a
  // PR's "Files changed" tab) must never ledger an `authorized` row for a call that provably never
  // left the machine. This check must precede the append (not follow calling `fetchOne`) — the
  // append-failure test below pins that `fetchOne` is never reached when the append throws, which
  // is only true if the append happens before `fetchOne` is ever invoked.
  const willAttempt =
    deps.urlIsSupported(service, canonical) ||
    (() => {
      const stripped = queryStrippedCanonical(canonical);
      return stripped !== canonical && deps.urlIsSupported(service, stripped);
    })();
  if (!willAttempt) {
    return { status: "unsupported_url" };
  }

  // BEFORE the outbound call. A throw here propagates and no fetch happens — fail-closed, no row
  // means no fetch.
  deps.appendEgress({ destination: service, sourceType: "sync", method: "items.fetch" });

  return fetchOneWithRetry(fetchOne, ctx, canonical);
}
