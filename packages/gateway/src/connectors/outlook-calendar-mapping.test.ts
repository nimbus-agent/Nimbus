import { describe, expect, test } from "bun:test";

import { OUTLOOK_EVENT_META_VERSION } from "./calendar-event-meta.ts";
import { mapOutlookCalendarEvent } from "./outlook-calendar-mapping.ts";

const CTX = { zone: "Europe/London", syncedAt: 9 };

function ev(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "AAMk1",
    subject: "Review",
    bodyPreview: "Line one\r\n\r\n\r\nLine two",
    start: { dateTime: "2026-11-12T09:30:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-11-12T10:30:00.0000000", timeZone: "UTC" },
    isAllDay: false,
    isCancelled: false,
    showAs: "busy",
    responseStatus: { response: "accepted" },
    organizer: { emailAddress: { address: "Boss@Example.com" } },
    attendees: [{ emailAddress: { address: "a@x.com" } }, { emailAddress: { address: "b@x.com" } }],
    location: { displayName: "Room 5" },
    iCalUId: "uid-1",
    seriesMasterId: "series-1",
    lastModifiedDateTime: "2026-11-10T08:00:00Z",
    webLink: "https://outlook.office.com/calendar/item/1",
    ...over,
  };
}

function rowOf(raw: unknown) {
  const m = mapOutlookCalendarEvent(raw, CTX);
  if (m.kind !== "row") throw new Error(`expected a row, got ${m.kind}`);
  return m;
}

