// packages/gateway/src/standing/standing-rule-text.ts
// Limits, the weekday/time-of-day window and the exact text the owner approves (Phase 10 SA3,
// OR-10-5 / OR-10-6, spec § 5.2). Pure: no I/O, no clock of its own (callers pass `now`).
import { sanitisePreviewText } from "../connectors/connector-writes/preview.ts";
import type { ScopeEntry, StandingScope, StandingWindow } from "./standing-rule-types.ts";
import {
  DAY_MS,
  STANDING_DEFAULT_DAYS,
  STANDING_DEFAULT_MAX_ACTIONS,
  STANDING_MAX_ACTIONS,
  STANDING_MAX_DAYS,
} from "./standing-rule-types.ts";

/** A refusal with a fixed, owner-readable message. */
export class StandingRuleError extends Error {}

function refuse(message: string): never {
  throw new StandingRuleError(message);
}

/** OR-10-6: days until expiry. Absent = 30; otherwise an integer from 1 to 90. */
export function parseDays(raw: unknown): number {
  if (raw === undefined) return STANDING_DEFAULT_DAYS;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > STANDING_MAX_DAYS) {
    refuse(`days must be a whole number from 1 to ${String(STANDING_MAX_DAYS)}`);
  }
  return raw;
}

/** OR-10-6: the action ceiling. Absent = 100; otherwise an integer from 1 to 500. */
export function parseMaxActions(raw: unknown): number {
  if (raw === undefined) return STANDING_DEFAULT_MAX_ACTIONS;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > STANDING_MAX_ACTIONS) {
    refuse(`max must be a whole number from 1 to ${String(STANDING_MAX_ACTIONS)}`);
  }
  return raw;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function minutesOf(hhmm: string): number {
  const m = HHMM.exec(hhmm);
  if (m === null) return -1;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Whether `tz` is an IANA zone id this runtime knows. */
export function isKnownTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * OR-10-5: validates a caller's window. Days are ISO weekdays 1..7, non-empty and unique; `from`
 * and `to` are `HH:MM` with `from` strictly before `to` (a window never crosses midnight); `tz` is
 * an IANA zone. Any unknown key is refused.
 */
export function parseWindow(raw: unknown): StandingWindow | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    refuse("window must be an object with days, from, to and tz");
  }
  const rec = raw as Record<string, unknown>;
  for (const k of Object.keys(rec)) {
    if (k !== "days" && k !== "from" && k !== "to" && k !== "tz") {
      refuse(`window: unknown key "${k}"`);
    }
  }
  const days = rec["days"];
  if (!Array.isArray(days) || days.length === 0 || days.length > 7) {
    refuse("window.days must list 1 to 7 weekdays (1 = Monday ... 7 = Sunday)");
  }
  const seen = new Set<number>();
  for (const d of days as unknown[]) {
    if (typeof d !== "number" || !Number.isInteger(d) || d < 1 || d > 7 || seen.has(d)) {
      refuse("window.days must be unique whole numbers from 1 (Monday) to 7 (Sunday)");
    }
    seen.add(d);
  }
  const from = rec["from"];
  const to = rec["to"];
  if (typeof from !== "string" || typeof to !== "string" || !HHMM.test(from) || !HHMM.test(to)) {
    refuse("window.from and window.to must be HH:MM (24-hour)");
  }
  if (minutesOf(from) >= minutesOf(to)) {
    refuse("window.from must be earlier than window.to (a window cannot cross midnight)");
  }
  const tz = rec["tz"];
  if (typeof tz !== "string" || tz === "" || !isKnownTimeZone(tz)) {
    refuse("window.tz must be an IANA time zone such as Europe/Berlin");
  }
  return { days: [...seen].sort((a, b) => a - b), from, to, tz };
}

const WEEKDAY_ISO: Readonly<Record<string, number>> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

