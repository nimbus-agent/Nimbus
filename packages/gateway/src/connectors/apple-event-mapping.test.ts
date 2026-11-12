/**
 * Unit tests for mapAppleEventToItem (F2).
 *
 * Coverage targets:
 *  - Timed event → correct row shape + metadata incl. attendees
 *  - Override occurrence → external_id is `uid:recurrenceId`
 *  - No-UID event → null
 *  - 5000-char description → preview capped at 2000 chars
 *  - modifiedAt falls back: dtstamp → start → syncedAt
 *  - All-day event → allDay:true in metadata
 *  - Empty summary → "(untitled event)" title
 *  - Long summary → clamped at 256 chars
 */
import { describe, expect, test } from "bun:test";
import { type ParsedEvent, parseICalendar } from "@nimbus-dev/sdk";
import { parseIcalEventExtras } from "./_lib/ical-event-extras.ts";
import { EVENT_META_VERSION, mapAppleEventToItem } from "./apple-event-mapping.ts";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<ParsedEvent> = {}): ParsedEvent {
  return {
    uid: "abc-123",
    recurrenceId: null,
    summary: "Weekly Standup",
    description: "Discuss progress",
    location: "Room 4B",
    start: "20260601T090000Z",
    end: "20260601T091500Z",
    allDay: false,
    status: "CONFIRMED",
    organizer: "boss@icloud.com",
    attendees: ["a@icloud.com", "b@icloud.com"],
    rrule: null,
    dtstamp: "20260531T120000Z",
    ...overrides,
  };
}

const CTX = { calendar: "Work", syncedAt: 1_700_000_000_000 };

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("mapAppleEventToItem", () => {
  test("timed event produces correct row shape and metadata with attendees", () => {
    const ev = makeEvent();
    const row = mapAppleEventToItem(ev, CTX);
    expect(row).not.toBeNull();
    expect(row?.service).toBe("apple");
    expect(row?.type).toBe("event");
    expect(row?.externalId).toBe("abc-123");
    expect(row?.title).toBe("Weekly Standup");
    expect(row?.bodyPreview).toBe("Discuss progress");
    expect(row?.url).toBeNull();
    expect(row?.canonicalUrl).toBeNull();
    expect(row?.syncedAt).toBe(CTX.syncedAt);

    const meta = row?.metadata;
    expect(meta?.["uid"]).toBe("abc-123");
    expect(meta?.["calendar"]).toBe("Work");
    expect(meta?.["start"]).toBe("20260601T090000Z");
    expect(meta?.["end"]).toBe("20260601T091500Z");
    expect(meta?.["allDay"]).toBe(false);
    expect(meta?.["location"]).toBe("Room 4B");
    expect(meta?.["organizer"]).toBe("boss@icloud.com");
    expect(meta?.["status"]).toBe("CONFIRMED");
    expect(meta?.["recurrence"]).toBeNull();
    expect(meta?.["attendees"]).toEqual(["a@icloud.com", "b@icloud.com"]);
  });

  test("modifiedAt comes from dtstamp when present", () => {
    const ev = makeEvent({ dtstamp: "20260531T120000Z" });
    const row = mapAppleEventToItem(ev, CTX);
    // 20260531T120000Z = 2026-05-31T12:00:00Z
    const expected = Date.parse("2026-05-31T12:00:00Z");
    expect(row?.modifiedAt).toBe(expected);
  });

  test("modifiedAt falls back to start when dtstamp absent", () => {
    const ev = makeEvent({ dtstamp: null, start: "20260601T090000Z" });
    const row = mapAppleEventToItem(ev, CTX);
    const expected = Date.parse("2026-06-01T09:00:00Z");
    expect(row?.modifiedAt).toBe(expected);
  });

  test("modifiedAt falls back to syncedAt when both dtstamp and start are absent", () => {
    const ev = makeEvent({ dtstamp: null, start: null });
    const row = mapAppleEventToItem(ev, CTX);
    expect(row?.modifiedAt).toBe(CTX.syncedAt);
  });

  test("override occurrence: external_id is uid:recurrenceId", () => {
    const ev = makeEvent({ recurrenceId: "20260601T090000Z" });
    const row = mapAppleEventToItem(ev, CTX);
    expect(row?.externalId).toBe("abc-123:20260601T090000Z");
  });

  test("no-UID event returns null", () => {
    const ev = makeEvent({ uid: "" });
    expect(mapAppleEventToItem(ev, CTX)).toBeNull();
  });

  test("whitespace-only UID returns null", () => {
    const ev = makeEvent({ uid: "   " });
    expect(mapAppleEventToItem(ev, CTX)).toBeNull();
  });

  test("5000-char description is capped at 2000 chars in preview", () => {
    const ev = makeEvent({ description: "X".repeat(5000) });
    const row = mapAppleEventToItem(ev, CTX);
    expect((row?.bodyPreview ?? "").length).toBeLessThanOrEqual(2000);
  });

  test("null description produces empty preview", () => {
    const ev = makeEvent({ description: null });
    const row = mapAppleEventToItem(ev, CTX);
    expect(row?.bodyPreview).toBe("");
  });

  test("null summary produces '(untitled event)' title", () => {
    const ev = makeEvent({ summary: null });
    const row = mapAppleEventToItem(ev, CTX);
    expect(row?.title).toBe("(untitled event)");
  });

  test("empty summary produces '(untitled event)' title", () => {
    const ev = makeEvent({ summary: "   " });
    const row = mapAppleEventToItem(ev, CTX);
    expect(row?.title).toBe("(untitled event)");
  });

  test("long summary is clamped to 256 chars (with ellipsis)", () => {
    const ev = makeEvent({ summary: "S".repeat(300) });
    const row = mapAppleEventToItem(ev, CTX);
    // clamp appends "…" making total 257 chars; check it is ≤257
    expect((row?.title ?? "").length).toBeLessThanOrEqual(257);
    expect(row?.title?.endsWith("…")).toBe(true);
  });

  test("all-day event is reflected in metadata.allDay", () => {
    const ev = makeEvent({ allDay: true, start: "20260601", end: "20260602" });
    const row = mapAppleEventToItem(ev, CTX);
    expect(row?.metadata["allDay"]).toBe(true);
  });

  test("recurrenceId null → no colon in external_id", () => {
    const ev = makeEvent({ recurrenceId: null });
    const row = mapAppleEventToItem(ev, CTX);
    expect(row?.externalId).toBe("abc-123");
    expect(row?.externalId.includes(":")).toBe(false);
  });

  test("rrule is surfaced as metadata.recurrence", () => {
    const ev = makeEvent({ rrule: "FREQ=WEEKLY;BYDAY=MO" });
    const row = mapAppleEventToItem(ev, CTX);
    expect(row?.metadata["recurrence"]).toBe("FREQ=WEEKLY;BYDAY=MO");
  });
});

