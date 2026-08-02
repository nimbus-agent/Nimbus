import type { Database } from "bun:sqlite";
import type { Logger } from "pino";
import type { SyncScheduler } from "../sync/scheduler.ts";
import { clearSchedulerCursor } from "../sync/scheduler-store.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";
import { LongRunningJobRegistry } from "./_lib/long-running.ts";

/**
 * `rebody` re-fetches item bodies for rows the V48 migration (or a connector
 * that has not yet declared completeness) left with `body_complete = 0` —
 * legacy text that is genuinely GONE from the local index and can only be
 * recovered from the source API.
 *
 * It works by clearing a per-connector sync watermark (`scheduler_state.cursor`)
 * and letting the existing sync run from scratch. Cost is NOT uniform across
 * connectors, and callers should know which kind they have:
 *
 *   - Delta-capable / bounded-window (Slack, Gmail via history ids; Jira via
 *     a cold-start `updated >= -Nd` JQL floor — see `jiraJqlFromCursor` in
 *     `connectors/jira-sync.ts`, where `decodeCursor(null)` yields
 *     `hasFloor = false`): even from a fully cleared watermark, the re-sync
 *     walks a bounded recent window, not the whole account.
 *   - Full-scan (Notion, Confluence): clearing the watermark re-walks EVERY
 *     page in the account. Both reset `watermarkMs` to `-1` on a null cursor
 *     (`connectors/notion-sync.ts`, `connectors/confluence-sync.ts`) and their
 *     stop condition (`watermarkMs >= 0 && ...`) never fires at `-1`, so the
 *     walk never early-exits. On a large workspace that is tens of thousands
 *     of requests to recover bodies for a subset of items.
 *
 * Cost is a separate axis from completeness — do not assume "bounded window"
 * implies "will complete". `REBODY_CANNOT_IMPROVE_SERVICES` below tracks
 * completeness: Gmail is bounded-window (cheap) but its connector still never
 * declares a full `body:`, so re-syncing it costs little AND recovers
 * nothing. Notion/Confluence are full-scan (expensive) AND cannot complete —
 * the worst combination, which is exactly why the dry-run result surfaces
 * `cannotImprove` before the caller pays for the walk.
 *
 * There is deliberately no `--only-truncated` mode today, and it is not an
 * oversight — it is not implementable given how syncs work. A sync fetches by
 * page and time window; it cannot be asked for "the 340 items I have marked
 * incomplete" because no connector exposes a targeted single-item fetch. So
 * the flag would suppress writes for already-complete items (free) while
 * every API request still happened — a rate-limit "optimisation" that saves
 * zero requests. If a per-item fetch is ever added to the connector contract
 * — the same capability the browser client's resolve-miss path needs, see
 * docs/roadmap.md "Client surfaces" — then `rebody` SHOULD be reworked to
 * target `body_complete = 0` ids directly and skip the full-account scan
 * entirely. That is the condition that would make the flag meaningful; until
 * then it is theatre and must not be re-added.
 */

export class IndexRebodyRpcError extends Error {
  readonly rpcCode: number;
  constructor(rpcCode: number, message: string) {
    super(message);
    this.name = "IndexRebodyRpcError";
    this.rpcCode = rpcCode;
  }
}

export type IndexRebodyRpcContext = {
  db: Database;
  logger: Logger;
  notify: (method: string, params: unknown) => void;
  /**
   * Triggers an immediate sync for a connector once its watermark has been
   * cleared. Optional: when no live `SyncScheduler` is wired, the watermark
   * clear is still durable on disk and the connector's next scheduled tick
   * picks it up.
   */
  syncScheduler?: Pick<SyncScheduler, "forceSync">;
};

export type RebodyParams = {
  service?: string;
  type?: string;
  limit?: number;
  dryRun?: boolean;
};