describe("mapOutlookCalendarEvent", () => {
  test("a UTC timed event: exact epochs, the row shape and the metadata keys", () => {
    const { row, unresolved } = rowOf(ev());
    expect(unresolved).toBe(false);
    expect(row.service).toBe("outlook");
    expect(row.type).toBe("event");
    expect(row.externalId).toBe("AAMk1");
    expect(row.title).toBe("Review");
    expect(row.bodyPreview).toBe("Line one\nLine two");
    expect(row.url).toBe("https://outlook.office.com/calendar/item/1");
    expect(row.modifiedAt).toBe(Date.parse("2026-11-10T08:00:00Z"));
    expect(row).not.toHaveProperty("body");
    const m = row.metadata;
    expect(m["start_ms"]).toBe(Date.UTC(2026, 10, 12, 9, 30));
    expect(m["end_ms"]).toBe(Date.UTC(2026, 10, 12, 10, 30));
    expect(m["all_day"]).toBe(false);
    expect(m["status"]).toBe("confirmed");
    expect(m["self_response"]).toBe("accepted");
    expect(m["organizer_email"]).toBe("boss@example.com");
    expect(m["attendee_count"]).toBe(2);
    expect(m["location"]).toBe("Room 5");
    expect(m["ical_uid"]).toBe("uid-1");
    expect(m["series_master_id"]).toBe("series-1");
    expect(m["meta_v"]).toBe(OUTLOOK_EVENT_META_VERSION);
  });

  test("an IANA timeZone is resolved through the zone rules; a Windows name or unknown zone is unresolved", () => {
    const london = rowOf(
      ev({
        start: { dateTime: "2026-07-01T09:30:00.0000000", timeZone: "Europe/London" },
        end: { dateTime: "2026-07-01T10:30:00.0000000", timeZone: "Europe/London" },
      }),
    );
    expect(london.row.metadata["start_ms"]).toBe(Date.UTC(2026, 6, 1, 8, 30));
    for (const zone of ["Pacific Standard Time", "Not/AZone", ""]) {
      const r = rowOf(
        ev({
          start: { dateTime: "2026-11-12T09:30:00.0000000", timeZone: zone },
          end: { dateTime: "2026-11-12T10:30:00.0000000", timeZone: zone },
        }),
      );
      expect(r.unresolved, zone).toBe(true);
      expect("start_ms" in r.row.metadata, zone).toBe(false);
      expect("end_ms" in r.row.metadata, zone).toBe(false);
      expect(r.row.metadata["status"]).toBe("confirmed");
    }
  });

  test("an offset-less dateTime never depends on the host zone (UTC is exact)", () => {
    const before = process.env["TZ"];
    const { row } = rowOf(ev());
    expect(row.metadata["start_ms"]).toBe(Date.UTC(2026, 10, 12, 9, 30));
    expect(process.env["TZ"]).toBe(before);
  });

  test("an all-day event is midnight in the gateway zone from the date parts", () => {
    const m = rowOf(
      ev({
        isAllDay: true,
        start: { dateTime: "2026-11-12T00:00:00.0000000", timeZone: "UTC" },
        end: { dateTime: "2026-11-14T00:00:00.0000000", timeZone: "UTC" },
      }),
    ).row.metadata;
    expect(m["all_day"]).toBe(true);
    expect(m["start_ms"]).toBe(Date.UTC(2026, 10, 12));
    expect(m["end_ms"]).toBe(Date.UTC(2026, 10, 14));
    const nz = mapOutlookCalendarEvent(
      ev({
        isAllDay: true,
        start: { dateTime: "2026-11-12T00:00:00.0000000", timeZone: "UTC" },
        end: { dateTime: "2026-11-13T00:00:00.0000000", timeZone: "UTC" },
      }),
      { zone: "Pacific/Auckland", syncedAt: 1 },
    );
    expect(nz.kind === "row" && nz.row.metadata["start_ms"]).toBe(Date.UTC(2026, 10, 11, 11));
  });

  test("an all-day event whose time part is not midnight is unresolved", () => {
    const r = rowOf(
      ev({
        isAllDay: true,
        start: { dateTime: "2026-11-12T08:00:00.0000000", timeZone: "UTC" },
        end: { dateTime: "2026-11-13T00:00:00.0000000", timeZone: "UTC" },
      }),
    );
    expect(r.unresolved).toBe(true);
    const endOff = rowOf(
      ev({
        isAllDay: true,
        start: { dateTime: "2026-11-12T00:00:00.0000000", timeZone: "UTC" },
        end: { dateTime: "2026-11-13T00:30:00.0000000", timeZone: "UTC" },
      }),
    );
    expect(endOff.unresolved).toBe(true);
  });

  test("a missing or malformed start/end is unresolved, not dropped", () => {
    expect(rowOf(ev({ start: undefined })).unresolved).toBe(true);
    expect(rowOf(ev({ end: { dateTime: "tomorrow", timeZone: "UTC" } })).unresolved).toBe(true);
    expect(rowOf(ev({ start: "x" })).unresolved).toBe(true);
  });

  test("a cancelled event maps to a delete; an event with no id is skipped", () => {
    expect(mapOutlookCalendarEvent(ev({ isCancelled: true }), CTX)).toEqual({
      kind: "delete",
      externalId: "AAMk1",
    });
    expect(mapOutlookCalendarEvent(ev({ id: "" }), CTX)).toEqual({ kind: "skip" });
    expect(mapOutlookCalendarEvent(ev({ id: undefined }), CTX)).toEqual({ kind: "skip" });
    expect(mapOutlookCalendarEvent(null, CTX)).toEqual({ kind: "skip" });
    expect(mapOutlookCalendarEvent([], CTX)).toEqual({ kind: "skip" });
  });

  test("status follows showAs; self_response follows the table and is null with no attendees", () => {
    expect(rowOf(ev({ showAs: "tentative" })).row.metadata["status"]).toBe("tentative");
    expect(rowOf(ev({ showAs: undefined })).row.metadata["status"]).toBe("confirmed");
    const cases: Array<[string, string]> = [
      ["none", "needs-action"],
      ["notResponded", "needs-action"],
      ["tentativelyAccepted", "tentative"],
      ["accepted", "accepted"],
      ["declined", "declined"],
      ["organizer", "accepted"],
    ];
    for (const [raw, want] of cases) {
      expect(
        rowOf(ev({ responseStatus: { response: raw } })).row.metadata["self_response"],
        raw,
      ).toBe(want);
    }
    expect(rowOf(ev({ attendees: [] })).row.metadata["self_response"]).toBeNull();
    expect(rowOf(ev({ attendees: undefined })).row.metadata["attendee_count"]).toBe(0);
    expect(rowOf(ev({ responseStatus: undefined })).row.metadata["self_response"]).toBeNull();
  });

  test("optional strings are present only when non-empty; title defaults and clamps", () => {
    const bare = rowOf(
      ev({
        subject: " ",
        bodyPreview: undefined,
        location: { displayName: "" },
        iCalUId: "",
        seriesMasterId: 4,
        webLink: undefined,
        lastModifiedDateTime: "nope",
        organizer: undefined,
      }),
    ).row;
    expect(bare.title).toBe("(no subject)");
    expect(bare.bodyPreview).toBe("");
    expect(bare.url).toBeNull();
    expect(bare.modifiedAt).toBe(9);
    for (const k of ["location", "ical_uid", "series_master_id", "organizer_email"]) {
      expect(k in bare.metadata, k).toBe(false);
    }
    expect(rowOf(ev({ subject: "y".repeat(300) })).row.title).toBe(`${"y".repeat(256)}…`);
  });
});
