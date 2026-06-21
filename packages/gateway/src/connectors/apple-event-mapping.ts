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
import { capPreview } from "./_lib/imap-client.ts";
import type { MappedRow } from "./mapped-row.ts";

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
 * the value is absent or cannot be parsed.
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

/**
 * Map a `ParsedEvent` from the SDK iCalendar parser to a gateway
 * `MappedRow<"apple","event">`.
 *
 * Returns `null` when the event carries no UID (nothing stable to key on).
 */
export function mapAppleEventToItem(
  ev: ParsedEvent,
  ctx: { calendar: string; syncedAt: number },
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
