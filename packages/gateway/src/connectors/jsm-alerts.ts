import type { SyncContext } from "../sync/types.ts";
import {
  type JsmAlertMappedRow,
  mapJsmAlertToItem,
  parseAlertGet,
  parseAlertList,
} from "./jsm-alert-mapping.ts";
import {
  JSM_OPS_ROOT,
  JSM_STEP_BUDGET_MS,
  JSM_UNAVAILABLE_BACKOFF_MS,
  type JsmCreds,
  type JsmCursorFields,
  jsmGet,
  type Remaining,
  resolveCloudId,
  SAFE_ID,
} from "./jsm-oncall.ts";
import { stringField } from "./unknown-record.ts";

/**
 * The JSM Operations ALERT pass (Phase 10 IC2), a second pass inside the `jira` sync run beside the
 * on-call shift pass. It indexes open alerts plus those closed in the last 7 days as `jira:alert` items.
 *
 * Every request goes through `jsmGet` (`jsm-oncall.ts`): one pinned host, `redirect: "manual"`, the Vault
 * credential and the rate limiter. This file has no `fetch(` and no `https://` literal of its own, and it
 * builds every URL itself, so a URL in a reply (`links.next`) is never followed. The same cloud-id gating
 * as the shift pass applies (`resolveCloudId`).
 *
 * Reply shapes and the `query=status:open` syntax are from the documented API and are NOT verified against
 * a live site: a 400 on the first filtered list falls back once to an unfiltered list, and a reply that is
 * not the expected shape is a failed page (partial), never a throw.
 */

export const JSM_ALERT_REFRESH_INTERVAL_MS = 5 * 60_000;
export const JSM_ALERT_WINDOW_MS = 7 * 86_400_000;
export const JSM_ALERT_PAGE_SIZE = 100;
export const JSM_ALERT_MAX_PAGES = 5;
export const JSM_ALERT_MAX_OPEN_IDS = 200;
export const JSM_ALERT_MAX_RECONCILE = 20;

/** The alert fields of the jira sync cursor. `alAt` is the last ATTEMPT, `alOpen` the ids seen open. */
export interface JsmAlertCursorFields {
  alAt?: number;
  alUntil?: number;
  alOpen?: string[];
}

export interface JsmAlertRun {
  /** The alert keys, plus `cid`/`cidSite` only when this pass resolved them itself. */
  fields: JsmAlertCursorFields & Pick<JsmCursorFields, "cid" | "cidSite">;
  upserted: number;
}

type Listing = {
  /** Records the listing returned (already filtered to what the pass keeps). */
  alerts: Record<string, unknown>[];
  /** False when a page failed, was malformed, lost an entry, or the page cap cut the read. */
  complete: boolean;
  /** The HTTP status of the first failed request, 0 for a transport failure or an expired budget. */
  failedStatus: number | null;
};

