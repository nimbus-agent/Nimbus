import type { BriefingDay } from "../agents/_lib/briefing-types.ts";
import { wallOfInstant, wallToInstantMs } from "../util/zoned-time.ts";

const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" });

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

export function dateKeyOf(y: number, mo: number, d: number): string {
  return `${pad(y, 4)}-${pad(mo, 2)}-${pad(d, 2)}`;
}

/** The calendar date (`YYYY-MM-DD`) of an instant in `zone`, or `undefined` for an unknown zone. */
export function dateKeyInZone(ms: number, zone: string): string | undefined {
  const w = wallOfInstant(ms, zone);
  return w === undefined ? undefined : dateKeyOf(w.y, w.mo, w.d);
}

/**
 * The briefing day containing `nowMs` in `tz`: half-open, from local 00:00 to the next local 00:00. The
 * end is the next date's midnight resolved through the zone (never `+ 86_400_000`), so a 23 h or 25 h
 * DST day is the right length. A midnight inside a DST gap resolves with the pre-gap offset.
 */
export function dayRange(nowMs: number, tz: string): BriefingDay {
  const w = wallOfInstant(nowMs, tz);
  if (w === undefined) throw new RangeError(`"${tz}" is not a time zone`);
  const startMs = wallToInstantMs({ y: w.y, mo: w.mo, d: w.d, h: 0, mi: 0, s: 0 }, tz);
  const endMs = wallToInstantMs({ y: w.y, mo: w.mo, d: w.d + 1, h: 0, mi: 0, s: 0 }, tz);
  if (startMs === undefined || endMs === undefined) {
    throw new RangeError(`"${tz}" is not a time zone`);
  }
  const dateKey = dateKeyOf(w.y, w.mo, w.d);
  const weekday = WEEKDAY.format(new Date(Date.UTC(w.y, w.mo - 1, w.d)));
  return { startMs, endMs, dateKey, label: `${weekday} ${dateKey}` };
}

export type DayEvent = {
  readonly startMs: number;
  readonly endMs: number;
  readonly allDay: boolean;
};

/**
 * Whether an event belongs on `day`.
 *
 * Timed: the half-open instant overlap, with a zero-length event counted when it starts inside the day.
 * All-day: compared by CALENDAR DATE, because the sync wrote these as midnights in the GATEWAY zone,
 * which may differ from the briefing zone: the event covers the day iff `startDate <= dateKey <
 * endDateExclusive`, with both dates read back in `gatewayZone`.
 */
export function eventOnDay(ev: DayEvent, day: BriefingDay, gatewayZone: string): boolean {
  if (!ev.allDay) {
    return (
      ev.startMs < day.endMs &&
      (ev.endMs > day.startMs || (ev.endMs === ev.startMs && ev.startMs >= day.startMs))
    );
  }
  const startKey = dateKeyInZone(ev.startMs, gatewayZone);
  if (startKey === undefined) return false;
  const endKey = ev.endMs > ev.startMs ? dateKeyInZone(ev.endMs, gatewayZone) : undefined;
  // A missing or inverted end is a single-day event: it covers its start date only.
  if (endKey === undefined) return startKey === day.dateKey;
  return startKey <= day.dateKey && day.dateKey < endKey;
}
