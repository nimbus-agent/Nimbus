/**
 * Gateway-side mapper: a ParsedEvent (from @nimbus-dev/sdk) → a MappedRow for
 * the local index. Produces `apple:event` rows.
 *
 * PII bounds (per spec): summary/start/end/location/organizer/status/recurrence
 * + ≤2000-char notes preview + attendee emails. No body bytes.
 *
 * Recurrence: server-side expand is expected (CalDAV `expand:true`). Override
 * occurrences key on `<UID>:<RECURRENCE-ID>`.
 */
import type { ParsedEvent } from "@nimbus-dev/sdk";
import type { IcalDurationParts, IcalEventExtras } from "./_lib/ical-event-extras.ts";
import { capPreview } from "./_lib/imap-client.ts";
import { gatewayZone, type WallTime, wallToInstantMs } from "./_lib/zoned-time.ts";
import type { MappedRow } from "./mapped-row.ts";

/**
 * The depth version of an iCloud event row (Phase 10 MB1): a row written with the normalized time keys
 * (`start_ms`, `end_ms`, `all_day`, `organizer_email`, `attendee_count`, `self_response`). NOT in
 * `REBODY_META_TARGETS`: `apple-sync.ts` re-fetches the whole CalDAV window on EVERY pass, so every
 * event in the window reaches this version within one sync, and an event older than the window could
 * never be re-walked (a registered target would stay pending forever).
 */
export const EVENT_META_VERSION = 1;

const TITLE_MAX = 256;

/**
 * Clamp a string to `max` chars, appending an ellipsis when truncated.
 * Mirrors the behaviour of `clamp` in `_lib/email-mapping.ts`.
 */
