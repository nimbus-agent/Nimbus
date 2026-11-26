// Phase 7 (the Cost Pack, slice 3): the period a cost report covers, in the report's time zone.
//
// Confined by static rule D48 (no network, no connector, no model). Pure.
//
// `week` is the previous full Monday–Sunday week by the zone's calendar, `month` the previous full calendar
// month, `<N>d` the N days ending yesterday. `previous` is the period before it of the same kind: the week
// before, the calendar month before (by calendar, never a day-count shift), the N days before. The zone only
// decides WHICH dates; cost lines carry UTC charge days, so a line is never re-split by hour (a stated bound).
import { wallOfInstant } from "../util/zoned-time.ts";
import type { CostWindow } from "./cost-views.ts";

const DAY_MS = 86_400_000;
const PERIOD_RE = /^(?:week|month|(\d{1,3})d)$/;
const MAX_DAYS = 400;
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export class CostReportPeriodError extends Error {
  override readonly name = "CostReportPeriodError";
}

export interface CostReportPeriods {
  readonly range: CostWindow;
  readonly previous: CostWindow;
  /** The Monday of `range` for a `week` report; null otherwise. */
  readonly weekStart: string | null;
}

/** A calendar date as UTC midnight milliseconds: date arithmetic only, no zone. */
const dateMs = (y: number, mo: number, d: number): number => Date.UTC(y, mo - 1, d);
const dayText = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Today's calendar date in `tz`, as UTC midnight milliseconds. */
function todayIn(tz: string, nowMs: number): number {
  const wall = wallOfInstant(nowMs, tz);
  if (wall === undefined || !Number.isFinite(wall.y)) {
    throw new CostReportPeriodError(`not a time zone: ${tz.slice(0, 64)}`);
  }
  return dateMs(wall.y, wall.mo, wall.d);
}

function weekPeriods(today: number): CostReportPeriods {
  const sinceMonday = (new Date(today).getUTCDay() + 6) % 7;
  const monday = today - (sinceMonday + 7) * DAY_MS;
  const weekStart = dayText(monday);
  return {
    range: {
      fromDay: weekStart,
      toDay: dayText(monday + 6 * DAY_MS),
      label: `week of Monday ${weekStart}`,
    },
    previous: {
      fromDay: dayText(monday - 7 * DAY_MS),
      toDay: dayText(monday - DAY_MS),
      label: "the week before",
    },
    weekStart,
  };
}

/** The calendar month `back` months before the month of `today` (1 = last month). */
function monthWindow(today: number, back: number): CostWindow {
  const t = new Date(today);
  const first = Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - back, 1);
  const last = Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - back + 1, 1) - DAY_MS;
  const f = new Date(first);
  return {
    fromDay: dayText(first),
    toDay: dayText(last),
    label: `${MONTHS[f.getUTCMonth()] ?? ""} ${String(f.getUTCFullYear())}`,
  };
}

function dayPeriods(today: number, n: number): CostReportPeriods {
  const to = today - DAY_MS;
  const from = to - (n - 1) * DAY_MS;
  return {
    range: {
      fromDay: dayText(from),
      toDay: dayText(to),
      label: `the ${String(n)} days to ${dayText(to)}`,
    },
    previous: {
      fromDay: dayText(from - n * DAY_MS),
      toDay: dayText(from - DAY_MS),
      label: `the ${String(n)} days before`,
    },
    weekStart: null,
  };
}

/** The period a report covers now, and the period before it, in `tz`. Throws on a bad period or zone. */
export function reportPeriods(period: string, tz: string, nowMs: number): CostReportPeriods {
  const m = PERIOD_RE.exec(period);
  const n = m?.[1] === undefined ? null : Number(m[1]);
  if (m === null || (n !== null && (n < 1 || n > MAX_DAYS))) {
    throw new CostReportPeriodError(`not a report period: ${period.slice(0, 32)}`);
  }
  const today = todayIn(tz, nowMs);
  if (period === "week") return weekPeriods(today);
  if (period === "month") {
    return { range: monthWindow(today, 1), previous: monthWindow(today, 2), weekStart: null };
  }
  return dayPeriods(today, n as number);
}
