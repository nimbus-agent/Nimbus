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
}

export interface Syncable {
  readonly serviceId: string;
  readonly defaultIntervalMs: number;
  readonly initialSyncDepthDays: number;
  sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult>;
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