/**
 * Services whose connector sync handler calls `upsertIndexedItemForSync` /
 * `upsertIndexedItem` with only `bodyPreview:` and never `body:`, for every
 * item, today. `item-store.ts`'s `bodyComplete` is `declaredFull && raw.length
 * <= cap ? 1 : 0` — `declaredFull` is `row.body !== undefined`, so a connector
 * that never passes `body:` can NEVER produce a `body_complete = 1` row. For
 * these services `rebody` clearing the watermark and re-syncing changes
 * nothing: `pendingAfter` will equal `pendingBefore` no matter how many times
 * you pay for the walk. That is a structural fact about the connector, not a
 * sync failure — it is surfaced to the caller as `cannotImprove` rather than
 * silently absorbed into a `succeeded` count.
 *
 * Verify membership with:
 *
 *   grep -n "bodyPreview\|body:" packages/gateway/src/connectors/<service>-sync.ts
 *
 * (Gmail's is at `connectors/_lib/gmail/api.ts`, not `gmail-sync.ts` itself.)
 * A connector belongs here iff that grep shows `bodyPreview:` call sites and
 * NO `body:` call site anywhere in the file. Verified 2026-08-02:
 *
 *   - notion-sync.ts:201       `bodyPreview: ""` — no `body:` anywhere.
 *   - confluence-sync.ts:141   `bodyPreview: ""` — no `body:` anywhere.
 *   - _lib/gmail/api.ts:174    `bodyPreview: preview` (the ~200-char API
 *     snippet) — no `body:` anywhere in the file.
 *
 * Checked and NOT in this set: `slack-sync.ts:282` passes `body: full`;
 * `jira-sync.ts:268` passes `body: d.bodyPrev`. Both genuinely recover on
 * `rebody`.
 *
 * Remove an entry the instant that connector's sync handler starts passing
 * `body:` for its items — otherwise this list itself silently becomes the
 * same kind of unacknowledged lie `rebody` exists to avoid. This is a
 * hand-maintained list by necessity (there is no runtime signal for "this
 * connector could pass `body:` but doesn't"); re-verify it whenever a
 * connector's sync handler changes.
 */
export const REBODY_CANNOT_IMPROVE_SERVICES: ReadonlySet<string> = new Set([
  "notion",
  "confluence",
  "gmail",
]);

/** Services in `pending` that are also in `REBODY_CANNOT_IMPROVE_SERVICES`, sorted. */
export function cannotImproveAmong(pending: Record<string, number>): string[] {
  return Object.keys(pending)
    .filter((service) => REBODY_CANNOT_IMPROVE_SERVICES.has(service))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * `clearSchedulerCursor` runs before `forceSync` is attempted (deliberately —
 * see `runRebody`), so a `forceSync` rejection still leaves the watermark
 * cleared. That connector's next SCHEDULED sync then performs the same
 * full/bounded re-walk automatically, unprompted. This message makes that
 * consequence visible in the `index.rebodyDone` payload instead of leaving it
 * as a server-side-only `logger.warn`.
 */
export function clearedWatermarkWarning(service: string): string {
  return `${service}: forceSync failed, but its watermark was already cleared — the next scheduled sync will perform the same re-walk automatically, unprompted.`;
}

const rebodyRegistry = new LongRunningJobRegistry();

export function parseRebodyParams(params: unknown): RebodyParams {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new IndexRebodyRpcError(-32602, "params must be an object");
  }
  const rec = params as Record<string, unknown>;
  const out: RebodyParams = {};
  if ("service" in rec) {
    const service = rec["service"];
    if (typeof service !== "string" || service === "") {
      throw new IndexRebodyRpcError(
        -32602,
        "params.service must be a non-empty string when provided",
      );
    }
    out.service = service;
  }
  if ("type" in rec) {
    const type = rec["type"];
    if (typeof type !== "string" || type === "") {
      throw new IndexRebodyRpcError(-32602, "params.type must be a non-empty string when provided");
    }
    out.type = type;
  }
  if ("limit" in rec) {
    const rawLimit = rec["limit"];
    // Unlike index.reembed's `limit` (bounds a local CPU recompute — safe to
    // silently drop if malformed), this `limit` bounds how many connectors
    // get an unbounded full-account network re-walk. A silently-ignored typo
    // here (`limit: "3"`) would target every pending service instead of
    // three, so a malformed value is a hard error, not a fallback.
    if (typeof rawLimit !== "number" || !Number.isFinite(rawLimit) || rawLimit <= 0) {
      throw new IndexRebodyRpcError(
        -32602,
        "params.limit must be a positive finite number when provided",
      );
    }
    out.limit = Math.floor(rawLimit);
  }
  if ("dryRun" in rec) {
    const rawDryRun = rec["dryRun"];
    // Same reasoning as `limit`: a mistyped `dryRun` silently becoming a real
    // run is the worst version of this failure mode, so it is rejected
    // rather than coerced.
    if (typeof rawDryRun !== "boolean") {
      throw new IndexRebodyRpcError(-32602, "params.dryRun must be a boolean when provided");
    }
    if (rawDryRun) {
      out.dryRun = true;
    }
  }
  return out;
}

