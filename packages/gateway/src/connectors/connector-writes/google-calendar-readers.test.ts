// The Google Calendar writes (`@nimbus-dev/connectors` 0.20.0), continued from
// `google-calendar-rows.test.ts` (new files stay under 500 lines): the update and delete
// before-state reader (`gcal_event_get`), the update guard, and the scope gate.
import { describe, expect, test } from "bun:test";

import { beforeReaderProblems } from "./before-reader.ts";
import {
  GCAL_UPDATE_GUARD,
  googleEventReadArgs,
  selectGoogleEventDelete,
  selectGoogleEventUpdate,
} from "./google-calendar-rows.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import { SCOPE_GATED_WRITES, scopeGatedReason } from "./scope-gated.ts";
import type { ConnectorWriteRow } from "./types.ts";

const CREATE = "gcal_event_create";
const UPDATE = "gcal_event_update";
const DELETE = "gcal_event_delete";
const IDS = [CREATE, UPDATE, DELETE] as const;

function rowOf(id: string): ConnectorWriteRow {
  const r = CONNECTOR_WRITE_ROWS.find((x) => x.toolId === id);
  if (r === undefined) throw new Error(`no row ${id}`);
  return r;
}

const TIMED = {
  start: { dateTime: "2026-12-01T09:00:00+01:00", timeZone: "Europe/Berlin" },
  end: { dateTime: "2026-12-01T09:15:00+01:00", timeZone: "Europe/Berlin" },
};

describe("Google Calendar writes: the before-state reader (gcal_event_get)", () => {
  const mcp = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
  const EVENT = {
    id: "abc123def456",
    status: "confirmed",
    summary: "Standup",
    description: "DESCRIPTION-MUST-NOT-SHOW",
    start: { dateTime: "2026-12-01T09:00:00+01:00", timeZone: "Europe/Berlin" },
    end: { dateTime: "2026-12-01T09:15:00+01:00", timeZone: "Europe/Berlin" },
    attendees: [{ email: "a@example.com" }, { email: "b@example.org" }],
  };

  test("the create reads nothing; the update and delete read gcal_event_get, and every reader passes", () => {
    expect(rowOf(CREATE).before).toBeUndefined();
    for (const id of [UPDATE, DELETE]) {
      const r = rowOf(id);
      expect(beforeReaderProblems(r), id).toEqual([]);
      expect(r.before?.tool, id).toBe("gcal_event_get");
      expect(r.before?.args, id).toBe(googleEventReadArgs);
    }
    expect(rowOf(UPDATE).before?.select).toBe(selectGoogleEventUpdate);
    expect(rowOf(DELETE).before?.select).toBe(selectGoogleEventDelete);
    expect(rowOf(UPDATE).before?.guard).toBe(GCAL_UPDATE_GUARD);
    expect(rowOf(DELETE).before?.guard).toBeUndefined();
  });

  test("the read takes the write's calendar and event id only; no event id, no read", () => {
    expect(googleEventReadArgs({ eventId: "e" })).toEqual({ eventId: "e" });
    expect(googleEventReadArgs({ eventId: "e", calendarId: "c" })).toEqual({
      calendarId: "c",
      eventId: "e",
    });
    expect(googleEventReadArgs({ eventId: "e", calendarId: "" })).toEqual({ eventId: "e" });
    expect(googleEventReadArgs({ eventId: "" })).toBeUndefined();
    expect(googleEventReadArgs({ eventId: 7 })).toBeUndefined();
    expect(googleEventReadArgs({})).toBeUndefined();
  });

  test("shows title, start and end, status, guest count and not recurring; never the description", () => {
    const fields = selectGoogleEventDelete(mcp(EVENT));
    expect(fields).toEqual([
      { label: "Title", value: "Standup" },
      { label: "Start", value: "2026-12-01T09:00:00+01:00 (Europe/Berlin)" },
      { label: "End", value: "2026-12-01T09:15:00+01:00 (Europe/Berlin)" },
      { label: "Status", value: "confirmed" },
      { label: "Guests", value: "2" },
      { label: "Recurring", value: "no" },
    ]);
    expect(JSON.stringify(fields)).not.toContain("DESCRIPTION-MUST-NOT-SHOW");
    expect(JSON.stringify(fields)).not.toContain("a@example.com");
  });

  test("a series says the write acts on every occurrence; an instance says only that one", () => {
    const series = { ...EVENT, recurrence: ["RRULE:FREQ=WEEKLY"] };
    const recurring = (f: readonly { label: string; value: string }[]) =>
      f.find((x) => x.label === "Recurring")?.value;
    expect(recurring(selectGoogleEventDelete(mcp(series)))).toBe(
      "yes: this is a recurring SERIES, so this delete removes EVERY occurrence",
    );
    expect(recurring(selectGoogleEventUpdate(mcp(series)))).toBe(
      "yes: this is a recurring SERIES, so this change applies to EVERY occurrence",
    );
    const instance = { ...EVENT, id: "abc_20261201T080000Z", recurringEventId: "abc" };
    expect(recurring(selectGoogleEventDelete(mcp(instance)))).toBe(
      "one occurrence of a recurring series (abc): this delete removes only this occurrence",
    );
    // An empty recurrence list is not a series.
    expect(recurring(selectGoogleEventUpdate(mcp({ ...EVENT, recurrence: [] })))).toBe("no");
  });

  test("an all-day event, no guests and no title read plainly; absent times are omitted", () => {
    const fields = selectGoogleEventUpdate(
      mcp({ id: "e", start: { date: "2026-12-01" }, end: { date: "2026-12-02" }, attendees: [] }),
    );
    expect(fields).toEqual([
      { label: "Title", value: "(no title)" },
      { label: "Start", value: "2026-12-01 (all day)" },
      { label: "End", value: "2026-12-02 (all day)" },
      { label: "Guests", value: "(none)" },
      { label: "Recurring", value: "no" },
    ]);
    expect(selectGoogleEventUpdate(mcp({ id: "e", start: { dateTime: "t" } }))).toEqual([
      { label: "Title", value: "(no title)" },
      { label: "Start", value: "t" },
      { label: "Guests", value: "(none)" },
      { label: "Recurring", value: "no" },
    ]);
  });

  test("a reply without an id is not an event: it throws, so the prompt reads unavailable", () => {
    expect(() => selectGoogleEventDelete(mcp({ summary: "x" }))).toThrow();
    expect(() => selectGoogleEventUpdate("nope")).toThrow();
  });
});

