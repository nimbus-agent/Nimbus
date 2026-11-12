import { wallToInstantMs } from "../util/zoned-time.ts";

/**
 * When an item is due, as an instant (Phase 10 MB5, plan deviation 6).
 *
 * Jira and Linear write a DATE-only due date as `Date.parse("YYYY-MM-DD")`, which is 00:00 UTC. Read
 * literally, west of UTC that calls a ticket due on the 12th "due today" on the 11th, and east of UTC it
 * is a day late for "overdue". So for those two the due DATE is the UTC calendar date of the stored
 * value and the due INSTANT is the END of that date in the briefing zone (the local midnight that
 * begins the next date). A GitHub milestone `due_on` is a full timestamp and is used as stored.
 */
export type DueService = "jira" | "linear" | "github";

const DAY_MS = 86_400_000;

export function dueInstant(service: DueService, dueAtMs: number, tz: string): number {
  if (service === "github") return dueAtMs;
  const d = new Date(dueAtMs);
  const endOfDate = wallToInstantMs(
    { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate() + 1, h: 0, mi: 0, s: 0 },
    tz,
  );
  // An unknown zone cannot place the local midnight; the next UTC midnight is the nearest honest answer.
  return endOfDate ?? Math.floor(dueAtMs / DAY_MS) * DAY_MS + DAY_MS;
}

export type DueClass = "overdue" | "today" | "later";

/** Overdue = `due <= now`; due today = `now < due <= endOfToday`; otherwise later. */
export function classifyDue(dueInstantMs: number, nowMs: number, endOfTodayMs: number): DueClass {
  if (dueInstantMs <= nowMs) return "overdue";
  return dueInstantMs <= endOfTodayMs ? "today" : "later";
}
