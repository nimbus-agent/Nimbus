import {
  allDayInstants,
  normalizedEventKeys,
  normalizeSelfResponse,
} from "./_lib/calendar-event-normalize.ts";
import { capPreview } from "./_lib/imap-client.ts";
import { type WallTime, wallToInstantMs } from "./_lib/zoned-time.ts";
import { OUTLOOK_EVENT_META_VERSION } from "./calendar-event-meta.ts";
import type { MappedRow } from "./mapped-row.ts";
import { modifiedMsFromIso } from "./microsoft-graph-sync-shared.ts";
import { asRecord, stringField } from "./unknown-record.ts";

/**
 * A Microsoft Graph event (documented shape) to an `outlook:event` row (Phase 10 MB2b). The sync asks
 * Graph for UTC (`Prefer: outlook.timezone="UTC"`), but the mapper never assumes it: an offset-less
 * `dateTime` is placed ONLY by the `timeZone` beside it, `Date.parse` is never used on it (its meaning
 * would depend on the host's zone), and a zone that is neither `UTC` nor an IANA name (Graph's default
 * is a Windows name) gets no epoch keys: omission over guessing.
 */

const TITLE_MAX = 256;
const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/;

export type OutlookEventMapping =
  | {
      readonly kind: "row";
      readonly row: MappedRow<"outlook", "event">;
      /** True when the time could not be resolved: the row carries no `start_ms` / `end_ms`. */
      readonly unresolved: boolean;
    }
  | { readonly kind: "delete"; readonly externalId: string }
  | { readonly kind: "skip" };

type GraphWhen = { readonly wall: WallTime; readonly date: string; readonly midnight: boolean };

function parseWhen(v: unknown): { when: GraphWhen; zone: string } | undefined {
  const rec = asRecord(v);
  const dt = rec === undefined ? undefined : stringField(rec, "dateTime");
  const m = dt === undefined ? null : DATE_TIME_RE.exec(dt);
  if (rec === undefined || m === null) return undefined;
  const wall: WallTime = {
    y: Number(m[1]),
    mo: Number(m[2]),
    d: Number(m[3]),
    h: Number(m[4]),
    mi: Number(m[5]),
    s: Number(m[6]),
  };
  return {
    when: {
      wall,
      date: `${m[1]}-${m[2]}-${m[3]}`,
      midnight: wall.h === 0 && wall.mi === 0 && wall.s === 0,
    },
    zone: stringField(rec, "timeZone")?.trim() ?? "",
  };
}

function instantOf(when: GraphWhen, zone: string): number | undefined {
  if (zone.toUpperCase() === "UTC") {
    const w = when.wall;
    return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  }
  return zone === "" ? undefined : wallToInstantMs(when.wall, zone);
}

function timedInstants(
  start: { when: GraphWhen; zone: string },
  end: { when: GraphWhen; zone: string },
): { startMs: number; endMs: number } | undefined {
  const startMs = instantOf(start.when, start.zone);
  const endMs = instantOf(end.when, end.zone);
  return startMs === undefined || endMs === undefined ? undefined : { startMs, endMs };
}

function instantsOf(
  raw: Record<string, unknown>,
  allDay: boolean,
  gatewayZone: string,
): { startMs: number; endMs: number } | undefined {
  const start = parseWhen(raw["start"]);
  const end = parseWhen(raw["end"]);
  if (start === undefined || end === undefined) return undefined;
  if (!allDay) return timedInstants(start, end);
  // An all-day event must start and end at midnight; anything else is not the shape this expects.
  if (!start.when.midnight || !end.when.midnight) return undefined;
  return allDayInstants(start.when.date, end.when.date, gatewayZone);
}

function clamp(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function selfResponseOf(raw: Record<string, unknown>, attendeeCount: number) {
  if (attendeeCount === 0) return null;
  const rs = asRecord(raw["responseStatus"]);
  return normalizeSelfResponse(rs === undefined ? undefined : rs["response"]);
}

export function mapOutlookCalendarEvent(
  raw: unknown,
  ctx: { zone: string; syncedAt: number },
): OutlookEventMapping {
  const ev = asRecord(raw);
  const id = ev === undefined ? "" : (stringField(ev, "id")?.trim() ?? "");
  if (ev === undefined || id === "") return { kind: "skip" };
  if (ev["isCancelled"] === true) return { kind: "delete", externalId: id };

  const attendees = Array.isArray(ev["attendees"]) ? (ev["attendees"] as unknown[]) : [];
  const allDay = ev["isAllDay"] === true;
  const instants = instantsOf(ev, allDay, ctx.zone);
  const organizer = asRecord(asRecord(ev["organizer"])?.["emailAddress"]);
  const subject = stringField(ev, "subject")?.trim() ?? "";

  const metadata: Record<string, unknown> = {
    ...normalizedEventKeys({
      ...(instants === undefined ? {} : { instants }),
      allDay,
      status: stringField(ev, "showAs") === "tentative" ? "tentative" : "confirmed",
      selfResponse: selfResponseOf(ev, attendees.length),
      organizerEmail: organizer === undefined ? undefined : stringField(organizer, "address"),
      attendeeCount: attendees.length,
    }),
    meta_v: OUTLOOK_EVENT_META_VERSION,
  };
  const location = stringField(asRecord(ev["location"]) ?? {}, "displayName");
  if (location !== undefined && location !== "") metadata["location"] = location;
  for (const [key, field] of [
    ["ical_uid", "iCalUId"],
    ["series_master_id", "seriesMasterId"],
  ] as const) {
    const v = stringField(ev, field);
    if (v !== undefined && v !== "") metadata[key] = v;
  }

  return {
    kind: "row",
    unresolved: instants === undefined,
    row: {
      service: "outlook",
      type: "event",
      externalId: id,
      title: subject === "" ? "(no subject)" : clamp(subject, TITLE_MAX),
      bodyPreview: capPreview(stringField(ev, "bodyPreview") ?? ""),
      url: stringField(ev, "webLink") ?? null,
      canonicalUrl: null,
      modifiedAt: modifiedMsFromIso(stringField(ev, "lastModifiedDateTime"), ctx.syncedAt),
      metadata,
      syncedAt: ctx.syncedAt,
    },
  };
}
