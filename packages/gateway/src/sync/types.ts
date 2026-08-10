import type { Database } from "bun:sqlite";
import type { Logger } from "pino";

import type { NimbusVault } from "../vault/nimbus-vault.ts";
import type { ProviderRateLimiter } from "./rate-limiter.ts";

export interface SyncContext {
  vault: NimbusVault;
  db: Database;
  logger: Logger;
  rateLimiter: ProviderRateLimiter;
  scheduleItemEmbedding?: (itemId: string) => void;
  // Wave 7b:
  sandboxCwd: string;
  /** Per-connector credential selection from [connectors.<name>]; defaults to personal. */
  credentialFor: (service: string) => { credential: "personal" | "team"; teamEntry?: string };
  /** Gate-routed localOperator team list drain (I19). Returns raw items or throws an actionable error. */
  runTeamList: (req: { entry: string; service: string; listToolId: string }) => Promise<unknown[]>;
  /**
   * Resolves an indexed item to its nimbus service id using the
   * [metrics.dora.<id>] / [ci.service.<id>] bindings. Optional: when absent
   * the graph populator falls back to `metadata.service`, so connectors and
   * tests that predate this compile and behave unchanged.
   *
   * F1: the return shape mirrors `metrics/service-identity.ts`'s
   * `ServiceIdentityResolution` / `graph/graph-populator.ts`'s
   * `ResolveServiceIdResult` — declared structurally here too rather than
   * imported, keeping this module dependency-light. `excluded` (a config
   * claimed the item but the I-1/F2 deploy-environment gate rejected it)
   * must bind nothing; only `unknown` (nothing claims the item) falls back
   * to `metadata.service`.
   */
  resolveServiceId?: (item: {
    readonly service: string;
    readonly type: string;
    readonly metadata: Record<string, unknown>;
  }) =>
    | { readonly kind: "bound"; readonly serviceId: string }
    | { readonly kind: "excluded" }
    | { readonly kind: "unknown" };
  /**
   * The connector's persisted index depth, resolved per sync run by the
   * scheduler. Enforced centrally in `upsertIndexedItemForSync` — connectors
   * do not read this and must not be trusted to honour it individually.
   */
  depth: "metadata_only" | "summary" | "full";
  /**
   * One-shot cold-start floor (epoch ms) for a history backfill, set by the
   * scheduler for a single run when the owner asked for one via
   * `nimbus index rebody --since <days>`.
   *
   * OPT-IN per connector: a connector that does not read it is unaffected, and
   * the two that do (jira, linear) say so in their own doc comments. Absent —
   * the normal case — every connector keeps its own `initialSyncDepthDays`.
   * It overrides only the COLD-START floor; an established cursor always wins,
   * since it is more recent by construction.
   */
  historyFloorMs?: number;
}

/**
 * Bounds the single outbound request each connector's `fetchOne` makes (github/gitlab/bitbucket/
 * jenkins/jira today). Without this, an incomplete or stalled upstream response keeps
 * `POST /v1/items/fetch` — which awaits `fetchOne` end to end — pending indefinitely.
 *
 * `sync/targeted-fetch.ts` already bounds its rate-limit acquire at `ACQUIRE_TIMEOUT_MS` (5s), so
 * this is the SECOND half of the route's total worst-case latency: `ACQUIRE_TIMEOUT_MS +
 * FETCH_ONE_TIMEOUT_MS` ≈ 15s — seconds, not minutes, and comfortably under typical reverse-proxy
 * and client patience (30–60s+). Passed as `signal: AbortSignal.timeout(FETCH_ONE_TIMEOUT_MS)` to
 * the connector's outbound `fetch` call; on abort the connector's existing catch already maps the
 * failure to `{ status: "not_found" }` (see `Syncable.fetchOne`'s doc below) — the caller may
 * retry, and the periodic sync picks the item up regardless, so a timeout is a genuine miss, never
 * a hang.
 *
 * MUST NOT be threaded into a helper the PERIODIC sync also calls without an opt-in — a scheduled
 * sync is paginated and legitimately runs far longer than one item fetch; a caller-facing timeout
 * on a shared helper would abort real syncs. Where a connector's `fetchOne` reaches the network
 * through a helper the periodic sync also uses (jenkins' `jenkinsGetJson`), the signal is an
 * OPTIONAL parameter only `fetchOne`'s own call site supplies.
 */
export const FETCH_ONE_TIMEOUT_MS = 10_000;

/**
 * Why a targeted single-item fetch missed.
 *
 * A fixed enum derived from an HTTP status code and nothing else — never
 * provider text, a URL, or an exception message, any of which can carry a
 * credential or a Vault-stored base URL.
 */