function updatedAtOf(alert: Record<string, unknown>): number | null {
  const raw = alert["updatedAt"];
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function statusOf(alert: Record<string, unknown>): string {
  return stringField(alert, "status")?.toLowerCase() ?? "";
}

function listUrl(root: string, offset: number, query: string | null): string {
  const base = `${root}/alerts?size=${String(JSM_ALERT_PAGE_SIZE)}&offset=${String(offset)}&sort=updatedAt&order=desc`;
  return query === null ? base : `${base}&query=${encodeURIComponent(query)}`;
}

/**
 * Reads up to `JSM_ALERT_MAX_PAGES` pages. `keep` decides which records are kept; `stopWhenOlder` (closed
 * pass and the unfiltered fallback) ends the read at the first page whose LAST alert is older than the
 * cutoff, since the list is sorted by `updatedAt` descending.
 */
async function readPages(
  ctx: SyncContext,
  creds: JsmCreds,
  root: string,
  query: string | null,
  remaining: Remaining,
  opts: { keep: (a: Record<string, unknown>) => boolean; cutoffMs: number | null },
): Promise<Listing> {
  const out: Listing = { alerts: [], complete: true, failedStatus: null };
  for (let page = 0; page < JSM_ALERT_MAX_PAGES; page += 1) {
    const res = await jsmGet(
      ctx,
      creds,
      listUrl(root, page * JSM_ALERT_PAGE_SIZE, query),
      remaining,
    );
    const parsed = res.ok ? parseAlertList(res.text) : null;
    if (parsed === null) {
      out.complete = false;
      out.failedStatus = res.ok ? 0 : res.status;
      return out;
    }
    if (parsed.skipped > 0) out.complete = false;
    for (const a of parsed.alerts) {
      if (opts.keep(a)) out.alerts.push(a);
    }
    const last = parsed.alerts.at(-1);
    const lastUpdated = last === undefined ? null : updatedAtOf(last);
    const olderThanCutoff =
      opts.cutoffMs !== null && lastUpdated !== null && lastUpdated < opts.cutoffMs;
    if (parsed.alerts.length + parsed.skipped < JSM_ALERT_PAGE_SIZE || olderThanCutoff) return out;
  }
  // The page cap was reached with a full last page: there may be more.
  out.complete = false;
  return out;
}

function inWindow(cutoffMs: number): (a: Record<string, unknown>) => boolean {
  return (a) => {
    const t = updatedAtOf(a);
    return t !== null && t >= cutoffMs;
  };
}

/** Writes the alerts, one `writeBatch` per page of `JSM_ALERT_PAGE_SIZE`. Returns the ids written. */
function writeAlerts(
  ctx: SyncContext,
  alerts: readonly Record<string, unknown>[],
  nowMs: number,
): { written: string[]; skipped: number } {
  const written: string[] = [];
  let skipped = 0;
  for (let i = 0; i < alerts.length; i += JSM_ALERT_PAGE_SIZE) {
    const chunk = alerts.slice(i, i + JSM_ALERT_PAGE_SIZE);
    const rows: JsmAlertMappedRow[] = [];
    for (const raw of chunk) {
      const row = mapJsmAlertToItem(raw, { syncedAt: nowMs });
      if (row === null) skipped += 1;
      else rows.push(row);
    }
    ctx.writeBatch(() => {
      for (const row of rows) {
        ctx.upsertItem(row);
        written.push(row.externalId);
      }
    });
  }
  return { written, skipped };
}

function idsOf(alerts: readonly Record<string, unknown>[], status: string): string[] {
  const ids: string[] = [];
  for (const a of alerts) {
    const id = stringField(a, "id");
    if (id !== undefined && statusOf(a) === status) ids.push(id);
  }
  return ids;
}

/**
 * Refreshes alerts that were open at the last complete pass and are no longer in the open listing (closed
 * while the gateway was offline), one `GET /alerts/{id}` each, at most `JSM_ALERT_MAX_RECONCILE`. Returns the
 * ids whose refresh failed (kept in the next `alOpen` so they are retried) and how many were refreshed.
 */
async function reconcileStale(
  ctx: SyncContext,
  creds: JsmCreds,
  root: string,
  stale: readonly string[],
  nowMs: number,
  remaining: Remaining,
): Promise<{ failed: string[]; refreshed: number }> {
  const failed: string[] = [];
  let refreshed = 0;
  for (const id of stale.filter((x) => SAFE_ID.test(x)).slice(0, JSM_ALERT_MAX_RECONCILE)) {
    const res = await jsmGet(ctx, creds, `${root}/alerts/${encodeURIComponent(id)}`, remaining);
    const rec = res.ok ? parseAlertGet(res.text) : null;
    if (rec === null) {
      failed.push(id);
      continue;
    }
    refreshed += writeAlerts(ctx, [rec], nowMs).written.length;
  }
  return { failed, refreshed };
}

type Passes = { alerts: Record<string, unknown>[]; openComplete: boolean; openIds: string[] };

/**
 * The open listing plus the closed-in-window listing, or the one unfiltered fallback when the filtered
 * query is rejected with 400. `null` when the very first request failed in a way that ends the pass:
 * the caller reads `failedStatus` from `first`.
 */
async function readAlerts(
  ctx: SyncContext,
  creds: JsmCreds,
  root: string,
  nowMs: number,
  remaining: Remaining,
): Promise<{ passes: Passes | null; firstFailure: number | null }> {
  const cutoff = nowMs - JSM_ALERT_WINDOW_MS;
  const open = await readPages(ctx, creds, root, "status:open", remaining, {
    keep: () => true,
    cutoffMs: null,
  });
  if (open.failedStatus === 400 && open.alerts.length === 0) {
    // UNVERIFIED query syntax: one unfiltered list, keeping every open alert and the closed ones in the window.
    ctx.logger.info(
      { serviceId: "jira" },
      "jsm alerts: the filtered alert query was rejected; falling back to an unfiltered list",
    );
    const all = await readPages(ctx, creds, root, null, remaining, {
      keep: (a) => statusOf(a) === "open" || inWindow(cutoff)(a),
      cutoffMs: cutoff,
    });
    return {
      passes: {
        alerts: all.alerts,
        openComplete: all.complete,
        openIds: idsOf(all.alerts, "open"),
      },
      firstFailure: all.failedStatus === null || all.alerts.length > 0 ? null : all.failedStatus,
    };
  }
  if (open.failedStatus !== null && open.alerts.length === 0) {
    return { passes: null, firstFailure: open.failedStatus };
  }
  const closed = await readPages(ctx, creds, root, "status:closed", remaining, {
    keep: inWindow(cutoff),
    cutoffMs: cutoff,
  });
  return {
    passes: {
      alerts: [...open.alerts, ...closed.alerts],
      openComplete: open.complete,
      openIds: idsOf(open.alerts, "open"),
    },
    firstFailure: null,
  };
}

function nextOpenIds(
  prev: readonly string[],
  now: readonly string[],
  complete: boolean,
  failedReconcile: readonly string[],
): string[] {
  const merged = complete ? [...now, ...failedReconcile] : [...now, ...failedReconcile, ...prev];
  return [...new Set(merged)].slice(0, JSM_ALERT_MAX_OPEN_IDS);
}

/**
 * One refresh. `clock` is injectable so a test can end the 60 s budget. Never throws on a request failure;
 * the caller wraps the rest. `fields.alAt` is `nowMs` (an ATTEMPT, so a failing provider is retried once per
 * interval); a 401, 403 or 404 on the first list also sets `alUntil` six hours out.
 */
export async function runJsmAlerts(
  ctx: SyncContext,
  creds: JsmCreds,
  prev: JsmCursorFields & JsmAlertCursorFields,
  nowMs: number,
  clock: () => number = Date.now,
): Promise<JsmAlertRun> {
  const fields: JsmAlertRun["fields"] = { alAt: nowMs };
  if (prev.alUntil !== undefined) fields.alUntil = prev.alUntil;
  if (prev.alOpen !== undefined) fields.alOpen = prev.alOpen;
  const id = await resolveCloudId(ctx, creds, prev);
  if ("stop" in id) return { fields, upserted: 0 };
  if (id.cid !== prev.cid || id.cidSite !== prev.cidSite) {
    fields.cid = id.cid;
    fields.cidSite = id.cidSite;
  }
  const started = clock();
  const remaining: Remaining = () => JSM_STEP_BUDGET_MS - (clock() - started);
  const root = `${JSM_OPS_ROOT}/${id.cid}/v1`;

  const { passes, firstFailure } = await readAlerts(ctx, creds, root, nowMs, remaining);
  if (passes === null) {
    if (firstFailure === 401 || firstFailure === 403 || firstFailure === 404) {
      fields.alUntil = nowMs + JSM_UNAVAILABLE_BACKOFF_MS;
      ctx.logger.info(
        { serviceId: "jira", status: firstFailure },
        "jsm alerts: Operations alerts are not available to this account; retry in 6 h",
      );
    }
    return { fields, upserted: 0 };
  }
  delete fields.alUntil;

  const { written, skipped } = writeAlerts(ctx, passes.alerts, nowMs);
  let stale: string[] = [];
  if (passes.openComplete) {
    const now = new Set(passes.openIds);
    stale = (prev.alOpen ?? []).filter((x) => !now.has(x));
  }
  const rec = await reconcileStale(ctx, creds, root, stale, nowMs, remaining);
  fields.alOpen = nextOpenIds(prev.alOpen ?? [], passes.openIds, passes.openComplete, rec.failed);
  ctx.logger.info(
    {
      serviceId: "jira",
      alerts: written.length,
      skipped,
      reconciled: rec.refreshed,
      alerts_partial: !passes.openComplete,
    },
    "jsm alerts refresh",
  );
  return { fields, upserted: written.length + rec.refreshed };
}