describe("gcal_event_update: the guard refuses an update that sets nothing, or one end alone", () => {
  const applies = (picked: Record<string, unknown>) =>
    GCAL_UPDATE_GUARD.appliesTo(picked, undefined);

  test("nothing to change, or only nulls: refused", () => {
    expect(applies({ eventId: "e" })).toBe(true);
    expect(applies({ eventId: "e", summary: null, sendUpdates: "all" })).toBe(true);
  });

  test("start without end, or end without start: refused", () => {
    expect(applies({ eventId: "e", start: TIMED.start })).toBe(true);
    expect(applies({ eventId: "e", summary: "x", end: TIMED.end })).toBe(true);
  });

  test("any one field, or start and end together: allowed through to the prompt", () => {
    for (const key of ["summary", "description", "location", "attendees", "recurrence"]) {
      expect(applies({ eventId: "e", [key]: key === "attendees" ? [] : "x" }), key).toBe(false);
    }
    expect(applies({ eventId: "e", ...TIMED })).toBe(false);
  });

  test("a refused update never passes: allows is false, and the reason is fixed text", () => {
    expect(GCAL_UPDATE_GUARD.allows({}, {}, undefined, undefined)).toBe(false);
    expect(GCAL_UPDATE_GUARD.reason).toBe(
      "set at least one of summary, description, location, start and end, attendees, recurrence; start and end are set together",
    );
    // The reader declares every key the guard reads.
    expect(rowOf(UPDATE).before?.argKeys).toEqual([
      "calendarId",
      "eventId",
      "summary",
      "description",
      "location",
      "start",
      "end",
      "attendees",
      "recurrence",
    ]);
  });
});

describe("Google Calendar writes: the scope gate (re-consent for existing connections)", () => {
  const CALENDAR = "https://www.googleapis.com/auth/calendar";
  const EVENTS = "https://www.googleapis.com/auth/calendar.events";
  const READONLY = "https://www.googleapis.com/auth/calendar.readonly";
  const REASON = "re-authorise Google Calendar to grant calendar";

  test("each write is gated on Google Calendar's own credential", () => {
    for (const id of IDS) expect(SCOPE_GATED_WRITES[id]?.service, id).toBe("google_calendar");
  });

  test("calendar or calendar.events lifts the gate; read-only, none or Gmail's do not", () => {
    for (const id of IDS) {
      expect(
        scopeGatedReason(id, { google_calendar: `${READONLY} ${CALENDAR}` }),
        id,
      ).toBeUndefined();
      expect(scopeGatedReason(id, { google_calendar: EVENTS }), id).toBeUndefined();
      for (const google_calendar of [undefined, "", READONLY]) {
        expect(scopeGatedReason(id, { google_calendar }), id).toBe(REASON);
      }
      // Another service's scopes are not Calendar's: the gmail key makes no claim for it.
      expect(scopeGatedReason(id, { gmail: CALENDAR }), id).toBeUndefined();
    }
  });
});
