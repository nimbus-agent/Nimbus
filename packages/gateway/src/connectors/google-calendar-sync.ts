import { itemPrimaryKey } from "../index/item-key.ts";
import type { Syncable, SyncContext, SyncResult } from "../sync/types.ts";
import {
  CALENDAR_WINDOW,
  isOutsideWindow,
  windowEnd,
  windowStartFor,
} from "./_lib/calendar-event-normalize.ts";
import { gatewayZone } from "./_lib/zoned-time.ts";
import {
  googleCalendarExternalId,
  isCancelledGoogleEvent,
  mapGoogleCalendarEvent,
} from "./google-calendar-event-mapping.ts";
import { fetchGoogleJson, GoogleHttpError } from "./google-sync-shared.ts";
import { decodeNimbusJsonCursorObject, encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

/**
 * Google Calendar sync (Phase 10 MB2b). Calls the Calendar REST API directly (NOT through the
 * `gcal_*` MCP tools: `gcal_event_list` forces `orderBy=startTime` and has no `syncToken`), with the
 * token the gateway resolves through `ctx.accessToken()`. Per selected calendar: a full fetch of the
 * window now-1d .. now+30d, then incremental `syncToken` passes, re-anchored every 7 days.
 */

const SERVICE_ID = "google_calendar";
const CURSOR_PREFIX = "nimbus-gcal1:";
const BASE = "https://www.googleapis.com/calendar/v3";
const MAX_CALENDARS = 20;
const EVENTS_PAGE_SIZE = 250;
const PAGES_PER_CALENDAR = 10;
const PAGES_PER_RUN = 12;
const EVENT_FIELDS =
  "nextPageToken,nextSyncToken,items(id,iCalUID,status,summary,description,location,start,end,organizer(email),attendees(self,responseStatus),updated,htmlLink,recurringEventId)";
const CALENDAR_FIELDS =
  "nextPageToken,items(id,summary,primary,selected,timeZone,accessRole,hidden,deleted)";

export type CalendarCursorEntry = {
  readonly windowStart: number;
  readonly syncToken?: string;
  readonly pageToken?: string;
};
export type GoogleCalendarCursorV1 = {
  readonly v: 1;
  readonly calendars: Readonly<Record<string, CalendarCursorEntry>>;
};

export function encodeGoogleCalendarCursor(c: GoogleCalendarCursorV1): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, c);
}

function decodeEntry(v: unknown): CalendarCursorEntry | undefined {
  const rec = asRecord(v);
  const windowStart = rec === undefined ? undefined : numberField(rec, "windowStart");
  if (rec === undefined || windowStart === undefined) return undefined;
  const syncToken = stringField(rec, "syncToken");
  const pageToken = stringField(rec, "pageToken");
  return {
    windowStart,
    ...(syncToken === undefined || syncToken === "" ? {} : { syncToken }),
    ...(pageToken === undefined || pageToken === "" ? {} : { pageToken }),
  };
}

/** `undefined` for no cursor, another prefix, junk, or a version other than 1: a full first sync. */
export function decodeGoogleCalendarCursor(raw: string | null): GoogleCalendarCursorV1 | undefined {
  const r = decodeNimbusJsonCursorObject(raw, CURSOR_PREFIX);
  if (r?.["v"] !== 1) return undefined;
  const map = asRecord(r["calendars"]);
  if (map === undefined) return undefined;
  const calendars: Record<string, CalendarCursorEntry> = {};
  for (const [id, v] of Object.entries(map).slice(0, MAX_CALENDARS)) {
    const entry = decodeEntry(v);
    if (entry !== undefined) calendars[id] = entry;
  }
  return { v: 1, calendars };
}

type CalendarRef = { readonly id: string; readonly name: string };

type Run = {
  readonly ctx: SyncContext;
  readonly token: string;
  readonly now: number;
  readonly zone: string;
  upserted: number;
  deleted: number;
  bytes: number;
  pagesLeft: number;
  hasMore: boolean;
};

type Mode = {
  readonly incremental: boolean;
  readonly windowStart: number;
  /** A (re)anchor that began in this run: its complete drain may sweep with the keep set. */
  readonly fresh: boolean;
  readonly syncToken?: string;
  readonly pageToken?: string;
};

function isSelectable(c: Record<string, unknown>): boolean {
  const id = stringField(c, "id");
  return (
    id !== undefined &&
    id !== "" &&
    !id.includes("|") &&
    c["hidden"] !== true &&
    c["deleted"] !== true &&
    c["selected"] !== false
  );
}