function clamp(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Parse an iCalendar date/datetime string to epoch milliseconds, or null when
 * the value is absent or cannot be parsed. This is the contract of `modified_at` ONLY (a floating
 * time counts as UTC there); changing it would move `modified_at` of every stored event. The
 * normalized `start_ms` / `end_ms` use `instantOfIcalValue` below instead.
 *
 * iCalendar datetimes are either:
 *   - `YYYYMMDDTHHMMSSZ`  (UTC; `Z` suffix)
 *   - `YYYYMMDDTHHMMSS`   (floating; treat as UTC for indexing purposes)
 *   - `YYYYMMDD`          (all-day; treat as midnight UTC)
 */
function parseICalDateMs(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === "") {
    return null;
  }
  const v = value.trim();
  // Attempt direct Date.parse first (handles ISO-like strings)
  const ms = Date.parse(v);
  if (Number.isFinite(ms)) {
    return ms;
  }
  // iCalendar compact form: YYYYMMDD[THHMMSS[Z]]
  const compact = /^(\d{4})(\d{2})(\d{2})(T(\d{2})(\d{2})(\d{2})(Z)?)?$/i.exec(v);
  if (compact !== null) {
    const [, y, mo, d, , hh = "00", mm = "00", ss = "00"] = compact;
    const iso = `${y}-${mo}-${d}T${hh}:${mm}:${ss}Z`;
    const parsed = Date.parse(iso);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

const ICAL_VALUE_RE = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/i;
const DAY_MS = 86_400_000;

type IcalInstant = {
  readonly ms: number;
  readonly dateOnly: boolean;
  /** The wall time as written, and the zone it is a wall time in (`UTC` for a `Z` value). */
  readonly wall: WallTime;
  readonly zone: string;
};

/**
 * An iCalendar value as an instant. A trailing `Z` is UTC; a date-only value is midnight in `zone`
 * (an all-day event is the owner's local day); any other datetime is a wall time in its `TZID`, else
 * in `zone` (a floating time). An unknown TZID falls back to `zone`.
 */
function instantOfIcalValue(
  value: string | null,
  tzid: string | undefined,
  zone: string,
): IcalInstant | undefined {
  const m = value === null ? null : ICAL_VALUE_RE.exec(value.trim());
  if (m === null) return undefined;
  const [, y = "", mo = "", d = "", h, mi, sec, z] = m;
  const wall: WallTime = {
    y: Number(y),
    mo: Number(mo),
    d: Number(d),
    h: Number(h ?? 0),
    mi: Number(mi ?? 0),
    s: Number(sec ?? 0),
  };
  const dateOnly = h === undefined;
  if (z !== undefined) {
    const ms = Date.UTC(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi, wall.s);
    return Number.isFinite(ms) ? { ms, dateOnly, wall, zone: "UTC" } : undefined;
  }
  const tzMs = tzid === undefined || dateOnly ? undefined : wallToInstantMs(wall, tzid);
  if (tzMs !== undefined && tzid !== undefined) return { ms: tzMs, dateOnly, wall, zone: tzid };
  const ms = wallToInstantMs(wall, zone);
  return ms === undefined ? undefined : { ms, dateOnly, wall, zone };
}

/**
 * The end of an event with no DTEND (RFC 5545 section 3.6.1): `start` plus its DURATION, whose
 * day/week part is NOMINAL (the same wall time `days` calendar days later in the event's zone, so a
 * day across a DST change is 23 or 25 hours) and whose hour/minute/second part is exact and added
 * afterwards. With no DURATION an all-day event lasts one day and a timed one ends when it starts.
 */
function endWithoutDtend(
  start: IcalInstant,
  allDay: boolean,
  parts: IcalDurationParts | undefined,
): number {
  const days = parts?.days ?? (allDay ? 1 : 0);
  const exactMs = parts?.ms ?? 0;
  if (days === 0) return start.ms + exactMs;
  const shifted = new Date(Date.UTC(start.wall.y, start.wall.mo - 1, start.wall.d + days));
  const nominal = wallToInstantMs(
    {
      ...start.wall,
      y: shifted.getUTCFullYear(),
      mo: shifted.getUTCMonth() + 1,
      d: shifted.getUTCDate(),
    },
    start.zone,
  );
  return (nominal ?? start.ms + days * DAY_MS) + exactMs;
}

/** `start_ms` / `end_ms`, or an empty object when DTSTART cannot be resolved. */
function eventTimes(
  ev: ParsedEvent,
  extras: IcalEventExtras | undefined,
  zone: string,
): { start_ms?: number; end_ms?: number } {
  const start = instantOfIcalValue(ev.start, extras?.startTzid, zone);
  if (start === undefined) return {};
  const end = instantOfIcalValue(ev.end, extras?.endTzid, zone);
  if (end !== undefined) return { start_ms: start.ms, end_ms: end.ms };
  return { start_ms: start.ms, end_ms: endWithoutDtend(start, ev.allDay, extras?.durationParts) };
}

/** The own-address PARTSTAT (`accepted`, `declined`, `tentative`, `needs-action`), else `null`. */
function selfResponse(
  extras: IcalEventExtras | undefined,
  selfEmail: string | undefined,
): string | null {
  if (extras === undefined || selfEmail === undefined || selfEmail.trim() === "") return null;
  return extras.partstatByAddress.get(selfEmail.trim().toLowerCase()) ?? null;
}

/**
 * Map a `ParsedEvent` from the SDK iCalendar parser to a gateway
 * `MappedRow<"apple","event">`.
 *
 * Returns `null` when the event carries no UID (nothing stable to key on).
 */
export function mapAppleEventToItem(
  ev: ParsedEvent,
  ctx: {
    calendar: string;
    syncedAt: number;
    /** The account address, for `self_response`. */
    selfEmail?: string;
    /** What the SDK parser drops (TZID, DURATION, PARTSTAT), from the same raw ICS. */
    extras?: IcalEventExtras;
    /** The zone for floating times and all-day dates; the gateway's own when absent. */
    zone?: string;
  },
): MappedRow<"apple", "event"> | null {
  const uid = ev.uid.trim();
  if (uid === "") {
    return null;
  }

  const externalId =
    ev.recurrenceId !== null && ev.recurrenceId !== "" ? `${uid}:${ev.recurrenceId}` : uid;

  const summaryRaw = ev.summary?.trim() ?? "";
  const title = summaryRaw === "" ? "(untitled event)" : clamp(summaryRaw, TITLE_MAX);

  const bodyPreview = capPreview(ev.description ?? "");

  // modifiedAt: prefer DTSTAMP, fall back to DTSTART, then syncedAt
  const modifiedAt = parseICalDateMs(ev.dtstamp) ?? parseICalDateMs(ev.start) ?? ctx.syncedAt;

  const metadata: Record<string, unknown> = {
    uid,
    calendar: ctx.calendar,
    start: ev.start,
    end: ev.end,
    allDay: ev.allDay,
    location: ev.location,
    organizer: ev.organizer,
    status: ev.status,
    recurrence: ev.rrule,
    attendees: ev.attendees,
    // Normalized keys (Phase 10 MB1). The raw keys above stay for existing readers; `status` stays the
    // raw iCal value (upper case, e.g. CONFIRMED), so a reader compares it case-insensitively.
    ...eventTimes(ev, ctx.extras, ctx.zone ?? gatewayZone()),
    all_day: ev.allDay,
    ...(ev.organizer !== null && ev.organizer.trim() !== ""
      ? { organizer_email: ev.organizer.trim().toLowerCase() }
      : {}),
    attendee_count: ev.attendees.length,
    self_response: selfResponse(ctx.extras, ctx.selfEmail),
    meta_v: EVENT_META_VERSION,
  };

  return {
    service: "apple",
    type: "event",
    externalId,
    title,
    bodyPreview,
    url: null,
    canonicalUrl: null,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
