import { describe, expect, test } from "bun:test";

import {
  parseIcalDurationMs,
  parseIcalDurationParts,
  parseIcalEventExtras,
} from "./ical-event-extras.ts";

const cal = (...vevents: string[]): string =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", ...vevents, "END:VCALENDAR"].join("\r\n");
const ev = (...lines: string[]): string => ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\r\n");

describe("parseIcalEventExtras", () => {
  test("TZID on DTSTART and DTEND", () => {
    const m = parseIcalEventExtras(
      cal(
        ev(
          "UID:u1",
          "DTSTART;TZID=Europe/London:20261111T093000",
          "DTEND;TZID=Europe/London:20261111T103000",
        ),
      ),
    );
    expect(m.get("u1")).toMatchObject({ startTzid: "Europe/London", endTzid: "Europe/London" });
  });

  test("a UTC, floating, and date-valued start carry no TZID", () => {
    const m = parseIcalEventExtras(
      cal(
        ev("UID:a", "DTSTART:20261111T093000Z"),
        ev("UID:b", "DTSTART:20261111T093000"),
        ev("UID:c", "DTSTART;VALUE=DATE:20261111"),
      ),
    );
    for (const k of ["a", "b", "c"]) expect(m.get(k)?.startTzid).toBeUndefined();
  });

  test("DURATION is parsed, a malformed one is not", () => {
    const m = parseIcalEventExtras(
      cal(ev("UID:a", "DURATION:PT1H30M"), ev("UID:b", "DURATION:P1D"), ev("UID:c", "DURATION:x")),
    );
    expect(m.get("a")?.durationMs).toBe(90 * 60_000);
    expect(m.get("b")?.durationMs).toBe(86_400_000);
    expect(m.get("c")?.durationMs).toBeUndefined();
    expect(parseIcalDurationMs("P1W")).toBe(7 * 86_400_000);
    expect(parseIcalDurationMs("PT30S")).toBe(30_000);
    expect(parseIcalDurationMs("-PT1H")).toBeUndefined();
    expect(parseIcalDurationMs("P")).toBeUndefined();
    expect(parseIcalDurationMs("PT")).toBeUndefined();
  });

  test("PARTSTAT survives a quoted parameter holding a colon and a comma", () => {
    const m = parseIcalEventExtras(
      cal(
        ev(
          "UID:u1",
          'ATTENDEE;CN="Last, First: Jr";PARTSTAT=ACCEPTED;ROLE=REQ-PARTICIPANT:mailto:Me@iCloud.com',
          "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:other@x.com",
          "ATTENDEE;PARTSTAT=SOMETHING-ELSE:mailto:odd@x.com",
          "ATTENDEE:mailto:bare@x.com",
        ),
      ),
    );
    const p = m.get("u1")?.partstatByAddress;
    expect(p?.get("me@icloud.com")).toBe("accepted");
    expect(p?.get("other@x.com")).toBe("needs-action");
    expect(p?.has("odd@x.com")).toBe(false);
    expect(p?.has("bare@x.com")).toBe(false);
  });

  test("a master and a RECURRENCE-ID override are keyed uid and uid:recurrence-id", () => {
    const m = parseIcalEventExtras(
      cal(
        ev("UID:u1", "DTSTART;TZID=Europe/London:20261111T093000"),
        ev(
          "UID:u1",
          "RECURRENCE-ID;TZID=Europe/London:20261112T093000",
          "DTSTART;TZID=America/New_York:20261112T100000",
        ),
      ),
    );
    expect(m.get("u1")?.startTzid).toBe("Europe/London");
    expect(m.get("u1:20261112T093000")?.startTzid).toBe("America/New_York");
  });

  test("folded lines are unfolded; a nested VALARM DURATION is ignored; names are case-insensitive", () => {
    const m = parseIcalEventExtras(
      cal(
        ev(
          "uid:u1",
          "dtstart;tzid=Europe/Paris:20261111T0930",
          " 00",
          "BEGIN:VALARM",
          "DURATION:PT5M",
          "TRIGGER:-PT15M",
          "END:VALARM",
          "DURATION:PT2H",
        ),
      ),
    );
    expect(m.get("u1")).toMatchObject({ startTzid: "Europe/Paris", durationMs: 2 * 3_600_000 });
  });

  test("malformed lines are skipped, never thrown; a VEVENT with no UID is dropped", () => {
    const m = parseIcalEventExtras(
      cal(
        ev("UID:u1", "garbage", ";;;", 'ATTENDEE;CN="unterminated:mailto:x@y.com', "DTSTART;X:1"),
        ev("DTSTART:20261111T093000"),
        "END:VEVENT",
      ),
    );
    expect([...m.keys()]).toEqual(["u1"]);
  });

  test("a duplicate key keeps the first", () => {
    const m = parseIcalEventExtras(
      cal(ev("UID:u1", "DTSTART;TZID=A/B:20261111T093000"), ev("UID:u1", "DTSTART;TZID=C/D:1")),
    );
    expect(m.get("u1")?.startTzid).toBe("A/B");
  });

  test("an empty string is an empty map", () => {
    expect(parseIcalEventExtras("").size).toBe(0);
  });
});

describe("parseIcalDurationParts", () => {
  test("splits nominal days (weeks included) from the exact time part", () => {
    expect(parseIcalDurationParts("P1W")).toEqual({ days: 7, ms: 0 });
    expect(parseIcalDurationParts("P1DT2H30M")).toEqual({ days: 1, ms: 9_000_000 });
    expect(parseIcalDurationParts("PT90M")).toEqual({ days: 0, ms: 5_400_000 });
    expect(parseIcalDurationParts("-P1D")).toBeUndefined();
  });
});
