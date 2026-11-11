import { itemPrimaryKey } from "../index/item-key.ts";
import type { SyncContext } from "../sync/types.ts";
import {
  CALENDAR_WINDOW,
  isOutsideWindow,
  windowEnd,
  windowStartFor,
} from "./_lib/calendar-event-normalize.ts";
import {
  fetchMicrosoftGraphJson,
  MicrosoftGraphHttpError,
  parseODataDeltaPage,
} from "./microsoft-graph-sync-shared.ts";
import { mapOutlookCalendarEvent } from "./outlook-calendar-mapping.ts";

/**
 * The calendar half of the `outlook` syncable (Phase 10 MB2b): `calendarView/delta` over the window
 * now-1d .. now+30d, kept inside the same service as `outlook:event` rows. It calls Graph with the
 * gateway's own token (no MCP tool), never throws (a calendar failure must not lose the mail result
 * of the same run), and is throttled to about once per 5-minute scheduled run.
 */

const SERVICE_ID = "outlook";
const GRAPH = "https://graph.microsoft.com/v1.0";
const LABEL = "Outlook calendar";
const PAGE_CAP = 20;
/** The mail stream drains one page per run with immediate continuations: this keeps calendar to ~1 request per scheduled run. */
const CHECK_INTERVAL_MS = 4 * 60 * 1000;
/** A connection granted before `Calendars.Read` was a default scope answers 401/403: stop asking for 6 hours. */
const RETRY_AFTER_DENIED_MS = 6 * 60 * 60 * 1000;
const PREFER = 'odata.maxpagesize=50, outlook.timezone="UTC"';

export type OutlookCalendarCursor = {
  /** A `nextLink` while `draining`, the `deltaLink` once settled, `null` before any anchor. */
  readonly nextUrl: string | null;
  readonly windowStart: number;
  /** True while `nextUrl` is a `nextLink` of an unfinished window drain. */
  readonly draining?: boolean;
  /** Epoch ms of the last delta request. */
  readonly checkedAt?: number;
  /** No calendar request before this (epoch ms): the connection is not allowed to read the calendar. */
  readonly retryAt?: number;
};

export type CalendarStepResult = {
  readonly half: OutlookCalendarCursor | undefined;
  readonly upserted: number;
  readonly deleted: number;
  readonly bytes: number;
  readonly hasMore: boolean;
  /** Events whose time could not be resolved to an instant (no epoch keys written). */
  readonly unresolved: number;
};

type Acc = { upserted: number; deleted: number; bytes: number; unresolved: number };

type Plan = {
  readonly kind: "fresh" | "resume" | "incremental";
  readonly windowStart: number;
  readonly nextUrl: string | null;
};

function idle(half: OutlookCalendarCursor | undefined, acc?: Acc): CalendarStepResult {
  return {
    half,
    upserted: acc?.upserted ?? 0,
    deleted: acc?.deleted ?? 0,
    bytes: acc?.bytes ?? 0,
    hasMore: false,
    unresolved: acc?.unresolved ?? 0,
  };
}

function shouldRun(half: OutlookCalendarCursor | undefined, now: number): boolean {
  if (half === undefined) return true;
  if (half.retryAt !== undefined && now < half.retryAt) return false;
  if (half.draining === true) return true;
  return half.checkedAt === undefined || now - half.checkedAt >= CHECK_INTERVAL_MS;
}

function anchorWindow(half: OutlookCalendarCursor | undefined, now: number): Plan {
  const settledAndOld =
    half?.draining !== true &&
    half !== undefined &&
    now - half.windowStart >= CALENDAR_WINDOW.REANCHOR_MS;
  if (half === undefined || half.nextUrl === null || settledAndOld) {
    return { kind: "fresh", windowStart: windowStartFor(now), nextUrl: null };
  }
  return {
    kind: half.draining === true ? "resume" : "incremental",
    windowStart: half.windowStart,
    nextUrl: half.nextUrl,
  };
}

function initialUrl(windowStart: number): string {
  const start = new Date(windowStart).toISOString();
  const end = new Date(windowEnd(windowStart)).toISOString();
  return `${GRAPH}/me/calendarView/delta?startDateTime=${encodeURIComponent(start)}&endDateTime=${encodeURIComponent(end)}`;
}

function removedId(raw: unknown): string | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const rec = raw as Record<string, unknown>;
  const removed = rec["@removed"];
  const id = rec["id"];
  const isRemoved = removed !== undefined && removed !== null;
  return isRemoved && typeof id === "string" && id !== "" ? id : undefined;
}

function deleteIfIndexed(ctx: SyncContext, acc: Acc, externalId: string): void {
  if (ctx.itemExists(itemPrimaryKey(SERVICE_ID, externalId))) {
    ctx.deleteItem(SERVICE_ID, externalId);
    acc.deleted += 1;
  }
}

