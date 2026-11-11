import { describe, expect, test } from "bun:test";

import { GOOGLE_CALENDAR_EVENT_META_VERSION } from "./calendar-event-meta.ts";
import {
  googleCalendarExternalId,
  isCancelledGoogleEvent,
  mapGoogleCalendarEvent,
} from "./google-calendar-event-mapping.ts";

const CTX = {
  calendarId: "primary@x.com",
  calendarName: "Work",
  zone: "Europe/London",
  syncedAt: 5,
};

function timed(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "evt1",
    iCalUID: "evt1@google.com",
    status: "confirmed",
    summary: "Planning",
    description: "Agenda\r\n\r\n\r\nitems",
    location: "Room 1",
    start: { dateTime: "2026-11-12T09:30:00+01:00" },
    end: { dateTime: "2026-11-12T10:30:00+01:00" },
    organizer: { email: "Boss@Example.com" },
    attendees: [
      { email: "a@x.com", responseStatus: "accepted" },
      { email: "me@x.com", self: true, responseStatus: "needsAction" },
    ],
    updated: "2026-11-10T08:00:00.000Z",
    htmlLink: "https://calendar.google.com/event?eid=1",
    ...over,
  };
}

describe("mapGoogleCalendarEvent", () => {
  test("a timed event: exact epochs, the seven keys, the row shape", () => {
    const row = mapGoogleCalendarEvent(timed(), CTX);
    expect(row).not.toBeNull();
    expect(row?.service).toBe("google_calendar");
    expect(row?.type).toBe("event");
    expect(row?.externalId).toBe("primary@x.com|evt1");
    expect(row?.title).toBe("Planning");
    expect(row?.bodyPreview).toBe("Agenda\nitems");
    expect(row?.url).toBe("https://calendar.google.com/event?eid=1");
    expect(row?.modifiedAt).toBe(Date.parse("2026-11-10T08:00:00.000Z"));
    expect(row?.syncedAt).toBe(5);
    expect(row).not.toHaveProperty("body");
    const m = row?.metadata ?? {};
    expect(m["start_ms"]).toBe(Date.UTC(2026, 10, 12, 8, 30));
    expect(m["end_ms"]).toBe(Date.UTC(2026, 10, 12, 9, 30));
    expect(m["all_day"]).toBe(false);
    expect(m["status"]).toBe("confirmed");
    expect(m["self_response"]).toBe("needs-action");
    expect(m["organizer_email"]).toBe("boss@example.com");
    expect(m["attendee_count"]).toBe(2);
    expect(m["calendar_id"]).toBe("primary@x.com");
    expect(m["calendar_name"]).toBe("Work");
    expect(m["ical_uid"]).toBe("evt1@google.com");
    expect(m["location"]).toBe("Room 1");
    expect(m["meta_v"]).toBe(GOOGLE_CALENDAR_EVENT_META_VERSION);
  });

  test("an all-day event is midnight in the gateway zone, exclusive end; a multi-day one spans", () => {
    const one = mapGoogleCalendarEvent(
      timed({ start: { date: "2026-11-12" }, end: { date: "2026-11-13" } }),
      CTX,
    );
    expect(one?.metadata["all_day"]).toBe(true);
    expect(one?.metadata["start_ms"]).toBe(Date.UTC(2026, 10, 12));
    expect(one?.metadata["end_ms"]).toBe(Date.UTC(2026, 10, 13));
    const auckland = mapGoogleCalendarEvent(
      timed({ start: { date: "2026-11-12" }, end: { date: "2026-11-15" } }),
      { ...CTX, zone: "Pacific/Auckland" },
    );
    expect(auckland?.metadata["start_ms"]).toBe(Date.UTC(2026, 10, 11, 11));
    expect(auckland?.metadata["end_ms"]).toBe(Date.UTC(2026, 10, 14, 11));
  });

  test("an all-day event with no end date lasts one day", () => {
    const r = mapGoogleCalendarEvent(timed({ start: { date: "2026-11-12" }, end: undefined }), CTX);
    expect(r?.metadata["end_ms"]).toBe(Date.UTC(2026, 10, 13));
  });

  test("a floating dateTime uses its timeZone, then the gateway zone; no end collapses to the start", () => {
    const own = mapGoogleCalendarEvent(
      timed({
        start: { dateTime: "2026-11-12T09:30:00", timeZone: "America/New_York" },
        end: { dateTime: "2026-11-12T10:00:00", timeZone: "America/New_York" },
      }),
      CTX,
    );
    expect(own?.metadata["start_ms"]).toBe(Date.UTC(2026, 10, 12, 14, 30));
    expect(own?.metadata["end_ms"]).toBe(Date.UTC(2026, 10, 12, 15, 0));
    const fallback = mapGoogleCalendarEvent(
      timed({ start: { dateTime: "2026-11-12T09:30:00" }, end: undefined }),
      CTX,
    );
    expect(fallback?.metadata["start_ms"]).toBe(Date.UTC(2026, 10, 12, 9, 30));
    expect(fallback?.metadata["end_ms"]).toBe(fallback?.metadata["start_ms"]);
    const badEnd = mapGoogleCalendarEvent(timed({ end: { dateTime: "garbage" } }), CTX);
    expect(badEnd?.metadata["end_ms"]).toBe(badEnd?.metadata["start_ms"]);
  });

  test("status: tentative stays; cancelled is null and flagged; unknown reads confirmed", () => {
    expect(mapGoogleCalendarEvent(timed({ status: "tentative" }), CTX)?.metadata["status"]).toBe(
      "tentative",
    );
    expect(mapGoogleCalendarEvent(timed({ status: "cancelled" }), CTX)).toBeNull();
    expect(isCancelledGoogleEvent(timed({ status: "cancelled" }))).toBe(true);
    expect(isCancelledGoogleEvent(timed())).toBe(false);
    expect(isCancelledGoogleEvent("nope")).toBe(false);
    expect(mapGoogleCalendarEvent(timed({ status: undefined }), CTX)?.metadata["status"]).toBe(
      "confirmed",
    );
  });

  test("self_response is null with no attendees, with no self entry, or an unknown value", () => {
    expect(mapGoogleCalendarEvent(timed({ attendees: undefined }), CTX)?.metadata).toMatchObject({
      self_response: null,
      attendee_count: 0,
    });
    const noSelf = mapGoogleCalendarEvent(
      timed({ attendees: [{ email: "a@x.com", responseStatus: "accepted" }, 7] }),
      CTX,
    );
    expect(noSelf?.metadata["self_response"]).toBeNull();
    expect(noSelf?.metadata["attendee_count"]).toBe(2);
    const odd = mapGoogleCalendarEvent(
      timed({ attendees: [{ self: true, responseStatus: "maybe" }] }),
      CTX,
    );
    expect(odd?.metadata["self_response"]).toBeNull();
    for (const [raw, want] of [
      ["accepted", "accepted"],
      ["declined", "declined"],
      ["tentative", "tentative"],
    ] as const) {
      const r = mapGoogleCalendarEvent(
        timed({ attendees: [{ self: true, responseStatus: raw }] }),
        CTX,
      );
      expect(r?.metadata["self_response"]).toBe(want);
    }
  });

  test("an event with no id, no start, a non-record start or no dateTime/date is null", () => {
    expect(mapGoogleCalendarEvent(timed({ id: undefined }), CTX)).toBeNull();
    expect(mapGoogleCalendarEvent(timed({ id: "  " }), CTX)).toBeNull();
    expect(mapGoogleCalendarEvent(timed({ start: undefined }), CTX)).toBeNull();
    expect(mapGoogleCalendarEvent(timed({ start: "x" }), CTX)).toBeNull();
    expect(mapGoogleCalendarEvent(timed({ start: {} }), CTX)).toBeNull();
    expect(mapGoogleCalendarEvent(timed({ start: { dateTime: "yesterday" } }), CTX)).toBeNull();
    expect(mapGoogleCalendarEvent(timed({ start: { date: "2026-13-45" } }), CTX)).toBeNull();
    expect(mapGoogleCalendarEvent(null, CTX)).toBeNull();
    expect(mapGoogleCalendarEvent([], CTX)).toBeNull();
    expect(
      mapGoogleCalendarEvent(timed({ start: { dateTime: "2026-11-12T09:30:00" } }), {
        ...CTX,
        zone: "Not/AZone",
      }),
    ).toBeNull();
  });

  test("the external id carries the calendar; a recurring instance id is kept whole", () => {
    expect(googleCalendarExternalId("c1", "abc_20261111T090000Z")).toBe("c1|abc_20261111T090000Z");
    const row = mapGoogleCalendarEvent(
      timed({ id: "abc_20261111T090000Z", recurringEventId: "abc" }),
      CTX,
    );
    expect(row?.externalId).toBe("primary@x.com|abc_20261111T090000Z");
    expect(row?.metadata["recurring_event_id"]).toBe("abc");
  });

  test("optional strings are present only when non-empty strings; title clamps and defaults", () => {
    const bare = mapGoogleCalendarEvent(
      timed({
        summary: "  ",
        description: undefined,
        location: 5,
        iCalUID: "",
        updated: "not a date",
        htmlLink: undefined,
        organizer: undefined,
      }),
      { ...CTX, calendarName: "" },
    );
    expect(bare?.title).toBe("(untitled event)");
    expect(bare?.bodyPreview).toBe("");
    expect(bare?.url).toBeNull();
    expect(bare?.modifiedAt).toBe(5);
    for (const k of [
      "location",
      "ical_uid",
      "recurring_event_id",
      "calendar_name",
      "organizer_email",
    ]) {
      expect(k in (bare?.metadata ?? {}), k).toBe(false);
    }
    const long = mapGoogleCalendarEvent(timed({ summary: "x".repeat(300) }), CTX);
    expect(long?.title).toBe(`${"x".repeat(256)}…`);
  });
});
