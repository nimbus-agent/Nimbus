import { describe, expect, test } from "bun:test";

import {
  allDayInstants,
  CALENDAR_WINDOW,
  isOutsideWindow,
  normalizedEventKeys,
  normalizeSelfResponse,
  windowEnd,
  windowStartFor,
} from "./calendar-event-normalize.ts";

describe("normalizeSelfResponse", () => {
  test("maps every Google and Graph value onto the four-value set", () => {
    const cases: Array<[string, string]> = [
      ["needsAction", "needs-action"],
      ["accepted", "accepted"],
      ["declined", "declined"],
      ["tentative", "tentative"],
      ["none", "needs-action"],
      ["notResponded", "needs-action"],
      ["organizer", "accepted"],
      ["tentativelyAccepted", "tentative"],
      [" Accepted ", "accepted"],
    ];
    for (const [raw, want] of cases) expect(normalizeSelfResponse(raw), raw).toBe(want as never);
  });

  test("an unknown string and a non-string are null", () => {
    expect(normalizeSelfResponse("maybe")).toBeNull();
    expect(normalizeSelfResponse("toString")).toBeNull();
    expect(normalizeSelfResponse(undefined)).toBeNull();
    expect(normalizeSelfResponse(3)).toBeNull();
  });
});

describe("allDayInstants", () => {
  test("two midnights in the zone", () => {
    const r = allDayInstants("2026-11-12", "2026-11-13", "Europe/London");
    expect(r).toEqual({ startMs: Date.UTC(2026, 10, 12), endMs: Date.UTC(2026, 10, 13) });
    const nz = allDayInstants("2026-11-12", "2026-11-13", "Pacific/Auckland");
    expect(nz?.startMs).toBe(Date.UTC(2026, 10, 11, 11));
  });

  test("the spring-forward and fall-back days span 23 and 25 hours", () => {
    const spring = allDayInstants("2026-03-08", "2026-03-09", "America/New_York");
    expect(((spring?.endMs ?? 0) - (spring?.startMs ?? 0)) / 3_600_000).toBe(23);
    const fall = allDayInstants("2026-11-01", "2026-11-02", "America/New_York");
    expect(((fall?.endMs ?? 0) - (fall?.startMs ?? 0)) / 3_600_000).toBe(25);
  });

  test("a multi-day event spans to the exclusive end", () => {
    const r = allDayInstants("2026-11-12", "2026-11-15", "UTC");
    expect(((r?.endMs ?? 0) - (r?.startMs ?? 0)) / 86_400_000).toBe(3);
  });

  test("a bad zone, a malformed date and an impossible date are undefined", () => {
    expect(allDayInstants("2026-11-12", "2026-11-13", "Not/AZone")).toBeUndefined();
    expect(allDayInstants("20261112", "2026-11-13", "UTC")).toBeUndefined();
    expect(allDayInstants("2026-11-12", "2026-02-30", "UTC")).toBeUndefined();
  });
});

describe("normalizedEventKeys", () => {
  test("returns exactly the seven D-MB-3 keys, with the organizer lower-cased", () => {
    const k = normalizedEventKeys({
      instants: { startMs: 1, endMs: 2 },
      allDay: false,
      status: "confirmed",
      selfResponse: "accepted",
      organizerEmail: " Boss@Example.COM ",
      attendeeCount: 3,
    });
    expect(Object.keys(k).sort()).toEqual([
      "all_day",
      "attendee_count",
      "end_ms",
      "organizer_email",
      "self_response",
      "start_ms",
      "status",
    ]);
    expect(k["organizer_email"]).toBe("boss@example.com");
  });

  test("organizer_email is omitted when absent or blank; the epoch keys when unresolved", () => {
    const blank = normalizedEventKeys({
      allDay: true,
      status: "tentative",
      selfResponse: null,
      organizerEmail: "  ",
      attendeeCount: 0,
    });
    expect(Object.keys(blank).sort()).toEqual([
      "all_day",
      "attendee_count",
      "self_response",
      "status",
    ]);
    expect(blank["self_response"]).toBeNull();
    const none = normalizedEventKeys({
      allDay: false,
      status: "x",
      selfResponse: null,
      attendeeCount: 0,
    });
    expect("organizer_email" in none).toBe(false);
  });
});

describe("the window", () => {
  test("windowStartFor is one day back; windowEnd is 31 days after the start", () => {
    expect(windowStartFor(10 * 86_400_000)).toBe(9 * 86_400_000);
    expect(windowEnd(0)).toBe(31 * 86_400_000);
    expect(CALENDAR_WINDOW.REANCHOR_MS).toBe(7 * 86_400_000);
  });

  test("isOutsideWindow: wholly before or after is outside; an edge overlap is inside", () => {
    const ws = 1_000_000;
    const we = windowEnd(ws);
    expect(isOutsideWindow(ws - 100, ws - 1, ws)).toBe(true);
    expect(isOutsideWindow(ws - 100, ws, ws)).toBe(false);
    expect(isOutsideWindow(we + 1, we + 10, ws)).toBe(true);
    expect(isOutsideWindow(we, we + 10, ws)).toBe(false);
  });
});
