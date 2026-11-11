// packages/gateway/src/automation/cron.ts
// A five-field cron expression and "when does it fire next" (Phase 10 SA4, plan task 2). No
// dependency: the grammar is small on purpose and everything outside it is refused, so a schedule
// a user reads is the schedule that runs.
//
//   field          range   forms
//   minute         0-59    *   N   a,b   a-b   star-slash-n   a-b-slash-n
//   hour           0-23
//   day of month   1-31
//   month          1-12
//   day of week    0-7     (0 and 7 are Sunday)
//
// Refused: names (JAN, MON), `L`, `W`, `#`, `?`, a seconds field, `a/n`, and every macro except
// @hourly, @daily, @weekly and @monthly. When both day-of-month and day-of-week are restricted the
// standard rule applies: a day matches if EITHER does.
//
// `nextFire(expr, tz, afterMs)` works in the zone's WALL clock and converts a candidate back to an
// instant. A wall minute that does not exist (a spring-forward gap) is skipped; one that happens
// twice (a fall-back overlap) fires once, at its first occurrence.

/** The fewest minutes between two fires that `workflow.save` accepts. */
export const MIN_INTERVAL_MINUTES = 5;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** How many calendar days a search looks ahead before deciding an expression never fires. */
const SEARCH_DAYS = 366 * 8;
const SAMPLE_STARTS = 48;

export class CronError extends Error {}

export interface CronSpec {
  readonly minutes: readonly number[];
  readonly hours: readonly number[];
  readonly daysOfMonth: readonly number[];
  readonly months: readonly number[];
  /** 0-6, Sunday = 0. */
  readonly daysOfWeek: readonly number[];
  /** The field began with `*`: it does not restrict the day (the OR rule applies only if neither does). */
  readonly domIsStar: boolean;
  readonly dowIsStar: boolean;
}

const MACROS: Readonly<Record<string, string>> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
};

type FieldBounds = { readonly name: string; readonly min: number; readonly max: number };

const MINUTE: FieldBounds = { name: "minute", min: 0, max: 59 };
const HOUR: FieldBounds = { name: "hour", min: 0, max: 23 };
const DAY_OF_MONTH: FieldBounds = { name: "day of month", min: 1, max: 31 };
const MONTH: FieldBounds = { name: "month", min: 1, max: 12 };
const DAY_OF_WEEK: FieldBounds = { name: "day of week", min: 0, max: 7 };

function toInt(text: string, f: FieldBounds): number {
  if (!/^\d{1,2}$/.test(text)) {
    throw new CronError(
      `${f.name}: "${text}" is not a number (names and symbols are not supported)`,
    );
  }
  const n = Number(text);
  if (n < f.min || n > f.max) {
    throw new CronError(`${f.name}: ${text} is outside ${String(f.min)}-${String(f.max)}`);
  }
  return n;
}

function stepOf(text: string | undefined, f: FieldBounds): number {
  if (text === undefined) return 1;
  if (!/^\d{1,2}$/.test(text) || Number(text) < 1) {
    throw new CronError(`${f.name}: the step "${text}" must be a positive whole number`);
  }
  return Number(text);
}

/** The inclusive bounds of a comma item's body, or `undefined` for a single value. */
function rangeOf(body: string, f: FieldBounds): { lo: number; hi: number } | undefined {
  if (body === "*") return { lo: f.min, hi: f.max === 7 ? 6 : f.max };
  if (!body.includes("-")) return undefined;
  const parts = body.split("-");
  if (parts.length !== 2) throw new CronError(`${f.name}: "${body}" is not valid`);
  const lo = toInt(parts[0] ?? "", f);
  const hi = toInt(parts[1] ?? "", f);
  if (lo > hi) throw new CronError(`${f.name}: the range "${body}" runs backwards`);
  return { lo, hi };
}

/** One comma item: `*`, `*` with a step, `N`, `a-b` or `a-b` with a step, expanded to its values. */
function expandItem(item: string, f: FieldBounds): number[] {
  const [body = "", stepText, ...extra] = item.split("/");
  if (extra.length > 0 || body === "") throw new CronError(`${f.name}: "${item}" is not valid`);
  const step = stepOf(stepText, f);
  const range = rangeOf(body, f);
  if (range === undefined) {
    if (stepText !== undefined) {
      throw new CronError(`${f.name}: "${item}": a step needs * or a range, not a single value`);
    }
    return [toInt(body, f)];
  }
  const out: number[] = [];
  for (let v = range.lo; v <= range.hi; v += step) out.push(v);
  return out;
}

function parseField(text: string, f: FieldBounds): number[] {
  const values = text.split(",").flatMap((item) => expandItem(item, f));
  const normalised = f.max === 7 ? values.map((v) => (v === 7 ? 0 : v)) : values;
  return [...new Set(normalised)].sort((a, b) => a - b);
}

/** Parses an expression; throws {@link CronError} naming the first thing wrong. */
export function parseCron(expr: string): CronSpec {
  const trimmed = expr.trim();
  if (trimmed.startsWith("@")) {
    const expanded = MACROS[trimmed];
    if (expanded === undefined) {
      throw new CronError(
        `"${trimmed}" is not supported (use @hourly, @daily, @weekly or @monthly)`,
      );
    }
    return parseCron(expanded);
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) {
    throw new CronError(
      `a schedule has five fields (minute hour day-of-month month day-of-week), got ${String(parts.length)}`,
    );
  }
  const [m = "", h = "", dom = "", mon = "", dow = ""] = parts;
  return {
    minutes: parseField(m, MINUTE),
    hours: parseField(h, HOUR),
    daysOfMonth: parseField(dom, DAY_OF_MONTH),
    months: parseField(mon, MONTH),
    daysOfWeek: parseField(dow, DAY_OF_WEEK),
    domIsStar: dom.startsWith("*"),
    dowIsStar: dow.startsWith("*"),
  };
}