/**
 * The dry-run report AND the "remaining" figure reported after a real run:
 * always the whole-index grouping, never scoped to the request's own
 * `service`/`type` filters — those filters pick which connector(s) get
 * re-synced, not which rows get counted in the summary.
 */
export function computePendingByService(db: Database): Record<string, number> {
  const rows = db
    .query(`SELECT service, COUNT(*) AS pending FROM item WHERE body_complete = 0 GROUP BY service`)
    .all() as Array<{ service: string; pending: number }>;
  const out: Record<string, number> = {};
  for (const row of rows) {
    out[row.service] = row.pending;
  }
  return out;
}

export function buildTargetServicesSql(p: RebodyParams): {
  sql: string;
  params: string[];
} {
  const params: string[] = [];
  let sql = `SELECT DISTINCT service FROM item WHERE body_complete = 0`;
  if (p.type !== undefined) {
    sql += ` AND type = ?`;
    params.push(p.type);
  }
  sql += ` ORDER BY service`;
  return { sql, params };
}

export function resolveTargetServices(p: RebodyParams, db: Database): string[] {
  if (p.service !== undefined) {
    return [p.service];
  }
  const { sql, params } = buildTargetServicesSql(p);
  const rows = db.query(sql).all(...params) as Array<{ service: string }>;
  const all = rows.map((r) => r.service);
  return p.limit === undefined ? all : all.slice(0, p.limit);
}

async function runRebody(
  p: RebodyParams,
  ctx: IndexRebodyRpcContext,
  progress: (payload: Record<string, unknown>) => void,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  if (p.dryRun === true) {
    const pending = computePendingByService(ctx.db);
    return { dryRun: true, pending, cannotImprove: cannotImproveAmong(pending) };
  }

  const pendingBefore = computePendingByService(ctx.db);
  const targets = resolveTargetServices(p, ctx.db);
  let succeeded = 0;
  let failed = 0;
  const failedServices: string[] = [];
  for (const service of targets) {
    if (signal.aborted) {
      break;
    }
    // Clearing the watermark before attempting the sync is deliberate: a
    // `forceSync` rejection below (rate limit, auth) must not leave the
    // connector permanently stuck on its old cursor. The tradeoff — a failed
    // attempt still arms the next scheduled tick for the same re-walk — is
    // made visible via `clearedWatermarkWarning` rather than hidden.
    clearSchedulerCursor(ctx.db, service);
    if (ctx.syncScheduler === undefined) {
      succeeded += 1;
    } else {
      try {
        await ctx.syncScheduler.forceSync(service);
        succeeded += 1;
      } catch (err) {
        ctx.logger.warn(
          {
            service,
            errMessage: err instanceof Error ? err.message : String(err),
          },
          "rebody: forceSync failed for service; watermark stays cleared for the next scheduled tick",
        );
        failed += 1;
        failedServices.push(service);
      }
    }
    progress({ done: succeeded + failed, total: targets.length, service });
  }

  const pendingAfter = computePendingByService(ctx.db);
  return {
    dryRun: false,
    targeted: targets,
    succeeded,
    failed,
    failedServices,
    warnings: failedServices.map((s) => clearedWatermarkWarning(s)),
    cannotImprove: cannotImproveAmong(pendingBefore),
    pendingBefore,
    pendingAfter,
  };
}

function handleRebody(params: unknown, ctx: IndexRebodyRpcContext): { jobId: string } {
  const p = parseRebodyParams(params);
  return rebodyRegistry.start({
    jobIdPrefix: "rebody",
    progressMethod: "index.rebodyProgress",
    doneMethod: "index.rebodyDone",
    errorMethod: "index.rebodyError",
    emit: (m, payload) => ctx.notify(m, payload),
    run: (progress, signal) => runRebody(p, ctx, progress, signal),
  });
}

function handleRebodyCancel(params: unknown): { cancelled: boolean } {
  const rec =
    params !== null && typeof params === "object" ? (params as Record<string, unknown>) : {};
  const jobId = rec["jobId"];
  if (typeof jobId !== "string") {
    throw new IndexRebodyRpcError(-32602, "params.jobId is required");
  }
  return { cancelled: rebodyRegistry.cancel(jobId) };
}

export async function dispatchIndexRebodyRpc(
  method: string,
  params: unknown,
  ctx: IndexRebodyRpcContext,
): Promise<RpcMissOrHit> {
  return dispatchByMethod<IndexRebodyRpcContext>(method, params, ctx, {
    "index.rebody": handleRebody,
    "index.rebodyCancel": (p) => handleRebodyCancel(p),
  });
}
