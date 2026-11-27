// packages/gateway/src/connectors/connector-writes/calendar-refusals.ts
// The calendar event-create refusals (B4a), moved out of `model-write-refusals.ts` unchanged, since
// that file's size is locked by `audit:file-size`. `messagingDestinationRefusal` there runs
// `calendarRefusal` last, after the null-optional check, and re-exports the public names.

function ownLookup<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

// ---------------------------------------------------------------------------------------------
// Calendar event creates (B4a, plan R6 and review fix 1; owner ruling OR-B4-6): fail closed on what
// the preview cannot show honestly. Both doors (it runs inside `messagingDestinationRefusal`).
//
//  - Times. An Outlook `startDateTime` / `endDateTime` must be a string `YYYY-MM-DDTHH:MM[:SS[.f]]`
//    (at most 7 fraction digits) with NO offset and no `Z`, so the preview's `Time zone` line (the
//    `timeZone` input, "UTC" when unset) is the only zone and is the one Graph applies. An iCloud
//    `start` / `end` must be `YYYYMMDDTHHMMSSZ` (UTC): the connector emits `DTSTART`/`DTEND`
//    verbatim, a floating time is each attendee's own local time (no one zone to show), and 0.4.0
//    emits a date-only value without `VALUE=DATE` (malformed iCalendar). So all-day and floating
//    iCloud events cannot be created by the model or over MCP (stated). The patterns are ASCII
//    only (`\d` without the `u` flag matches 0-9 alone; fullwidth digits are refused) and anchored
//    without the `m` flag, so no line break or control character passes.
//  - iCloud text. The connector emits `UID` verbatim and its `escapeText` leaves a bare CR, so a
//    `summary`, `description`, `location`, `calendar` or `uid` carrying a C0 control (CR, LF and
//    TAB included), DEL or a C1 control could add an `ATTENDEE:` line the owner reads as part of a
//    field (a hidden invitee): refused. `uid` must also match `^[A-Za-z0-9._@-]{1,200}$`. Each
//    `attendees` entry (one `ATTENDEE:mailto:` line each) is refused when it is not a string, is
//    empty, or holds any whitespace or such a control; a present `attendees` that is not an array
//    is refused. A present key with a non-string value (`null` included: it is a change, not
//    "unset") is refused. These checks REJECT; nothing is stripped or rewritten.
//  - Attendee count and outside domains: not bounded (owner ruling OR-B4-2); every attendee is
//    shown in full. A non-control character such as U+202E reaches the prompt escaped by the
//    preview's sanitiser.
// Order: the time checks first, then the text checks. Both texts are fixed and echo nothing.
// ---------------------------------------------------------------------------------------------

export const CALENDAR_TIME_REFUSAL =
  "the model must give an event time in the stated form so its time zone is shown: Outlook YYYY-MM-DDTHH:MM[:SS] with timeZone, iCloud YYYYMMDDTHHMMSSZ (UTC)";
export const CALENDAR_TEXT_REFUSAL =
  "an iCloud event's title, description, location, calendar, id or attendees cannot contain a line break or control character, and an attendee cannot contain a space";

const OUTLOOK_CALENDAR_ROW = "outlook_calendar_create";
const APPLE_CALENDAR_ROW = "apple_calendar_event_create";

// The shapes capture year, month, day, hour, minute and (optional for Outlook) second, so the
// value is also checked to be a real calendar date and clock time (`isRealDateTime`).
const OUTLOOK_EVENT_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,7})?)?$/;
const APPLE_EVENT_TIME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

/**
 * Whether the captured parts name a real date and time: month 1-12, a day that exists in that
 * month and year (leap years included), hour 0-23, minute and second 0-59. The date is built with
 * `setUTCFullYear`, never `Date.UTC`, which maps years 0-99 to 1900-1999.
 */
function isRealDateTime(m: RegExpExecArray): boolean {
  // An absent group (Outlook's optional seconds) reads as 0.
  const part = (i: number): number => Number(m[i] ?? "0");
  if (part(4) > 23 || part(5) > 59 || part(6) > 59) return false;
  const [y, mo, d] = [part(1), part(2), part(3)];
  // A month outside 1-12 or a day the month does not have rolls over to another date, so the
  // round trip below refuses it.
  const date = new Date(0);
  date.setUTCFullYear(y, mo - 1, d);
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

const APPLE_UID = /^[A-Za-z0-9._@-]{1,200}$/;

/** The time keys of each calendar row and the one form each must take. */
const CALENDAR_TIME_KEYS: Readonly<Record<string, { keys: readonly string[]; form: RegExp }>> = {
  [OUTLOOK_CALENDAR_ROW]: { keys: ["startDateTime", "endDateTime"], form: OUTLOOK_EVENT_TIME },
  [APPLE_CALENDAR_ROW]: { keys: ["start", "end"], form: APPLE_EVENT_TIME },
};

/** The iCloud text keys whose value is emitted into the VEVENT. */
const APPLE_CALENDAR_TEXT_KEYS: readonly string[] = [
  "summary",
  "description",
  "location",
  "calendar",
  "uid",
];

/**
 * Whether `value`, as the calendar row `toolId`'s time key `key`, is in the one form that shows
 * its zone (a string matching that row's pattern) and names a real date and time. `false` for a
 * key that is not a time key of a calendar row, so a caller can never read "explicit" for an
 * unknown input.
 */
export function calendarTimeIsExplicit(toolId: string, key: string, value: unknown): boolean {
  const spec = ownLookup(CALENDAR_TIME_KEYS, toolId);
  if (!spec?.keys.includes(key)) return false;
  if (typeof value !== "string") return false;
  const m = spec.form.exec(value);
  return m !== null && isRealDateTime(m);
}

/** A C0 control (U+0000-U+001F, so CR, LF and TAB too), DEL or a C1 control (U+0080-U+009F). */
function hasControl(s: string): boolean {
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) return true;
  }
  return false;
}

/** One iCloud attendee entry: a non-empty string with no whitespace and no control character. */
function appleAttendeeRefused(entry: unknown): boolean {
  return typeof entry !== "string" || entry === "" || /\s/.test(entry) || hasControl(entry);
}

/** The iCloud text and attendee checks: `true` refuses. */
function appleCalendarTextRefused(input: Readonly<Record<string, unknown>>): boolean {
  const own = (k: string): unknown => (Object.hasOwn(input, k) ? input[k] : undefined);
  for (const k of APPLE_CALENDAR_TEXT_KEYS) {
    const v = own(k);
    if (v === undefined) continue;
    if (typeof v !== "string" || hasControl(v)) return true;
    if (k === "uid" && !APPLE_UID.test(v)) return true;
  }
  const attendees = own("attendees");
  if (attendees === undefined) return false;
  if (!Array.isArray(attendees)) return true;
  return (attendees as unknown[]).some(appleAttendeeRefused);
}

/** R6: the calendar refusal for one row (`undefined` for every other row, or when allowed). */
export function calendarRefusal(
  toolId: string,
  input: Readonly<Record<string, unknown>>,
): string | undefined {
  const spec = ownLookup(CALENDAR_TIME_KEYS, toolId);
  if (spec === undefined) return undefined;
  const timesShown = spec.keys.every((k) =>
    calendarTimeIsExplicit(toolId, k, Object.hasOwn(input, k) ? input[k] : undefined),
  );
  if (!timesShown) return CALENDAR_TIME_REFUSAL;
  if (toolId === APPLE_CALENDAR_ROW && appleCalendarTextRefused(input)) {
    return CALENDAR_TEXT_REFUSAL;
  }
  return undefined;
}