// ---- time zones -------------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Whether `tz` is an IANA zone this runtime knows. */
export function isValidTimeZone(tz: string): boolean {
  if (tz === "" || tz !== tz.trim()) return false;
  try {
    formatterFor(tz);
    return true;
  } catch {
    return false;
  }
}

/** The machine's zone, as the runtime reports it. */
export function machineTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

type Wall = { y: number; mo: number; d: number; h: number; mi: number };

/** The wall-clock fields of an instant in `tz`, plus those fields read back as if they were UTC. */
function wallOf(ms: number, tz: string): { wall: Wall; asUtc: number } {
  const parts = formatterFor(tz).formatToParts(new Date(ms));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const wall: Wall = {
    y: get("year"),
    mo: get("month"),
    d: get("day"),
    h: get("hour"),
    mi: get("minute"),
  };
  const asUtc = Date.UTC(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi, get("second"));
  return { wall, asUtc };
}

function wallEquals(a: Wall, b: Wall): boolean {
  return a.y === b.y && a.mo === b.mo && a.d === b.d && a.h === b.h && a.mi === b.mi;
}

/** The earliest instant whose wall clock in `tz` reads `w`, or `undefined` when no instant does (a gap). */
function instantOf(w: Wall, tz: string): number | undefined {
  const guess = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi);
  const offsets = new Set<number>();
  for (const probe of [guess - DAY_MS, guess + DAY_MS]) {
    offsets.add(wallOf(probe, tz).asUtc - Math.floor(probe / 1000) * 1000);
  }
  let best: number | undefined;
  for (const off of offsets) {
    const t = guess - off;
    if (wallEquals(wallOf(t, tz).wall, w) && (best === undefined || t < best)) best = t;
  }
  return best;
}

// ---- search -----------------------------------------------------------------------------------

function dayMatches(spec: CronSpec, y: number, mo: number, d: number): boolean {
  if (!spec.months.includes(mo)) return false;
  const dowOk = spec.daysOfWeek.includes(new Date(Date.UTC(y, mo - 1, d)).getUTCDay());
  const domOk = spec.daysOfMonth.includes(d);
  if (!spec.domIsStar && !spec.dowIsStar) return domOk || dowOk;
  return domOk && dowOk;
}

/** Calendar-day arithmetic on wall fields (UTC math is exact for a calendar). */
function addDays(
  y: number,
  mo: number,
  d: number,
  n: number,
): { y: number; mo: number; d: number } {
  const t = new Date(Date.UTC(y, mo - 1, d + n));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** Whether a candidate (hour, minute) on the first searched day is before the search start. */
function beforeStart(h: number, mi: number, start: Wall): boolean {
  return h < start.h || (h === start.h && mi < start.mi);
}

/**
 * The first instant strictly after `afterMs` at which `spec` fires in `tz`, or `undefined` when it
 * does not fire within eight years (an impossible date such as February 30).
 */
export function nextFireOf(spec: CronSpec, tz: string, afterMs: number): number | undefined {
  const start = wallOf(Math.floor(afterMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS, tz).wall;
  for (let offset = 0; offset < SEARCH_DAYS; offset++) {
    const day = addDays(start.y, start.mo, start.d, offset);
    if (!dayMatches(spec, day.y, day.mo, day.d)) continue;
    for (const h of spec.hours) {
      for (const mi of spec.minutes) {
        if (offset === 0 && beforeStart(h, mi, start)) continue;
        const t = instantOf({ ...day, h, mi }, tz);
        if (t !== undefined && t > afterMs) return t;
      }
    }
  }
  return undefined;
}

/** Parses `expr` and returns its next fire after `afterMs` in `tz`. */
export function nextFire(expr: string, tz: string, afterMs: number): number | undefined {
  if (!isValidTimeZone(tz)) throw new CronError(`"${tz}" is not a time zone`);
  return nextFireOf(parseCron(expr), tz, afterMs);
}

/**
 * Refuses an expression that can fire twice within {@link MIN_INTERVAL_MINUTES}: the next two fires
 * from each of 48 starts spread over a year (and over the minute of the day) are compared.
 * Returns the refusal text, or `undefined` when the schedule is acceptable.
 */
export function scheduleRefusal(expr: string, tz: string): string | undefined {
  let spec: CronSpec;
  try {
    spec = parseCron(expr);
  } catch (e) {
    return e instanceof CronError ? e.message : String(e);
  }
  if (!isValidTimeZone(tz)) return `"${tz}" is not a time zone`;
  const base = Date.UTC(2026, 0, 1);
  const stride = 7 * DAY_MS + 11 * 3_600_000 + 37 * MINUTE_MS;
  let anyFire = false;
  for (let i = 0; i < SAMPLE_STARTS; i++) {
    const first = nextFireOf(spec, tz, base + i * stride);
    if (first === undefined) continue;
    anyFire = true;
    const second = nextFireOf(spec, tz, first);
    if (second !== undefined && second - first < MIN_INTERVAL_MINUTES * MINUTE_MS) {
      return `a schedule may not fire more often than every ${String(MIN_INTERVAL_MINUTES)} minutes`;
    }
  }
  return anyFire ? undefined : "this schedule never fires";
}
