// packages/gateway/src/connectors/connector-writes/google-calendar-rows.ts
// The three Google Calendar event writes of `@nimbus-dev/connectors` 0.20.0 (owner rulings
// 2026-11-27): the create and update at Wave 2, the delete at Wave 4 with a confirm text, all
// offered to the model behind a typed preview. B4a/D1 siblings of the Outlook and iCloud calendar
// rows in `mail-calendar.ts`, kept in their own module like the other 0.18.0+ rows. Spread into the
// one row table by `index.ts`.
//
// The connector lists the three only when its token holds `calendar` or `calendar.events`
// (`scope-gated.ts`); the gateway passes the scopes of Google Calendar's own credential at spawn.
//
// Notifications. Every write takes `sendUpdates` (`none`, the connector's default, `externalOnly`,
// `all`), which the connector always sends, so Google's own default never applies. Google
// documents `none` as a request, not a guarantee (some emails may still be sent, and guests on
// other calendar systems may not see the change); each preview says so on its own line.
//
// Bounds, stated (the Outlook rows' precedent, owner ruling): the title, description and location
// are not scanned for broadcast mentions (a calendar has no whole-group mention; every guest is
// listed verbatim) nor for remote content (no calendar body is: see `REMOTE_CONTENT_SCANNED`).
// Times need no zone refusal, unlike Outlook's: the connector accepts a `dateTime` only with its
// UTC offset, so the instant shown is the instant written. Guests are not bounded beyond the
// connector's 100, and a display name or look-alike domain is shown, not resolved. Recurrence
// lines are not free text (the connector accepts only RRULE, EXRULE, RDATE and EXDATE lines with
// no control character), so no nested-text scan applies.
import {
  arrayAt,
  type BeforeInput,
  beforeReplyJson,
  excerptHead,
  nonEmptyString,
  presentFields,
  requiredStringAt,
  shownHead,
  stringAt,
} from "./before-select.ts";
import {
  type BeforeStateField,
  type BeforeStateGuard,
  type ConnectorWriteRow,
  type PreviewFieldTemplate,
  row,
  textField,
  withBefore,
  withConfirm,
  withPreview,
} from "./types.ts";

/** The notification line every row shows: what each `sendUpdates` value asks Google to do. */
function sendUpdatesField(about: string): PreviewFieldTemplate {
  return textField(
    "sendUpdates",
    `Who Google emails about ${about} (sendUpdates: "none" asks it to email no guest, though Google may still send some; "externalOnly" emails only guests not on Google Calendar; "all" emails every guest)`,
    '(not set: "none", Google is asked to email no guest, though it may still send some)',
  );
}

const CALENDAR_FIELD = textField(
  "calendarId",
  "Calendar",
  "(not set: primary, your main calendar)",
);

/** `Start`/`End` of a Google event: `dateTime (timeZone)`, or `date (all day)`. */
function googleTime(j: unknown, key: string): string | undefined {
  const at = stringAt(j, [key, "dateTime"]);
  if (at !== undefined) {
    const zone = stringAt(j, [key, "timeZone"]);
    return zone === undefined ? at : `${at} (${zone})`;
  }
  const date = stringAt(j, [key, "date"]);
  return date === undefined ? undefined : `${date} (all day)`;
}

/**
 * Whether the event is recurring, in the words of what the write does to it: a series (it holds a
 * `recurrence`) is acted on as a whole; an instance (it names its `recurringEventId`) alone.
 */
function recurringLine(j: unknown, verb: string): string {
  const rules = arrayAt(j, ["recurrence"]);
  if (rules !== undefined && rules.length > 0) {
    return `yes: this is a recurring SERIES, so this ${verb} EVERY occurrence`;
  }
  const series = stringAt(j, ["recurringEventId"]);
  if (series !== undefined) {
    return excerptHead(
      `one occurrence of a recurring series (${series}): this ${verb} only this occurrence`,
    );
  }
  return "no";
}

/** The guest count (never the addresses: the ruling names the count). */
function guestCount(j: unknown): string {
  const attendees = arrayAt(j, ["attendees"]);
  if (attendees === undefined || attendees.length === 0) return "(none)";
  return String(attendees.length);
}

/**
 * Google Calendar `gcal_event_get` (before-state): the event's title, start and end, status,
 * guest count and whether it is recurring, never its description (the comment-row rule). `verb`
 * names what the write does to a series. A reply without an `id` is not an event and throws.
 */
function selectGoogleEvent(reply: unknown, verb: string): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  requiredStringAt(j, ["id"]);
  return [
    { label: "Title", value: excerptHead(stringAt(j, ["summary"]) ?? "(no title)") },
    ...presentFields([
      ["Start", shownHead(googleTime(j, "start"))],
      ["End", shownHead(googleTime(j, "end"))],
      ["Status", shownHead(stringAt(j, ["status"]))],
    ]),
    { label: "Guests", value: guestCount(j) },
    { label: "Recurring", value: recurringLine(j, verb) },
  ];
}

/** The before-state of an update: what it is about to change. */
export function selectGoogleEventUpdate(reply: unknown): readonly BeforeStateField[] {
  return selectGoogleEvent(reply, "change applies to");
}

