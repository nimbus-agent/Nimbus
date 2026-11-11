import {
  allDayInstants,
  normalizedEventKeys,
  normalizeSelfResponse,
} from "./_lib/calendar-event-normalize.ts";
import { capPreview } from "./_lib/imap-client.ts";
import { type WallTime, wallToInstantMs } from "./_lib/zoned-time.ts";
import { GOOGLE_CALENDAR_EVENT_META_VERSION } from "./calendar-event-meta.ts";
import type { MappedRow } from "./mapped-row.ts";
import { asRecord, stringField } from "./unknown-record.ts";

/**
 * A Google Calendar Events resource (documented shape) to a `google_calendar:event` row (Phase 10
 * MB2b). Pure over `unknown`: nothing here trusts the provider's field types.
 */

const TITLE_MAX = 256;

/** A Google event id is unique per calendar, not per account, so the row key carries the calendar. */
export function googleCalendarExternalId(calendarId: string, eventId: string): string {
  return `${calendarId}|${eventId}`;
}

/** True for an event the provider reports as cancelled (the caller deletes its row). */
export function isCancelledGoogleEvent(raw: unknown): boolean {
  return stringField(asRecord(raw) ?? {}, "status") === "cancelled";
}

const DATE_TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;

/** An RFC 3339 `dateTime`: an offset/`Z` carries its own instant; a floating one uses `timeZone`. */
function dateTimeInstant(value: string, zone: string): number | undefined {
  const m = DATE_TIME_RE.exec(value);
  if (m === null) return undefined;
  if (m[7] !== undefined) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : undefined;
  }
  const wall: WallTime = {
    y: Number(m[1]),
    mo: Number(m[2]),
    d: Number(m[3]),
    h: Number(m[4]),
    mi: Number(m[5]),
    s: Number(m[6]),
  };
  return wallToInstantMs(wall, zone);
}

function nextDate(date: string): string {
  const ms = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(ms) ? new Date(ms + 86_400_000).toISOString().slice(0, 10) : date;
}

type Instants = { readonly startMs: number; readonly endMs: number; readonly allDay: boolean };

function instantsOf(
  start: Record<string, unknown>,
  end: Record<string, unknown> | undefined,
  zone: string,
): Instants | undefined {
  const startDate = stringField(start, "date");
  if (startDate !== undefined) {
    const endDate =
      (end === undefined ? undefined : stringField(end, "date")) ?? nextDate(startDate);
    const r = allDayInstants(startDate, endDate, zone);
    return r === undefined ? undefined : { ...r, allDay: true };
  }
  const startDt = stringField(start, "dateTime");
  if (startDt === undefined) return undefined;
  const startMs = dateTimeInstant(startDt, stringField(start, "timeZone") ?? zone);
  if (startMs === undefined) return undefined;
  const endDt = end === undefined ? undefined : stringField(end, "dateTime");
  const endMs =
    endDt === undefined
      ? startMs
      : (dateTimeInstant(endDt, (end && stringField(end, "timeZone")) ?? zone) ?? startMs);
  return { startMs, endMs, allDay: false };
}

function selfResponseOf(attendees: readonly unknown[]): ReturnType<typeof normalizeSelfResponse> {
  for (const a of attendees) {
    const rec = asRecord(a);
    if (rec !== undefined && rec["self"] === true) {
      return normalizeSelfResponse(rec["responseStatus"]);
    }
  }
  return null;
}

function clamp(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function optionalString(
  out: Record<string, unknown>,
  key: string,
  value: string | undefined,
): void {
  if (value !== undefined && value !== "") out[key] = value;
}

/**
 * Returns `null` for a cancelled event, an event with no id, and one whose start cannot be resolved
 * to an instant (nothing to place it by).
 */
export function mapGoogleCalendarEvent(
  raw: unknown,
  ctx: { calendarId: string; calendarName: string; zone: string; syncedAt: number },
): MappedRow<"google_calendar", "event"> | null {
  const ev = asRecord(raw);
  if (ev === undefined) return null;
  const id = stringField(ev, "id")?.trim() ?? "";
  const rawStatus = stringField(ev, "status");
  if (id === "" || rawStatus === "cancelled") return null;
  const start = asRecord(ev["start"]);
  if (start === undefined) return null;
  const when = instantsOf(start, asRecord(ev["end"]), ctx.zone);
  if (when === undefined) return null;

  const attendees = Array.isArray(ev["attendees"]) ? (ev["attendees"] as unknown[]) : [];
  const summary = stringField(ev, "summary")?.trim() ?? "";
  const updated = stringField(ev, "updated");
  const updatedMs = updated === undefined ? Number.NaN : Date.parse(updated);
  const organizer = asRecord(ev["organizer"]);

  const metadata: Record<string, unknown> = {
    ...normalizedEventKeys({
      instants: { startMs: when.startMs, endMs: when.endMs },
      allDay: when.allDay,
      status: rawStatus === "tentative" ? "tentative" : "confirmed",
      selfResponse: selfResponseOf(attendees),
      organizerEmail: organizer === undefined ? undefined : stringField(organizer, "email"),
      attendeeCount: attendees.length,
    }),
    calendar_id: ctx.calendarId,
    meta_v: GOOGLE_CALENDAR_EVENT_META_VERSION,
  };
  optionalString(metadata, "calendar_name", ctx.calendarName);
  optionalString(metadata, "location", stringField(ev, "location"));
  optionalString(metadata, "ical_uid", stringField(ev, "iCalUID"));
  optionalString(metadata, "recurring_event_id", stringField(ev, "recurringEventId"));

  return {
    service: "google_calendar",
    type: "event",
    externalId: googleCalendarExternalId(ctx.calendarId, id),
    title: summary === "" ? "(untitled event)" : clamp(summary, TITLE_MAX),
    bodyPreview: capPreview(stringField(ev, "description") ?? ""),
    url: stringField(ev, "htmlLink") ?? null,
    canonicalUrl: null,
    modifiedAt: Number.isFinite(updatedMs) ? updatedMs : ctx.syncedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
