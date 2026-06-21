/**
 * CalDAV client interface + pure calendar selection/normalization helpers
 * for the iCloud Calendar connector.
 *
 * Design: the CalDavClient interface is the injectable seam — the real (network)
 * implementation lives in server.ts (coverage-excluded). Pure helpers are
 * separately tested here.
 */

import type { ParsedEvent } from "@nimbus-dev/sdk";

// ---------------------------------------------------------------------------
// CalendarRef — a discovered calendar
// ---------------------------------------------------------------------------

export interface CalendarRef {
  readonly url: string;
  readonly displayName: string;
}

// ---------------------------------------------------------------------------
// EventWindow — a UTC time range for fetching events
// ---------------------------------------------------------------------------

export interface EventWindow {
  readonly startUtc: string;
  readonly endUtc: string;
}

// ---------------------------------------------------------------------------
// CalDavClient — injectable transport interface
// ---------------------------------------------------------------------------

export interface CalDavClient {
  listCalendars(): Promise<CalendarRef[]>;
  listEvents(
    cal: CalendarRef,
    window: EventWindow,
  ): Promise<{ href: string; event: ParsedEvent }[]>;
  putEvent(cal: CalendarRef, uid: string, ics: string): Promise<{ href: string }>;
  deleteEvent(href: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// selectCalendars — pure calendar filter helper
// ---------------------------------------------------------------------------

/**
 * Filter the full list of calendars by include/exclude display-name lists.
 *
 * Rules (in priority order):
 * 1. If `include` is non-empty, return only calendars whose `displayName`
 *    appears in the include list (exact match).
 * 2. Else if `exclude` is non-empty, return all calendars whose `displayName`
 *    does NOT appear in the exclude list.
 * 3. Both empty (or both absent) → return all calendars.
 */
export function selectCalendars(
  all: CalendarRef[],
  cfg: { include?: readonly string[] | undefined; exclude?: readonly string[] | undefined },
): CalendarRef[] {
  const include = cfg.include ?? [];
  const exclude = cfg.exclude ?? [];

  if (include.length > 0) {
    const includeSet = new Set(include);
    return all.filter((c) => includeSet.has(c.displayName));
  }

  if (exclude.length > 0) {
    const excludeSet = new Set(exclude);
    return all.filter((c) => !excludeSet.has(c.displayName));
  }

  return all;
}

// ---------------------------------------------------------------------------
// clampInstances — cap the number of events returned per calendar
// ---------------------------------------------------------------------------

/**
 * Return the first `max` elements from `rows`. When `rows.length <= max`,
 * returns the original array reference unchanged (zero allocation).
 */
export function clampInstances<T>(rows: readonly T[], max: number): T[] {
  if (rows.length <= max) {
    return rows as T[];
  }
  return rows.slice(0, max);
}
