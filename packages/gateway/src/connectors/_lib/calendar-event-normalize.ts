import { type WallTime, wallToInstantMs } from "./zoned-time.ts";

/**
 * The shared pieces of the normalized calendar-event contract (Phase 10 MB2b, spec D-MB-3): every
 * provider that writes `event` rows (iCloud since MB1, Google Calendar and Outlook from MB2b) carries
 * the same seven metadata keys, so the morning briefing unions them with one query.
 */

/** The `self_response` vocabulary, shared by every provider (`null` when it is not knowable). */
export type SelfResponse = "accepted" | "declined" | "tentative" | "needs-action";

const SELF_RESPONSES: ReadonlyMap<string, SelfResponse> = new Map<string, SelfResponse>([
  // Google `attendees[].responseStatus`
  ["needsaction", "needs-action"],
  ["accepted", "accepted"],
  ["declined", "declined"],
  ["tentative", "tentative"],
  // Graph `responseStatus.response`
  ["none", "needs-action"],
  ["notresponded", "needs-action"],
  ["organizer", "accepted"],
  ["tentativelyaccepted", "tentative"],
]);

/** Maps a provider's response value to the shared vocabulary; anything else is `null`. */
export function normalizeSelfResponse(raw: unknown): SelfResponse | null {
  if (typeof raw !== "string") return null;
  return SELF_RESPONSES.get(raw.trim().toLowerCase()) ?? null;
}

/**
 * The query window every calendar sync keeps: from one day back to 30 days ahead of the anchor.
 * A (re)anchor is made at least every `REANCHOR_MS`, so the horizon shrinks to no less than +23 days
 * between re-anchors (a provider token is bound to the window that minted it).
 */
export const CALENDAR_WINDOW = {
  BACK_MS: 86_400_000,
  AHEAD_MS: 30 * 86_400_000,
  REANCHOR_MS: 7 * 86_400_000,
} as const;

/** The window start a (re)anchor at `nowMs` uses. */
export function windowStartFor(nowMs: number): number {
  return nowMs - CALENDAR_WINDOW.BACK_MS;
}

/** The end of the window that began at `windowStart` (31 days later: 1 back + 30 ahead). */
export function windowEnd(windowStart: number): number {
  return windowStart + CALENDAR_WINDOW.BACK_MS + CALENDAR_WINDOW.AHEAD_MS;
}

/** True when an event lies wholly before the window or starts after it; an edge overlap is inside. */
export function isOutsideWindow(startMs: number, endMs: number, windowStart: number): boolean {
  return endMs < windowStart || startMs > windowEnd(windowStart);
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function midnightOf(date: string, zone: string): number | undefined {
  const m = DATE_RE.exec(date);
  if (m === null) return undefined;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    return undefined;
  }
  const wall: WallTime = { y, mo, d, h: 0, mi: 0, s: 0 };
  return wallToInstantMs(wall, zone);
}

/**
 * An all-day event's instants: midnight at the start date to midnight at the (exclusive) end date,
 * both in `zone` (the gateway's zone: the owner's briefing day). `undefined` when either date or the
 * zone is unusable.
 */
export function allDayInstants(
  startDate: string,
  endDateExclusive: string,
  zone: string,
): { startMs: number; endMs: number } | undefined {
  const startMs = midnightOf(startDate, zone);
  const endMs = midnightOf(endDateExclusive, zone);
  if (startMs === undefined || endMs === undefined) return undefined;
  return { startMs, endMs };
}

export type NormalizedEventInput = {
  /** Both epoch keys are omitted together when the provider's time could not be resolved. */
  readonly instants?: { readonly startMs: number; readonly endMs: number };
  readonly allDay: boolean;
  readonly status: string;
  readonly selfResponse: SelfResponse | null;
  readonly organizerEmail?: string | undefined;
  readonly attendeeCount: number;
};

/** The D-MB-3 metadata keys of one event: `start_ms`, `end_ms`, `all_day`, `status`, `self_response`, `organizer_email`, `attendee_count`. */
export function normalizedEventKeys(input: NormalizedEventInput): Record<string, unknown> {
  const organizer = input.organizerEmail?.trim().toLowerCase();
  return {
    ...(input.instants === undefined
      ? {}
      : { start_ms: input.instants.startMs, end_ms: input.instants.endMs }),
    all_day: input.allDay,
    status: input.status,
    self_response: input.selfResponse,
    ...(organizer === undefined || organizer === "" ? {} : { organizer_email: organizer }),
    attendee_count: input.attendeeCount,
  };
}