// ─── iCalendar date parsing (reached through `modifiedAt`) ───────────────────

describe("mapAppleEventToItem — DTSTAMP / DTSTART parsing", () => {
  test("accepts an ISO-8601 timestamp directly", () => {
    // CalDAV servers are not uniform: some emit the RFC 5545 compact form,
    // some an ISO-8601 string. Both must resolve to the same instant.
    const iso = mapAppleEventToItem(makeEvent({ dtstamp: "2026-05-31T12:00:00Z" }), CTX);
    const compact = mapAppleEventToItem(makeEvent({ dtstamp: "20260531T120000Z" }), CTX);
    expect(iso?.modifiedAt).toBe(Date.parse("2026-05-31T12:00:00Z"));
    expect(iso?.modifiedAt).toBe(compact?.modifiedAt);
  });

  test("treats an all-day DATE value as midnight UTC", () => {
    const row = mapAppleEventToItem(makeEvent({ dtstamp: "20260601", allDay: true }), CTX);
    expect(row?.modifiedAt).toBe(Date.parse("2026-06-01T00:00:00Z"));
  });

  test("treats a floating (no-Z) datetime as UTC", () => {
    const row = mapAppleEventToItem(makeEvent({ dtstamp: "20260601T090000" }), CTX);
    expect(row?.modifiedAt).toBe(Date.parse("2026-06-01T09:00:00Z"));
  });

  // An unparseable DTSTAMP must fall through the chain rather than poison
  // `modified_at` with NaN — a NaN there sorts unpredictably and makes the
  // item invisible to every `--since` window.
  test("falls through to DTSTART when DTSTAMP is unparseable", () => {
    const row = mapAppleEventToItem(
      makeEvent({ dtstamp: "garbage", start: "20260601T090000Z" }),
      CTX,
    );
    expect(row?.modifiedAt).toBe(Date.parse("2026-06-01T09:00:00Z"));
  });

  // Compact-SHAPED but not a real date: the regex matches, `Date.parse` does not.
  test("rejects a compact-form value that is not a real date", () => {
    const row = mapAppleEventToItem(makeEvent({ dtstamp: "20261332", start: null }), CTX);
    expect(row?.modifiedAt).toBe(CTX.syncedAt);
  });

  test("falls all the way through to syncedAt when both values are unparseable", () => {
    const row = mapAppleEventToItem(makeEvent({ dtstamp: "garbage", start: "also-garbage" }), CTX);
    expect(row?.modifiedAt).toBe(CTX.syncedAt);
  });
});