/** The ISO weekday (1..7) and minutes since local midnight of `now` in `tz`. */
export function localTimeIn(tz: string, now: number): { weekday: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(now));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = WEEKDAY_ISO[get("weekday")] ?? 0;
  return { weekday, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

/** Whether `now` falls inside `window` (day listed, `from` <= local time < `to`). */
export function isInsideWindow(window: StandingWindow, now: number): boolean {
  let local: { weekday: number; minutes: number };
  try {
    local = localTimeIn(window.tz, now);
  } catch {
    return false;
  }
  return (
    window.days.includes(local.weekday) &&
    local.minutes >= minutesOf(window.from) &&
    local.minutes < minutesOf(window.to)
  );
}

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** `Mon-Fri 06:00-10:00 Europe/Berlin` (a run of days becomes a range). */
export function windowLabel(w: StandingWindow): string {
  const runs: string[] = [];
  let i = 0;
  while (i < w.days.length) {
    let j = i;
    while (j + 1 < w.days.length && (w.days[j + 1] as number) === (w.days[j] as number) + 1) j++;
    const a = DAY_NAMES[(w.days[i] as number) - 1] ?? "?";
    const b = DAY_NAMES[(w.days[j] as number) - 1] ?? "?";
    runs.push(j - i >= 1 ? `${a}-${b}` : a);
    i = j + 1;
  }
  return `${runs.join(",")} ${w.from}-${w.to} ${w.tz}`;
}

/**
 * The CLI's window spelling: `Mon-Fri 06:00-10:00 Europe/Berlin`, `Sat,Sun 09:00-12:00 UTC`.
 * Returns the structured window the gateway validates again (`parseWindow`).
 */
export function parseWindowSpec(spec: string): StandingWindow {
  const m = /^(\S+)\s+(\d{2}:\d{2})-(\d{2}:\d{2})\s+(\S+)$/.exec(spec.trim());
  if (m === null) {
    return refuse('window must look like "Mon-Fri 06:00-10:00 Europe/Berlin"');
  }
  const [, dayPart, from, to, tz] = m as unknown as [string, string, string, string, string];
  const days = new Set<number>();
  for (const piece of dayPart.split(",")) {
    const range = piece.split("-");
    const a = DAY_NAMES.findIndex((d) => d.toLowerCase() === (range[0] ?? "").toLowerCase());
    const b =
      range.length === 1
        ? a
        : DAY_NAMES.findIndex((d) => d.toLowerCase() === (range[1] ?? "").toLowerCase());
    if (a === -1 || b === -1 || range.length > 2 || b < a) {
      return refuse(`window: "${piece}" is not a weekday or a range such as Mon-Fri`);
    }
    for (let d = a; d <= b; d++) days.add(d + 1);
  }
  const parsed = parseWindow({ days: [...days], from, to, tz });
  return parsed as StandingWindow;
}

/** One scope entry as the approval text shows it. */
function scopeLine(field: string, entry: ScopeEntry): string {
  const name = sanitisePreviewText(field);
  if ("const" in entry) {
    return `  ${name}: the constant ${sanitisePreviewText(JSON.stringify(entry.const))}`;
  }
  return `  ${name}: each value of column ${sanitisePreviewText(entry.column)} that query step ${String(entry.query + 1)} selects`;
}

export type RuleTextInput = {
  readonly workflowName: string;
  readonly workflowSha256: string;
  readonly stepIndex: number;
  readonly stepLabel: string;
  readonly toolId: string;
  readonly actionType: string;
  readonly scope: StandingScope;
  readonly window: StandingWindow | undefined;
  readonly expiresAt: number;
  readonly maxActions: number;
  /** Set on a resume: the actions already used. */
  readonly actionsUsed?: number;
};

/**
 * The exact text of a rule: what the owner reads and approves. Every value that came from a stored
 * workflow (its name, labels, constants) is passed through `sanitisePreviewText`, so no stored
 * text can forge a line or move the cursor.
 */
export function renderRuleText(r: RuleTextInput, now: number): string[] {
  const lines = [
    `Workflow: ${sanitisePreviewText(r.workflowName)} (content ${r.workflowSha256.slice(0, 12)})`,
    `Step ${String(r.stepIndex + 1)}: ${sanitisePreviewText(r.stepLabel)}`,
    `Write: ${sanitisePreviewText(r.toolId)} (${sanitisePreviewText(r.actionType)})`,
    "Inputs:",
    ...Object.keys(r.scope)
      .sort()
      .map((f) => scopeLine(f, r.scope[f] as ScopeEntry)),
    `When: ${r.window === undefined ? "any time" : windowLabel(r.window)}`,
    `Expires: ${new Date(r.expiresAt).toISOString()} (${String(Math.max(1, Math.round((r.expiresAt - now) / DAY_MS)))} days from now)`,
    `Ceiling: ${String(r.maxActions)} actions${r.actionsUsed === undefined ? "" : ` (${String(r.actionsUsed)} used)`}`,
    "",
    "While this rule is live, each matching write runs WITHOUT asking you, and only when this exact",
    "workflow (unchanged) is started by you. A run started by anything else, an edited workflow, a",
    "different value or a model-proposed write still asks. Revoke it any time: nimbus approve revoke.",
    "Runs that nobody is watching (a schedule) are not part of this rule yet.",
  ];
  return lines;
}