/** One page of 250 is read (a 20-calendar cap makes more pointless); the primary calendar leads. */
async function listSelectedCalendars(run: Run): Promise<CalendarRef[]> {
  const url = new URL(`${BASE}/users/me/calendarList`);
  url.searchParams.set("maxResults", "250");
  url.searchParams.set("minAccessRole", "reader");
  url.searchParams.set("fields", CALENDAR_FIELDS);
  const { json, bytes } = await fetchGoogleJson(
    run.ctx,
    run.token,
    url.toString(),
    "Google Calendar",
    {
      method: "GET",
    },
  );
  run.bytes += bytes;
  const body = asRecord(json) ?? {};
  if (typeof body["nextPageToken"] === "string" && body["nextPageToken"] !== "") {
    run.ctx.logger.warn(
      { serviceId: SERVICE_ID },
      "Google Calendar list has more than one page; only the first 250 calendars are considered",
    );
  }
  const items = Array.isArray(body["items"]) ? (body["items"] as unknown[]) : [];
  const usable: Record<string, unknown>[] = [];
  for (const i of items) {
    const c = asRecord(i);
    if (c !== undefined && isSelectable(c)) usable.push(c);
  }
  const primary = usable.filter((c) => c["primary"] === true);
  const rest = usable.filter((c) => c["primary"] !== true);
  const ordered = [...primary, ...rest].map((c) => ({
    id: stringField(c, "id") ?? "",
    name: stringField(c, "summary") ?? "",
  }));
  if (ordered.length > MAX_CALENDARS) {
    run.ctx.logger.warn(
      { serviceId: SERVICE_ID, selected: ordered.length, cap: MAX_CALENDARS },
      "more Google calendars are selected than the sync cap; the rest are not indexed",
    );
  }
  return ordered.slice(0, MAX_CALENDARS);
}

function chooseMode(entry: CalendarCursorEntry | undefined, now: number): Mode {
  if (entry?.pageToken !== undefined) {
    return {
      incremental: entry.syncToken !== undefined,
      windowStart: entry.windowStart,
      fresh: false,
      pageToken: entry.pageToken,
      ...(entry.syncToken === undefined ? {} : { syncToken: entry.syncToken }),
    };
  }
  if (entry?.syncToken !== undefined && now - entry.windowStart < CALENDAR_WINDOW.REANCHOR_MS) {
    return {
      incremental: true,
      windowStart: entry.windowStart,
      fresh: false,
      syncToken: entry.syncToken,
    };
  }
  return { incremental: false, windowStart: windowStartFor(now), fresh: true };
}