export type FetchMissReason =
  | "no_credential"
  | "unauthorized"
  | "absent"
  | "unreachable"
  | "upstream_error";

/**
 * The outcome of a TARGETED single-item fetch. Distinct arms because collapsing
 * them is how a panel ends up telling a user to check credentials that are fine:
 * a bare `not_found` covered a dead credential, an offline machine, and a
 * genuinely absent item alike.
 *
 * `reason` is what lets that promise be kept — but it does not keep it on its
 * own, and this comment must not claim otherwise while it can still be omitted.
 * It is optional ONLY until every connector supplies one; at that point it
 * becomes required, and a `not_found` site that omits a cause is a compile
 * error rather than a silent regression to the old behaviour.
 */
export type FetchOneResult =
  | { readonly status: "indexed"; readonly itemId: string }
  | { readonly status: "not_found"; readonly reason?: FetchMissReason }
  | { readonly status: "rate_limited" }
  | { readonly status: "unsupported_url" };

export interface Syncable {
  readonly serviceId: string;
  readonly defaultIntervalMs: number;
  readonly initialSyncDepthDays: number;
  sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult>;
  /**
   * Fetch and index ONE item by its web URL.
   *
   * OPTIONAL, and the optionality does real work: 62 connectors do not move, and a service that
   * omits it makes `POST /v1/items/fetch` answer `no_targeted_fetch` rather than pretending. An
   * implementation MUST write through `upsertIndexedItemForSync` so index depth is enforced
   * centrally and `resolve_key` is populated by the same write. It must NOT call the rate
   * limiter, append to the egress ledger, or check the fetch-host boundary — those are the
   * orchestrator's job in a later layer; duplicating them here would make this method untestable
   * in isolation.
   *
   * `unsupported_url` MUST be returned before any outbound request — the caller's URL regex
   * failed to match, so there is nothing yet to fetch. The targeted-fetch orchestrator
   * (`sync/targeted-fetch.ts`) retries once, query-stripped, whenever it sees this status, and
   * that retry is safe to make ONLY because this status is known to mean "no request was made
   * yet"; returning it after a real outbound call would make the orchestrator double it.
   */
  fetchOne?(ctx: SyncContext, url: string): Promise<FetchOneResult>;
}

export interface SyncResult {
  cursor: string | null;
  itemsUpserted: number;
  itemsDeleted: number;
  hasMore: boolean;
  durationMs: number;
  bytesTransferred?: number;
}

export function retryAfterDateFromHeader(value: string | null, fallbackSeconds: number): Date {
  const fb = Number.isFinite(fallbackSeconds) && fallbackSeconds > 0 ? fallbackSeconds : 60;
  if (value === null) {
    return new Date(Date.now() + fb * 1000);
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return new Date(Date.now() + fb * 1000);
  }
  if (/^\d+$/.test(trimmed)) {
    const sec = Number.parseInt(trimmed, 10);
    if (Number.isFinite(sec) && sec >= 0) {
      return new Date(Date.now() + sec * 1000);
    }
  }
  const parsed = Date.parse(trimmed);
  if (Number.isFinite(parsed)) {
    return new Date(parsed);
  }
  return new Date(Date.now() + fb * 1000);
}

export class RateLimitError extends Error {
  readonly retryAfter: Date;
  constructor(retryAfter: Date, message = "Rate limited") {
    super(message);
    this.name = "RateLimitError";
    this.retryAfter = retryAfter;
  }
}

export class UnauthenticatedError extends Error {
  constructor(message = "Connector authentication expired or revoked") {
    super(message);
    this.name = "UnauthenticatedError";
  }
}

export function syncNoopResult(cursor: string | null, t0: number): SyncResult {
  return {
    cursor,
    itemsUpserted: 0,
    itemsDeleted: 0,
    hasMore: false,
    durationMs: Math.round(performance.now() - t0),
  };
}

export interface SyncSchedulerConfig {
  maxConcurrentSyncs: number;
  catchUpOnRestart: boolean;
  retentionDays: number;
}

export interface SyncStatus {
  serviceId: string;
  status: "ok" | "syncing" | "paused" | "backoff" | "error";
  lastSyncAt: number | null;
  nextSyncAt: number | null;
  intervalMs: number;
  itemCount: number;
  lastError: string | null;
  consecutiveFailures: number;
  healthState?: string;
  healthRetryAfterMs?: number | null;
  depth: "metadata_only" | "summary" | "full";
  enabled: boolean;
}