/** The before-state of a delete: what is about to disappear. */
export function selectGoogleEventDelete(reply: unknown): readonly BeforeStateField[] {
  return selectGoogleEvent(reply, "delete removes");
}

/** `gcal_event_get` takes the write's own calendar (primary when unset) and event id. */
export function googleEventReadArgs(input: BeforeInput): Record<string, unknown> | undefined {
  const eventId = nonEmptyString(input["eventId"]);
  if (eventId === undefined) return undefined;
  const calendarId = nonEmptyString(input["calendarId"]);
  return calendarId === undefined ? { eventId } : { calendarId, eventId };
}

/** The keys an update can change; at least one must be set. */
const UPDATE_KEYS = [
  "summary",
  "description",
  "location",
  "start",
  "end",
  "attendees",
  "recurrence",
] as const;

const isUnset = (v: unknown): boolean => v === undefined || v === null;

/**
 * An update that changes nothing, or moves one end without the other, is refused before the
 * prompt (the `github_pr_update` empty-update guard, widened by the connector's own rule that
 * `start` and `end` go together). The connector refuses both too, after approval.
 */
export const GCAL_UPDATE_GUARD: BeforeStateGuard = {
  reason:
    "set at least one of summary, description, location, start and end, attendees, recurrence; start and end are set together",
  appliesTo: (picked) =>
    UPDATE_KEYS.every((k) => isUnset(picked[k])) ||
    isUnset(picked["start"]) !== isUnset(picked["end"]),
  allows: () => false,
};

const EVENT_ID_EFFECT =
  "a recurring series' id acts on EVERY occurrence; an instance id, as gcal_event_list returns, on that one occurrence";

export const GOOGLE_CALENDAR_ROWS: readonly ConnectorWriteRow[] = [
  // Wave 2 like the Outlook and iCloud creates; no before-state (nothing exists yet). Owner ruling:
  // reversible by `gcal_event_delete` of the id it returns, which the reversibility table cannot
  // carry (an inverse there is built from a before-read, and the new id exists only in the
  // result), so the row stays `unknown` rather than claim a class the table cannot prove.
  withPreview(row("gcal_event_create", "google_calendar.event.create", "mesh", 2), {
    target: "{summary}",
    summary:
      "Create a Google Calendar event; whether Google emails the guests is the Notifications line",
    fields: [
      CALENDAR_FIELD,
      textField("summary", "Title"),
      textField(
        "start",
        "Start ({dateTime with its UTC offset, timeZone} for a timed event, {date} for all day)",
      ),
      textField("end", "End (an all-day end date is exclusive: the event ends the day before it)"),
      textField(
        "attendees",
        "Guests (each is added to the event, as written here)",
        "(not set: no guests)",
      ),
      textField(
        "recurrence",
        "Repeats (iCalendar RRULE, EXRULE, RDATE and EXDATE lines)",
        "(not set: a single event, not recurring)",
      ),
      textField("location", "Location", "(not set: none)"),
      textField("description", "Description", "(not set: none)"),
      sendUpdatesField("the new event"),
    ],
  }),
  // Wave 2, irreversible (owner ruling): the before-state shows what the change overwrites.
  withBefore(
    withPreview(row("gcal_event_update", "google_calendar.event.update", "mesh", 2), {
      target: "{eventId}",
      summary:
        "Change Google Calendar event {eventId}: only the fields set below change; Nimbus cannot undo it",
      fields: [
        textField("eventId", `Event id (${EVENT_ID_EFFECT})`),
        CALENDAR_FIELD,
        textField("summary", "New title", "(not set: unchanged)"),
        textField("start", "New start", "(not set: unchanged)"),
        textField("end", "New end", "(not set: unchanged)"),
        textField(
          "attendees",
          "New guest list (REPLACES the whole list: every guest not named here is removed, and [] removes every guest)",
          "(not set: the guest list is unchanged)",
        ),
        textField(
          "recurrence",
          "New recurrence (replaces the event's recurrence lines)",
          "(not set: unchanged)",
        ),
        textField("location", "New location", "(not set: unchanged)"),
        textField(
          "description",
          "New description (replaces the whole description, which is not shown)",
          "(not set: unchanged)",
        ),
        sendUpdatesField("the change"),
      ],
    }),
    {
      tool: "gcal_event_get",
      // The update keys are declared for the guard, never sent to the read.
      argKeys: ["calendarId", "eventId", ...UPDATE_KEYS],
      args: googleEventReadArgs,
      select: selectGoogleEventUpdate,
      guard: GCAL_UPDATE_GUARD,
    },
  ),
  // Wave 4 (OR-W34-3: calendar deletes are irreversible): typed confirm and the event beside it.
  withConfirm(
    withBefore(
      withPreview(row("gcal_event_delete", "google_calendar.event.delete", "mesh", 4), {
        target: "{eventId}",
        summary: "Delete Google Calendar event {eventId}; Nimbus cannot undo it",
        fields: [
          textField("eventId", `Event id (${EVENT_ID_EFFECT})`),
          CALENDAR_FIELD,
          sendUpdatesField("the cancellation"),
        ],
      }),
      {
        tool: "gcal_event_get",
        argKeys: ["calendarId", "eventId"],
        args: googleEventReadArgs,
        select: selectGoogleEventDelete,
      },
    ),
    { template: "delete {eventId:tail8}" },
  ),
];