/** Writes one page in ONE transaction; adds the ids it kept to `keep`. */
function applyPage(
  ctx: SyncContext,
  acc: Acc,
  values: readonly unknown[],
  windowStart: number,
  zone: string,
  now: number,
  keep: Set<string>,
): void {
  ctx.writeBatch(() => {
    for (const raw of values) {
      const gone = removedId(raw);
      if (gone !== undefined) {
        deleteIfIndexed(ctx, acc, gone);
        continue;
      }
      const mapped = mapOutlookCalendarEvent(raw, { zone, syncedAt: now });
      if (mapped.kind === "skip") continue;
      if (mapped.kind === "delete") {
        deleteIfIndexed(ctx, acc, mapped.externalId);
        continue;
      }
      const start = mapped.row.metadata["start_ms"];
      const end = mapped.row.metadata["end_ms"];
      if (
        typeof start === "number" &&
        typeof end === "number" &&
        isOutsideWindow(start, end, windowStart)
      ) {
        deleteIfIndexed(ctx, acc, mapped.row.externalId);
        continue;
      }
      if (mapped.unresolved) acc.unresolved += 1;
      ctx.upsertItem(mapped.row);
      keep.add(mapped.row.externalId);
      acc.upserted += 1;
    }
  });
}

/** The sweep rule: a fresh complete drain sweeps with its keep set; a resumed one prunes only the aged-out; a delta pass sweeps nothing. */
function finishWindow(ctx: SyncContext, acc: Acc, plan: Plan, keep: ReadonlySet<string>): void {
  if (plan.kind === "fresh") {
    acc.deleted += ctx.replaceItemSet("event", [...keep]);
  } else if (plan.kind === "resume") {
    acc.deleted += ctx.replaceItemSet("event", [...keep], { endBeforeMs: plan.windowStart });
  }
}

async function drainWindow(
  ctx: SyncContext,
  token: string,
  acc: Acc,
  plan: Plan,
  now: number,
  zone: string,
): Promise<CalendarStepResult> {
  const keep = new Set<string>();
  let nextUrl = plan.nextUrl;
  for (let pages = 0; ; pages += 1) {
    if (pages >= PAGE_CAP) {
      const half: OutlookCalendarCursor = {
        nextUrl,
        windowStart: plan.windowStart,
        draining: true,
        checkedAt: now,
      };
      return { ...idle(half, acc), hasMore: true };
    }
    const { json, bytes } = await fetchMicrosoftGraphJson(
      // NOSONAR S9382: each page request carries the previous page's link
      ctx,
      token,
      nextUrl,
      initialUrl(plan.windowStart),
      LABEL,
      { Prefer: PREFER },
    );
    acc.bytes += bytes;
    const page = parseODataDeltaPage(json);
    applyPage(ctx, acc, page.value ?? [], plan.windowStart, zone, now, keep);
    const next = page["@odata.nextLink"];
    if (next !== undefined && next !== "") {
      nextUrl = next;
      continue;
    }
    finishWindow(ctx, acc, plan, keep);
    const delta = page["@odata.deltaLink"];
    const half: OutlookCalendarCursor = {
      nextUrl: delta !== undefined && delta !== "" ? delta : null,
      windowStart: plan.windowStart,
      checkedAt: now,
    };
    return idle(half, acc);
  }
}

/** A 410 (delta token expired) drops the half and re-anchors ONCE in the same run. */
async function runWindow(
  ctx: SyncContext,
  token: string,
  acc: Acc,
  half: OutlookCalendarCursor | undefined,
  now: number,
  zone: string,
  restarted: boolean,
): Promise<CalendarStepResult> {
  try {
    return await drainWindow(ctx, token, acc, anchorWindow(half, now), now, zone);
  } catch (err) {
    if (err instanceof MicrosoftGraphHttpError && err.status === 410 && !restarted) {
      return await runWindow(ctx, token, acc, undefined, now, zone, true);
    }
    throw err;
  }
}

/** Nothing the calendar throws may escape: a denied connection backs off 6 h, anything else is retried next run. */
function settleError(
  ctx: SyncContext,
  acc: Acc,
  half: OutlookCalendarCursor | undefined,
  now: number,
  err: unknown,
): CalendarStepResult {
  const denied =
    err instanceof MicrosoftGraphHttpError && (err.status === 401 || err.status === 403);
  if (denied) {
    const backedOff: OutlookCalendarCursor = {
      nextUrl: half?.nextUrl ?? null,
      windowStart: half?.windowStart ?? windowStartFor(now),
      ...(half?.draining === true ? { draining: true } : {}),
      checkedAt: now,
      retryAt: now + RETRY_AFTER_DENIED_MS,
    };
    ctx.logger.warn(
      { serviceId: SERVICE_ID },
      "Outlook calendar is not readable with this connection (re-authorise for Calendars.Read); retrying in 6 hours",
    );
    return idle(backedOff, acc);
  }
  ctx.logger.warn(
    { serviceId: SERVICE_ID },
    "Outlook calendar sync failed; the mail sync is unaffected and the calendar is retried next run",
  );
  return idle(half, acc);
}

export async function runOutlookCalendarStep(
  ctx: SyncContext,
  token: string,
  half: OutlookCalendarCursor | undefined,
  now: number,
  zone: string,
): Promise<CalendarStepResult> {
  if (!shouldRun(half, now)) return idle(half);
  const acc: Acc = { upserted: 0, deleted: 0, bytes: 0, unresolved: 0 };
  try {
    return await runWindow(ctx, token, acc, half, now, zone, false);
  } catch (err) {
    return settleError(ctx, acc, half, now, err);
  }
}
