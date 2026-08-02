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
 * implies "will complete". `REBODY_IMPROVABLE_SERVICES` below tracks
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
 * Services whose connector passes `body:` (the declared-full variant of
 * `IndexedItemBodyInput` in `item-store.ts`) for EVERY item it writes, today.
 * `bodyComplete` there is `declaredFull && raw.length <= cap ? 1 : 0` —
 * `declaredFull` is `row.body !== undefined` — so re-fetching via `rebody`
 * can flip `body_complete` to 1 ONLY for a service listed here.
 *
 * Everything absent from this set is treated as cannot-improve BY DESIGN.
 * This is the inverse of an earlier version of this constant
 * (`REBODY_CANNOT_IMPROVE_SERVICES`, an exception list of 3 names), which was
 * wrong by construction: as of 2026-08-02, 74 files under
 * `packages/gateway/src/connectors/` call `upsertIndexedItem`/
 * `upsertIndexedItemForSync`, and only the ~10 services listed below have
 * been migrated to pass `body:` — every other connector is therefore
 * permanently `body_complete = 0`, which an exception list of 3 grossly
 * undercounted. An inclusion list is correct by construction instead: an
 * unknown or newly-added connector defaults to cannot-improve — an
 * over-cautious warning, never a false promise — until it is deliberately
 * added here in the same change that migrates its sync handler.
 *
 * Verify membership with:
 *
 *   grep -rln "body:" packages/gateway/src/connectors/ --include=*.ts | grep -v "\.test\."
 *
 * then read each hit — do NOT trust the grep alone, for three reasons found
 * while building this list:
 *
 *   1. Most connectors build their upsert row via a shared
 *      `<name>-mapping.ts` file. The generic `MappedRow<S, T>` type in
 *      `mapped-row.ts` hardcodes `bodyPreview: string` — every connector
 *      using it (51 of the 68 `*-mapping.ts` files, as of 2026-08-02) is
 *      structurally bodyPreview-only no matter what unrelated `body:` matches
 *      turn up elsewhere in the same file (an HTTP request `body:
 *      JSON.stringify(...)`, a `body: unknown` function parameter, etc.). A
 *      handful of connectors (`snyk-issue-mapping.ts`,
 *      `zoom-transcript-mapping.ts`) define their OWN row type with
 *      `body: string` in place of `bodyPreview: string` — those are the real
 *      migrated ones. Check the row TYPE the mapper returns, not grep noise.
 *   2. Object-shorthand (`{ bodyPreview }`, no colon — e.g.
 *      `dagster-job-mapping.ts`) does not match a plain `"bodyPreview:"` or
 *      `"body:"` grep. Check the row's field LIST, not just colon-suffixed
 *      keys.
 *   3. A service can have MULTIPLE item types with DIFFERENT completeness.
 *      `zoom` migrated `zoom:transcript` (`zoom-transcript-mapping.ts`,
 *      `body:`) but NOT `zoom:meeting` (`zoom-meeting-mapping.ts`,
 *      `bodyPreview:`). The locally-generated `service: "nimbus"` bucket has
 *      migrated `web_clip` (`clips/clip-ingest.ts`) and `research_brief`
 *      (`briefs/brief-save.ts`) but NOT `glossary_term`
 *      (`glossary/glossary-project.ts`, `bodyPreview:`). `rebody`'s pending
 *      map is grouped by SERVICE only (see `computePendingByService`), not by
 *      `(service, type)`, so a mixed service cannot be safely marked
 *      improvable at that granularity — `zoom` and `nimbus` are deliberately
 *      EXCLUDED here (the safe direction) until/unless the pending grouping
 *      is made type-aware.
 *
 * Membership verified 2026-08-02 — every item-writing code path for each of
 * these services passes `body:`:
 *
 *   bitbucket  bitbucket-sync.ts:138        body: plainTextPreviewFromHtml(...)
 *   discord    discord-sync.ts:203          body: full
 *   github     github-sync.ts:207,247       body: body ?? "" (pr AND issue — both checked)
 *   jira       jira-sync.ts:268             body: d.bodyPrev
 *   linear     linear-sync.ts:175           body: desc ?? ""
 *   obsidian   obsidian-sync.ts:75          body: note.body
 *   slack      slack-sync.ts:282            body: full
 *   snyk       snyk-issue-mapping.ts:117    body: description
 *   teams      _lib/teams/api.ts:89         body: full
 *
 * Add an entry only when you migrate a connector's LAST remaining
 * bodyPreview-only item type to pass `body:` — not when only some of its
 * item types are migrated (see `zoom` / `nimbus` above for why a partial
 * migration must NOT be added).
 */
export const REBODY_IMPROVABLE_SERVICES: ReadonlySet<string> = new Set([
  "bitbucket",
  "discord",
  "github",
  "jira",
  "linear",
  "obsidian",
  "slack",
  "snyk",
  "teams",
]);

/** Services in `pending` that are NOT in `REBODY_IMPROVABLE_SERVICES`, sorted. */
export function cannotImproveAmong(pending: Record<string, number>): string[] {
  return Object.keys(pending)
    .filter((service) => !REBODY_IMPROVABLE_SERVICES.has(service))
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