// ─── Normalized keys (Phase 10 MB1): the REAL parse + extras + mapper ────────

describe("mapAppleEventToItem - normalized keys", () => {
  const ics = (...lines: string[]): string =>
    ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:n1", ...lines, "END:VEVENT", "END:VCALENDAR"].join(
      "\r\n",
    );
  const mapped = (
    raw: string,
    ctx: { selfEmail?: string; zone?: string } = {},
  ): Record<string, unknown> => {
    const [ev] = parseICalendar(raw);
    if (ev === undefined) throw new Error("no event");
    const extras = parseIcalEventExtras(raw).get(ev.uid);
    const row = mapAppleEventToItem(ev, {
      ...CTX,
      ...(extras === undefined ? {} : { extras }),
      zone: ctx.zone ?? "UTC",
      ...(ctx.selfEmail === undefined ? {} : { selfEmail: ctx.selfEmail }),
    });
    return row?.metadata ?? {};
  };

  test("a UTC timed event writes every normalized key and the version", () => {
    const m = mapped(
      ics(
        "DTSTART:20261111T093000Z",
        "DTEND:20261111T103000Z",
        "ORGANIZER;CN=Boss:mailto:Boss@iCloud.com",
        "ATTENDEE;PARTSTAT=ACCEPTED:mailto:me@icloud.com",
        "ATTENDEE;PARTSTAT=DECLINED:mailto:other@icloud.com",
      ),
      { selfEmail: "Me@iCloud.com" },
    );
    expect(m["start_ms"]).toBe(Date.UTC(2026, 10, 11, 9, 30));
    expect(m["end_ms"]).toBe(Date.UTC(2026, 10, 11, 10, 30));
    expect(m["all_day"]).toBe(false);
    expect(m["organizer_email"]).toBe("boss@icloud.com");
    expect(m["attendee_count"]).toBe(2);
    expect(m["self_response"]).toBe("accepted");
    expect(m["meta_v"]).toBe(EVENT_META_VERSION);
    // the raw keys are unchanged
    expect(m["start"]).toBe("20261111T093000Z");
    expect(m["allDay"]).toBe(false);
    expect(m["organizer"]).toBe("Boss@iCloud.com");
  });

  test("a TZID event converts through its zone, not the gateway zone", () => {
    const m = mapped(
      ics(
        "DTSTART;TZID=America/New_York:20261111T093000",
        "DTEND;TZID=America/New_York:20261111T103000",
      ),
      { zone: "Asia/Tokyo" },
    );
    expect(m["start_ms"]).toBe(Date.UTC(2026, 10, 11, 14, 30));
    expect(m["end_ms"]).toBe(Date.UTC(2026, 10, 11, 15, 30));
  });

  test("a floating event uses the injected zone", () => {
    const m = mapped(ics("DTSTART:20261111T093000", "DTEND:20261111T103000"), {
      zone: "Europe/London",
    });
    expect(m["start_ms"]).toBe(Date.UTC(2026, 10, 11, 9, 30));
    const summer = mapped(ics("DTSTART:20260701T093000"), { zone: "Europe/London" });
    expect(summer["start_ms"]).toBe(Date.UTC(2026, 6, 1, 8, 30));
  });

  test("an all-day event spans midnight to midnight in the zone, with or without DTEND", () => {
    const withEnd = mapped(ics("DTSTART;VALUE=DATE:20261111", "DTEND;VALUE=DATE:20261113"), {
      zone: "Europe/Paris",
    });
    expect(withEnd["all_day"]).toBe(true);
    expect(withEnd["start_ms"]).toBe(Date.UTC(2026, 10, 10, 23));
    expect(withEnd["end_ms"]).toBe(Date.UTC(2026, 10, 12, 23));
    const noEnd = mapped(ics("DTSTART;VALUE=DATE:20261111"), { zone: "Europe/Paris" });
    expect(noEnd["end_ms"]).toBe(Date.UTC(2026, 10, 11, 23));
  });

  test("a timed event with neither DTEND nor DURATION ends when it starts; DURATION adds", () => {
    const none = mapped(ics("DTSTART:20261111T093000Z"));
    expect(none["end_ms"]).toBe(none["start_ms"]);
    const dur = mapped(ics("DTSTART:20261111T093000Z", "DURATION:PT1H30M"));
    expect(dur["end_ms"]).toBe(Date.UTC(2026, 10, 11, 11, 0));
  });

  test("a date-only start honours DURATION: P3D ends three local days later, none is one day", () => {
    const p3 = mapped(ics("DTSTART;VALUE=DATE:20261111", "DURATION:P3D"), { zone: "Europe/Paris" });
    expect(p3["start_ms"]).toBe(Date.UTC(2026, 10, 10, 23));
    expect(p3["end_ms"]).toBe(Date.UTC(2026, 10, 13, 23));
    const none = mapped(ics("DTSTART;VALUE=DATE:20261111"), { zone: "Europe/Paris" });
    expect(none["end_ms"]).toBe(Date.UTC(2026, 10, 11, 23));
  });

  test("an all-day P1W across the autumn change ends seven local days later", () => {
    const m = mapped(ics("DTSTART;VALUE=DATE:20261025", "DURATION:P1W"), { zone: "Europe/Paris" });
    // 2026-10-25 00:00 CEST (+2) to 2026-11-01 00:00 CET (+1)
    expect(m["start_ms"]).toBe(Date.UTC(2026, 9, 24, 22));
    expect(m["end_ms"]).toBe(Date.UTC(2026, 9, 31, 23));
  });

  test("a timed P1D is a nominal day: across spring-forward it ends at the same local time", () => {
    const m = mapped(ics("DTSTART;TZID=America/New_York:20260307T120000", "DURATION:P1D"));
    expect(m["start_ms"]).toBe(Date.UTC(2026, 2, 7, 17));
    expect(m["end_ms"]).toBe(Date.UTC(2026, 2, 8, 16));
  });

  test("P1DT2H adds the nominal day, then exactly two hours", () => {
    const m = mapped(ics("DTSTART;TZID=America/New_York:20260307T120000", "DURATION:P1DT2H"));
    expect(m["end_ms"]).toBe(Date.UTC(2026, 2, 8, 18));
  });

  test("PT90M is exact and a P1W timed event is seven calendar days", () => {
    const exact = mapped(ics("DTSTART;TZID=America/New_York:20260308T010000", "DURATION:PT90M"));
    // 01:00 EST + 90 minutes crosses the 02:00 gap: 03:30 EDT
    expect(exact["end_ms"]).toBe(Date.UTC(2026, 2, 8, 6) + 90 * 60_000);
    const week = mapped(ics("DTSTART;TZID=America/New_York:20260307T120000", "DURATION:P1W"));
    expect(week["end_ms"]).toBe(Date.UTC(2026, 2, 14, 16));
  });

  test("self_response is null for an unlisted address, an unknown status or no selfEmail", () => {
    const raw = ics("DTSTART:20261111T093000Z", "ATTENDEE;PARTSTAT=TENTATIVE:mailto:me@icloud.com");
    expect(mapped(raw, { selfEmail: "someone@else.com" })["self_response"]).toBeNull();
    expect(mapped(raw)["self_response"]).toBeNull();
    expect(mapped(raw, { selfEmail: "ME@icloud.com" })["self_response"]).toBe("tentative");
    const odd = ics("DTSTART:20261111T093000Z", "ATTENDEE;PARTSTAT=BOGUS:mailto:me@icloud.com");
    expect(mapped(odd, { selfEmail: "me@icloud.com" })["self_response"]).toBeNull();
  });

  test("an unparseable DTSTART leaves start_ms and end_ms out", () => {
    const m = mapped(ics("DTSTART:garbage", "DTEND:20261111T103000Z"));
    expect("start_ms" in m).toBe(false);
    expect("end_ms" in m).toBe(false);
    expect(m["meta_v"]).toBe(EVENT_META_VERSION);
  });

  test("no organizer omits organizer_email; an unknown TZID falls back to the zone", () => {
    const m = mapped(ics("DTSTART;TZID=Not/AZone:20261111T093000"), { zone: "UTC" });
    expect("organizer_email" in m).toBe(false);
    expect(m["start_ms"]).toBe(Date.UTC(2026, 10, 11, 9, 30));
  });

  test("an unparseable DTEND is treated as absent", () => {
    const m = mapped(ics("DTSTART:20261111T093000Z", "DTEND:garbage", "DURATION:PT1H"));
    expect(m["end_ms"]).toBe(Date.UTC(2026, 10, 11, 10, 30));
  });

  test("with no zone given the mapper falls back to the gateway zone", () => {
    const [ev] = parseICalendar(ics("DTSTART:20261111T093000"));
    const row = ev === undefined ? null : mapAppleEventToItem(ev, CTX);
    expect(typeof row?.metadata["start_ms"]).toBe("number");
  });
});
