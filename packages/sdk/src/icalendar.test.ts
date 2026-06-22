import { describe, expect, it } from "bun:test";
import { buildVEvent, parseICalendar } from "./icalendar.ts";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Join lines with CRLF (standard iCalendar line ending). */
function ics(...lines: string[]): string {
  return lines.join("\r\n");
}

// ---------------------------------------------------------------------------
// parseICalendar — Task B1 fixtures
// ---------------------------------------------------------------------------

const TIMED = ics(
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "UID:abc-1",
  "SUMMARY:Standup \\, daily",
  "DTSTART:20260601T090000Z",
  "DTEND:20260601T091500Z",
  "LOCATION:Room 4",
  "ORGANIZER:mailto:boss@icloud.com",
  "ATTENDEE:mailto:a@icloud.com",
  "ATTENDEE:mailto:b@icloud.com",
  "STATUS:CONFIRMED",
  "END:VEVENT",
  "END:VCALENDAR",
);

describe("parseICalendar", () => {
  // (a) Timed event with attendees + SUMMARY unescape
  it("parses a timed event with attendees + unescapes SUMMARY", () => {
    const events = parseICalendar(TIMED);
    expect(events).toHaveLength(1);
    const [e] = events;
    expect(e).toMatchObject({
      uid: "abc-1",
      summary: "Standup , daily",
      location: "Room 4",
      start: "20260601T090000Z",
      end: "20260601T091500Z",
      organizer: "boss@icloud.com",
      attendees: ["a@icloud.com", "b@icloud.com"],
      allDay: false,
      recurrenceId: null,
      status: "CONFIRMED",
    });
  });

  // (b) All-day event: DTSTART with VALUE=DATE param
  it("detects an all-day event via VALUE=DATE", () => {
    const src = ics(
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:allday-1",
      "SUMMARY:Bank Holiday",
      "DTSTART;VALUE=DATE:20260601",
      "DTEND;VALUE=DATE:20260602",
      "END:VEVENT",
      "END:VCALENDAR",
    );
    const [e] = parseICalendar(src);
    expect(e?.allDay).toBe(true);
    expect(e?.start).toBe("20260601");
  });

  it("sets allDay=false for a timed event", () => {
    const [e] = parseICalendar(TIMED);
    expect(e?.allDay).toBe(false);
  });

  it("does NOT treat DTSTART;VALUE=DATE-TIME as all-day (exact param token)", () => {
    const src = ics(
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:datetime-1",
      "SUMMARY:Explicitly typed timed event",
      "DTSTART;VALUE=DATE-TIME:20260601T090000Z",
      "DTEND;VALUE=DATE-TIME:20260601T100000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    );
    const [e] = parseICalendar(src);
    expect(e?.allDay).toBe(false);
  });

  it("detects all-day when VALUE=DATE rides alongside another param", () => {
    const src = ics(
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:allday-2",
      "SUMMARY:Tz-tagged all-day",
      "DTSTART;TZID=UTC;VALUE=DATE:20260601",
      "END:VEVENT",
      "END:VCALENDAR",
    );
    const [e] = parseICalendar(src);
    expect(e?.allDay).toBe(true);
  });

  // (c) Folded DESCRIPTION spanning 3 physical lines → unfolded to one string
  it("unfolds a DESCRIPTION that spans 3 physical lines", () => {
    const src = ics(
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:fold-1",
      "SUMMARY:Folded Test",
      "DTSTART:20260601T100000Z",
      "DTEND:20260601T110000Z",
      // The continuation lines start with a SPACE (RFC 5545 §3.1)
      // Folded mid-token: unfolding removes CRLF + one leading whitespace
      // (RFC 5545 §3.1), reconstructing the original octets incl. spaces.
      "DESCRIPTION:This is a very long description that has be",
      " en folded acr",
      " oss three lines.",
      "END:VEVENT",
      "END:VCALENDAR",
    );
    const [e] = parseICalendar(src);
    expect(e?.description).toBe(
      "This is a very long description that has been folded across three lines.",
    );
  });

  // (d) Two VEVENTs: master + RECURRENCE-ID override
  it("returns two ParsedEvents when two VEVENTs present; second has recurrenceId", () => {
    const src = ics(
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:rec-1",
      "SUMMARY:Master",
      "DTSTART:20260601T090000Z",
      "DTEND:20260601T091500Z",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:rec-1",
      "SUMMARY:Override",
      "DTSTART:20260608T090000Z",
      "DTEND:20260608T091500Z",
      "RECURRENCE-ID:20260608T090000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    );
    const events = parseICalendar(src);
    expect(events).toHaveLength(2);
    expect(events[0]?.recurrenceId).toBeNull();
    expect(events[1]?.recurrenceId).toBe("20260608T090000Z");
  });

  // (e) Block missing UID → skipped
  it("skips a VEVENT block with no UID", () => {
    const src = ics(
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "SUMMARY:No UID Event",
      "DTSTART:20260601T090000Z",
      "DTEND:20260601T091500Z",
      "END:VEVENT",
      "END:VCALENDAR",
    );
    const events = parseICalendar(src);
    expect(events).toHaveLength(0);
  });

  it("skips a VEVENT block with an empty UID value", () => {
    const src = ics(
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:",
      "SUMMARY:Empty UID",
      "DTSTART:20260601T090000Z",
      "DTEND:20260601T091500Z",
      "END:VEVENT",
      "END:VCALENDAR",
    );
    const events = parseICalendar(src);
    expect(events).toHaveLength(0);
  });

  // (f) Escaped commas/semicolons/newlines in SUMMARY → unescaped
  it("unescapes \\, \\; \\n \\N in SUMMARY", () => {
    const src = ics(
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:escape-1",
      "SUMMARY:A\\,B\\;C\\nD\\NE",
      "DTSTART:20260601T090000Z",
      "DTEND:20260601T091500Z",
      "END:VEVENT",
      "END:VCALENDAR",
    );
    const [e] = parseICalendar(src);
    expect(e?.summary).toBe("A,B;C\nD\nE");
  });

  // Additional escaping: double-backslash → single backslash
  it("unescapes \\\\ to a single backslash in SUMMARY", () => {
    const src = ics(
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:bs-1",
      "SUMMARY:path\\\\to\\\\file",
      "DTSTART:20260601T090000Z",
      "DTEND:20260601T091500Z",
      "END:VEVENT",
      "END:VCALENDAR",
    );
    const [e] = parseICalendar(src);
    expect(e?.summary).toBe("path\\to\\file");
  });

  // Combined escape: wire `\\n` (escaped backslash + literal n) must decode to
  // the two literal chars `\n`, NOT a newline. Guards the unescape pass order.
  it("decodes an escaped backslash followed by 'n' as literal \\n, not a newline", () => {
    const src = ics(
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:bsn-1",
      // JS "\\\\n" → wire `\\n` (backslash, backslash, n)
      "SUMMARY:path\\\\nfile",
      "DTSTART:20260601T090000Z",
      "DTEND:20260601T091500Z",
      "END:VEVENT",
      "END:VCALENDAR",
    );
    const [e] = parseICalendar(src);
    expect(e?.summary).toBe("path\\nfile"); // backslash + n, two literal chars
    expect(e?.summary).not.toContain("\n"); // definitely not a newline
  });

  // ORGANIZER without mailto → organizer should be null
  it("returns null organizer when ORGANIZER has no mailto", () => {
    const src = ics(
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:org-1",
      "SUMMARY:No Mailto",
      "DTSTART:20260601T090000Z",
      "DTEND:20260601T091500Z",
      "ORGANIZER:CN=Boss",
      "END:VEVENT",
      "END:VCALENDAR",
    );
    const [e] = parseICalendar(src);
    expect(e?.organizer).toBeNull();
  });

  // RRULE captured
  it("captures RRULE", () => {
    const src = ics(
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:rrule-1",
      "SUMMARY:Weekly",
      "DTSTART:20260601T090000Z",
      "DTEND:20260601T091500Z",
      "RRULE:FREQ=WEEKLY;BYDAY=MO",
      "END:VEVENT",
      "END:VCALENDAR",
    );
    const [e] = parseICalendar(src);
    expect(e?.rrule).toBe("FREQ=WEEKLY;BYDAY=MO");
  });

  // DTSTAMP captured
  it("captures DTSTAMP", () => {
    const src = ics(
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:ds-1",
      "SUMMARY:Stamped",
      "DTSTART:20260601T090000Z",
      "DTEND:20260601T091500Z",
      "DTSTAMP:20260601T000000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    );
    const [e] = parseICalendar(src);
    expect(e?.dtstamp).toBe("20260601T000000Z");
  });

  // Empty/blank string → no events
  it("returns [] for empty input", () => {
    expect(parseICalendar("")).toHaveLength(0);
  });

  // Bare \n (LF-only) line endings are also handled
  it("handles LF-only line endings", () => {
    const src = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:lf-1",
      "SUMMARY:LF only",
      "DTSTART:20260601T090000Z",
      "DTEND:20260601T091500Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n");
    const [e] = parseICalendar(src);
    expect(e?.uid).toBe("lf-1");
    expect(e?.summary).toBe("LF only");
  });

  // Tab-based fold continuation
  it("unfolds a line continued with a TAB", () => {
    const src =
      "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:tab-fold-1\r\nSUMMARY:Part one\r\n\tpart two\r\nDTSTART:20260601T090000Z\r\nDTEND:20260601T091500Z\r\nEND:VEVENT\r\nEND:VCALENDAR";
    const [e] = parseICalendar(src);
    expect(e?.summary).toBe("Part onepart two");
  });
});

// ---------------------------------------------------------------------------
// buildVEvent — Task B2 fixtures
// ---------------------------------------------------------------------------

describe("buildVEvent", () => {
  const NOW = "20260601T000000Z";

  it("round-trips through parseICalendar: fields match", () => {
    const input = {
      uid: "build-1",
      summary: "Team Sync",
      start: "20260601T090000Z",
      end: "20260601T091500Z",
      description: "Weekly check-in",
      location: "Conference Room A",
      attendees: ["alice@example.com", "bob@example.com"],
    } as const;
    const icsOutput = buildVEvent(input, NOW);
    const [parsed] = parseICalendar(icsOutput);

    expect(parsed?.uid).toBe("build-1");
    expect(parsed?.summary).toBe("Team Sync");
    expect(parsed?.start).toBe("20260601T090000Z");
    expect(parsed?.end).toBe("20260601T091500Z");
    expect(parsed?.description).toBe("Weekly check-in");
    expect(parsed?.location).toBe("Conference Room A");
    expect(parsed?.attendees).toEqual(["alice@example.com", "bob@example.com"]);
    expect(parsed?.dtstamp).toBe(NOW);
  });

  it("DTSTAMP equals the injected now", () => {
    const icsOutput = buildVEvent(
      { uid: "ts-1", summary: "Test", start: "20260601T090000Z", end: "20260601T091500Z" },
      NOW,
    );
    const [e] = parseICalendar(icsOutput);
    expect(e?.dtstamp).toBe(NOW);
  });

  it("escapes a comma in SUMMARY and parseICalendar unescapes it back", () => {
    const icsOutput = buildVEvent(
      { uid: "comma-1", summary: "Foo, Bar", start: "20260601T090000Z", end: "20260601T091500Z" },
      NOW,
    );
    // Raw ICS must contain the escape sequence
    expect(icsOutput).toContain("SUMMARY:Foo\\, Bar");
    // Parsed value should be unescaped
    const [e] = parseICalendar(icsOutput);
    expect(e?.summary).toBe("Foo, Bar");
  });

  it("escapes a semicolon in SUMMARY", () => {
    const icsOutput = buildVEvent(
      { uid: "semi-1", summary: "A; B", start: "20260601T090000Z", end: "20260601T091500Z" },
      NOW,
    );
    expect(icsOutput).toContain("SUMMARY:A\\; B");
    const [e] = parseICalendar(icsOutput);
    expect(e?.summary).toBe("A; B");
  });

  it("escapes a backslash in SUMMARY", () => {
    const icsOutput = buildVEvent(
      {
        uid: "bs-build-1",
        summary: "path\\to",
        start: "20260601T090000Z",
        end: "20260601T091500Z",
      },
      NOW,
    );
    expect(icsOutput).toContain("SUMMARY:path\\\\to");
    const [e] = parseICalendar(icsOutput);
    expect(e?.summary).toBe("path\\to");
  });

  it("escapes newlines in DESCRIPTION", () => {
    const icsOutput = buildVEvent(
      {
        uid: "nl-1",
        summary: "NL test",
        start: "20260601T090000Z",
        end: "20260601T091500Z",
        description: "line one\nline two",
      },
      NOW,
    );
    expect(icsOutput).toContain("DESCRIPTION:line one\\nline two");
    const [e] = parseICalendar(icsOutput);
    expect(e?.description).toBe("line one\nline two");
  });

  it("omits optional fields when not provided", () => {
    const icsOutput = buildVEvent(
      { uid: "min-1", summary: "Minimal", start: "20260601T090000Z", end: "20260601T091500Z" },
      NOW,
    );
    expect(icsOutput).not.toContain("DESCRIPTION:");
    expect(icsOutput).not.toContain("LOCATION:");
    expect(icsOutput).not.toContain("ATTENDEE:");
  });

  it("includes required VCALENDAR/VEVENT wrapping with CRLF", () => {
    const icsOutput = buildVEvent(
      { uid: "wrap-1", summary: "Wrap", start: "20260601T090000Z", end: "20260601T091500Z" },
      NOW,
    );
    expect(icsOutput.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(icsOutput).toContain("BEGIN:VEVENT\r\n");
    expect(icsOutput).toContain("END:VEVENT\r\n");
    expect(icsOutput).toContain("END:VCALENDAR\r\n");
    expect(icsOutput).toContain("VERSION:2.0\r\n");
  });

  it("emits attendees with mailto: prefix", () => {
    const icsOutput = buildVEvent(
      {
        uid: "att-1",
        summary: "With Attendees",
        start: "20260601T090000Z",
        end: "20260601T091500Z",
        attendees: ["x@test.com", "y@test.com"],
      },
      NOW,
    );
    expect(icsOutput).toContain("ATTENDEE:mailto:x@test.com\r\n");
    expect(icsOutput).toContain("ATTENDEE:mailto:y@test.com\r\n");
  });

  it("round-trips with empty attendees array", () => {
    const icsOutput = buildVEvent(
      {
        uid: "noatt-1",
        summary: "No Attendees",
        start: "20260601T090000Z",
        end: "20260601T091500Z",
        attendees: [],
      },
      NOW,
    );
    expect(icsOutput).not.toContain("ATTENDEE:");
    const [e] = parseICalendar(icsOutput);
    expect(e?.attendees).toEqual([]);
  });
});
