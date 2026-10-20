import {
  RateLimitError,
  type Syncable,
  type SyncContext,
  type SyncResult,
  syncNoopResult,
  UnauthenticatedError,
} from "../../sync/types.ts";
import type { ExtensionIdentity } from "./extension-identity.ts";
import { type ExtensionSyncRequest, parseSyncResponse } from "./sync-response.ts";

export interface ExtensionSyncableDeps {
  readonly identity: ExtensionIdentity;
  /** `manifest.sync.intervalSeconds * 1000`. */
  readonly intervalMs: number;
  readonly itemTypes: readonly string[];
  /** One `__nimbus_sync` call; resolves the parsed JSON body or rejects (timeout, oversize, ...). */
  readonly callSync: (req: ExtensionSyncRequest) => Promise<unknown>;
  readonly isConfigured: () => Promise<boolean>;
  /** `SandboxRunner.canConfine` over the extension's spawn policy: non-null = why it cannot. */
  readonly canConfine: () => string | null;
  readonly budget: { readonly maxPages: number; readonly maxMs: number };
  /**
   * `false` once the registration this syncable belongs to was withdrawn (remove, revoke, disable,
   * a stale grant). Checked before every page call and again right before a page is written, with
   * no `await` in between, so a run that outlives its registration neither calls (re-spawning the
   * extension) nor writes (after a purge).
   */
  readonly isLive: () => boolean;
}

/** A run stopped because its registration was withdrawn mid-run; nothing more was called or written. */
export class ExtensionSyncCancelledError extends Error {
  constructor(serviceId: string) {
    super(`${serviceId}: extension sync cancelled (no longer registered)`);
    this.name = "ExtensionSyncCancelledError";
  }
}

export const EXTENSION_SYNC_BUDGET = {
  maxPages: 40,
  maxMs: 300_000,
  callTimeoutMs: 60_000,
} as const;

/** Readwise's `initialSyncDepthDays` today; the cold-start floor of an extension's first run. */
const INITIAL_SYNC_DEPTH_DAYS = 30;
const DEFAULT_RETRY_AFTER_MS = 60_000;

/**
 * Adapts an approved extension's sync-v1 `__nimbus_sync` tool to a scheduler `Syncable`.
 *
 * ONE `sync()` call is ONE scheduler run (so one `sync.run` egress row): it loops pages inside the
 * run, writes each page in a single `writeBatch` (a page is atomic; earlier pages stay committed if
 * a later page fails), and always returns `hasMore: false` — the scheduler never continues it. A
 * timeout or throw propagates and the scheduler persists no cursor.
 */
export function createExtensionSyncable(deps: ExtensionSyncableDeps): Syncable {
  const serviceId = deps.identity.indexServiceId;
  return {
    serviceId,
    defaultIntervalMs: deps.intervalMs,
    initialSyncDepthDays: INITIAL_SYNC_DEPTH_DAYS,
    preflight(): string | null {
      const reason = deps.canConfine();
      if (reason === null) return null;
      return `sandbox cannot confine this extension: ${reason} — fix it (see \`nimbus doctor\`), then run \`nimbus connector resume ${serviceId}\``;
    },
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      if (!(await deps.isConfigured())) return syncNoopResult(cursor, t0);
      return runPages(deps, ctx, cursor, t0);
    },
  };
}

async function runPages(
  deps: ExtensionSyncableDeps,
  ctx: SyncContext,
  startCursor: string | null,
  t0: number,
): Promise<SyncResult> {
  const historyFloorMs =
    ctx.historyFloorMs !== undefined && Number.isFinite(ctx.historyFloorMs)
      ? ctx.historyFloorMs
      : Date.now() - INITIAL_SYNC_DEPTH_DAYS * 86_400_000;
  const dropped = { undeclaredType: 0, malformed: 0, oversized: 0 };
  let cursor = startCursor;
  let upserted = 0;
  for (let pages = 1; ; pages += 1) {
    if (!deps.isLive()) throw new ExtensionSyncCancelledError(deps.identity.indexServiceId);
    const raw = await deps.callSync({ cursor, depth: ctx.depth, historyFloorMs });
    // No await between this check and the writeBatch below.
    if (!deps.isLive()) throw new ExtensionSyncCancelledError(deps.identity.indexServiceId);
    const page = parseSyncResponse(raw, {
      indexServiceId: deps.identity.indexServiceId,
      itemTypes: deps.itemTypes,
      syncedAt: Date.now(),
    });
    if (page.status === "rate_limited") {
      throw new RateLimitError(
        new Date(Date.now() + (page.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS)),
      );
    }
    if (page.status === "unauthenticated") throw new UnauthenticatedError();
    ctx.writeBatch(() => {
      for (const row of page.rows) ctx.upsertItem(row);
    });
    upserted += page.rows.length;
    dropped.undeclaredType += page.dropped.undeclaredType;
    dropped.malformed += page.dropped.malformed;
    dropped.oversized += page.dropped.oversized;
    cursor = page.cursor ?? cursor;
    const outOfBudget =
      pages >= deps.budget.maxPages || performance.now() - t0 >= deps.budget.maxMs;
    if (!page.hasMore || outOfBudget) break;
  }
  if (dropped.undeclaredType + dropped.malformed + dropped.oversized > 0) {
    ctx.logger.warn(
      { serviceId: deps.identity.indexServiceId, dropped },
      "extension sync dropped items",
    );
  }
  return {
    cursor,
    itemsUpserted: upserted,
    itemsDeleted: 0,
    hasMore: false,
    durationMs: Math.round(performance.now() - t0),
    dropped,
  };
}