function eventsUrl(calendarId: string, mode: Mode): string {
  const url = new URL(`${BASE}/calendars/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("maxResults", String(EVENTS_PAGE_SIZE));
  url.searchParams.set("fields", EVENT_FIELDS);
  if (mode.incremental && mode.syncToken !== undefined) {
    // Google refuses timeMin, timeMax and orderBy beside a syncToken.
    url.searchParams.set("syncToken", mode.syncToken);
  } else {
    url.searchParams.set("timeMin", new Date(mode.windowStart).toISOString());
    url.searchParams.set("timeMax", new Date(windowEnd(mode.windowStart)).toISOString());
  }
  if (mode.pageToken !== undefined) url.searchParams.set("pageToken", mode.pageToken);
  return url.toString();
}

/** Writes one page inside ONE transaction; adds the external ids it kept to `keep` (for a sweep). */
function applyPage(
  run: Run,
  cal: CalendarRef,
  items: readonly unknown[],
  windowStart: number,
  keep: Set<string>,
): void {
  const { ctx } = run;
  ctx.writeBatch(() => {
    for (const raw of items) {
      const id = stringField(asRecord(raw) ?? {}, "id")?.trim() ?? "";
      if (id === "") continue;
      const externalId = googleCalendarExternalId(cal.id, id);
      const row = isCancelledGoogleEvent(raw)
        ? null
        : mapGoogleCalendarEvent(raw, {
            calendarId: cal.id,
            calendarName: cal.name,
            zone: run.zone,
            syncedAt: run.now,
          });
      // lane-census: scope=event service=google_calendar
      const start = row?.metadata["start_ms"];
      // lane-census: scope=event service=google_calendar
      const end = row?.metadata["end_ms"];
      const outside =
        typeof start === "number" &&
        typeof end === "number" &&
        isOutsideWindow(start, end, windowStart);
      if (row === null || outside) {
        if (ctx.itemExists(itemPrimaryKey(SERVICE_ID, externalId))) {
          ctx.deleteItem(SERVICE_ID, externalId);
          run.deleted += 1;
        }
        continue;
      }
      ctx.upsertItem(row);
      keep.add(externalId);
      run.upserted += 1;
    }
  });
}

/** The sweep rule: a fresh complete drain sweeps with its keep set; a resumed one prunes only the aged-out. */
function finishWindow(run: Run, cal: CalendarRef, mode: Mode, keep: ReadonlySet<string>): void {
  const externalIdPrefix = `${cal.id}|`;
  run.deleted += mode.fresh
    ? run.ctx.replaceItemSet("event", [...keep], { externalIdPrefix })
    : run.ctx.replaceItemSet("event", [...keep], {
        externalIdPrefix,
        endBeforeMs: mode.windowStart,
      });
}

async function fetchEventsPage(
  run: Run,
  cal: CalendarRef,
  mode: Mode,
): Promise<{ items: unknown[]; nextPageToken?: string; nextSyncToken?: string }> {
  const { json, bytes } = await fetchGoogleJson(
    run.ctx,
    run.token,
    eventsUrl(cal.id, mode),
    "Google Calendar",
    { method: "GET" },
  );
  run.bytes += bytes;
  const body = asRecord(json) ?? {};
  const next = stringField(body, "nextPageToken");
  const sync = stringField(body, "nextSyncToken");
  return {
    items: Array.isArray(body["items"]) ? (body["items"] as unknown[]) : [],
    ...(next === undefined || next === "" ? {} : { nextPageToken: next }),
    ...(sync === undefined || sync === "" ? {} : { nextSyncToken: sync }),
  };
}

/** Drains pages of one calendar under the per-calendar and per-run budgets; returns its next cursor entry. */
async function drainWindow(
  run: Run,
  cal: CalendarRef,
  start: Mode,
): Promise<CalendarCursorEntry | undefined> {
  const keep = new Set<string>();
  let mode = start;
  let pages = 0;
  for (;;) {
    if (pages >= PAGES_PER_CALENDAR || run.pagesLeft <= 0) {
      run.hasMore = true;
      return {
        windowStart: mode.windowStart,
        ...(mode.syncToken === undefined ? {} : { syncToken: mode.syncToken }),
        ...(mode.pageToken === undefined ? {} : { pageToken: mode.pageToken }),
      };
    }
    pages += 1;
    run.pagesLeft -= 1;
    const page = await fetchEventsPage(run, cal, mode); // NOSONAR S9382: pages are sequential by construction (each carries the previous page token)
    applyPage(run, cal, page.items, mode.windowStart, keep);
    if (page.nextPageToken !== undefined) {
      mode = { ...mode, pageToken: page.nextPageToken };
      continue;
    }
    if (!mode.incremental) finishWindow(run, cal, mode, keep);
    return page.nextSyncToken === undefined
      ? undefined
      : { windowStart: mode.windowStart, syncToken: page.nextSyncToken };
  }
}

function skipWarn(run: Run, cal: CalendarRef, status: number): void {
  run.ctx.logger.warn(
    { serviceId: SERVICE_ID, calendarId: cal.id, status },
    "Google Calendar events request was refused; this calendar is skipped this run",
  );
}

/** One calendar: a 410 restarts it ONCE in full; a 403/404 skips it (its entry is kept). */
async function syncOneCalendar(
  run: Run,
  cal: CalendarRef,
  entry: CalendarCursorEntry | undefined,
  restarted: boolean,
): Promise<CalendarCursorEntry | undefined> {
  try {
    return await drainWindow(run, cal, chooseMode(entry, run.now));
  } catch (err) {
    if (!(err instanceof GoogleHttpError)) throw err;
    if (err.status === 410 && !restarted) {
      return await syncOneCalendar(run, cal, undefined, true);
    }
    if (err.status === 403 || err.status === 404) {
      skipWarn(run, cal, err.status);
      return entry;
    }
    throw err;
  }
}

/** A calendar that left the selection loses its rows (after a SUCCESSFUL list only). */
function removeDepartedCalendars(
  run: Run,
  entries: Readonly<Record<string, CalendarCursorEntry>>,
  kept: readonly CalendarRef[],
): void {
  const keptIds = new Set(kept.map((c) => c.id));
  for (const id of Object.keys(entries)) {
    if (keptIds.has(id)) continue;
    run.deleted += run.ctx.replaceItemSet("event", [], { externalIdPrefix: `${id}|` });
  }
}

export type GoogleCalendarSyncableOptions = {
  /** Test seams; production passes none. */
  readonly now?: () => number;
  readonly zone?: string;
};

export function createGoogleCalendarSyncable(
  options: GoogleCalendarSyncableOptions = {},
): Syncable {
  return {
    serviceId: SERVICE_ID,
    // A meeting moved this morning must be seen this morning.
    defaultIntervalMs: 5 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      const token = await ctx.accessToken();
      const entries = decodeGoogleCalendarCursor(cursor)?.calendars ?? {};
      const run: Run = {
        ctx,
        token,
        now: options.now?.() ?? Date.now(),
        zone: options.zone ?? gatewayZone(),
        upserted: 0,
        deleted: 0,
        bytes: 0,
        pagesLeft: PAGES_PER_RUN,
        hasMore: false,
      };
      const calendars = await listSelectedCalendars(run);
      removeDepartedCalendars(run, entries, calendars);
      const next: Record<string, CalendarCursorEntry> = {};
      for (const cal of calendars) {
        const prior = entries[cal.id];
        if (run.pagesLeft <= 0) {
          run.hasMore = true;
          if (prior !== undefined) next[cal.id] = prior;
          continue;
        }
        const entry = await syncOneCalendar(run, cal, prior, false); // NOSONAR S9382: calendars share one page budget and one rate limiter, so they run in order
        if (entry !== undefined) next[cal.id] = entry;
      }
      return {
        cursor: encodeGoogleCalendarCursor({ v: 1, calendars: next }),
        itemsUpserted: run.upserted,
        itemsDeleted: run.deleted,
        hasMore: run.hasMore,
        durationMs: Math.round(performance.now() - t0),
        bytesTransferred: run.bytes,
      };
    },
  };
}
