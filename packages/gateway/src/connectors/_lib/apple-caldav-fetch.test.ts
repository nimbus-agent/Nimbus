/**
 * Unit tests for apple-caldav-fetch.ts (F3 — gateway CalDAV fetch layer).
 *
 * Coverage targets:
 *  - fetchAppleCalendarEvents: fake transport → ok result
 *  - fetchAppleCalendarEvents: throwing transport → ok:false error result
 *  - selectCalendars: include list takes precedence
 *  - selectCalendars: exclude list applied when include absent
 *  - selectCalendars: both empty → all calendars returned
 *  - computeCalWindow: correct start/end computation
 *  - loadCalConfig: null when creds absent
 *  - loadCalConfig: returns config with defaults when only creds set
 *  - loadCalConfig: respects overridden window/selection vault keys
 */
import { describe, expect, test } from "bun:test";
import {
  createMemoryIndexDb,
  createStubVault,
  syncTestContext,
} from "../connector-sync-test-helpers.ts";
import {
  type AppleCalConfig,
  type CalDavBootstrap,
  type CalDavObject,
  type CalDavTransport,
  collectCalDavEvents,
  computeCalWindow,
  fetchAppleCalendarEvents,
  loadCalConfig,
  selectCalendars,
} from "./apple-caldav-fetch.ts";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const BASE_CONFIG: AppleCalConfig = {
  email: "user@icloud.com",
  appPw: "xxxx-yyyy-zzzz-aaaa",
  windowPastDays: 90,
  windowFutureDays: 365,
  maxInstancesPerCalendar: 1000,
};

const WINDOW = { startUtc: "2026-03-01T00:00:00.000Z", endUtc: "2027-06-01T00:00:00.000Z" };

const FIXTURE_ICS_WORK = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "UID:event-work-1",
  "SUMMARY:Work meeting",
  "DTSTART:20260601T090000Z",
  "DTEND:20260601T100000Z",
  "DTSTAMP:20260531T080000Z",
  "ATTENDEE:mailto:colleague@example.com",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const FIXTURE_ICS_PERSONAL = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "UID:event-personal-1",
  "SUMMARY:Doctor appointment",
  "DTSTART:20260602T140000Z",
  "DTEND:20260602T150000Z",
  "DTSTAMP:20260531T090000Z",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

// ─── fetchAppleCalendarEvents ─────────────────────────────────────────────────

describe("fetchAppleCalendarEvents", () => {
  test("fake transport returning two calendars → ok:true with both entries", async () => {
    const fakeTransport: CalDavTransport = async (_config, _window) => [
      { calendar: "Work", ics: FIXTURE_ICS_WORK },
      { calendar: "Personal", ics: FIXTURE_ICS_PERSONAL },
    ];

    const result = await fetchAppleCalendarEvents(BASE_CONFIG, WINDOW, fakeTransport);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.events).toHaveLength(2);
    expect(result.events[0]?.calendar).toBe("Work");
    expect(result.events[0]?.ics).toContain("Work meeting");
    expect(result.events[1]?.calendar).toBe("Personal");
    expect(result.events[1]?.ics).toContain("Doctor appointment");
  });

  test("throwing transport → ok:false with error message", async () => {
    const throwingTransport: CalDavTransport = async () => {
      throw new Error("CalDAV connection refused");
    };

    const result = await fetchAppleCalendarEvents(BASE_CONFIG, WINDOW, throwingTransport);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("connection refused");
  });

  test("transport throwing a non-Error object → ok:false with stringified error", async () => {
    const throwingTransport: CalDavTransport = async () => {
      // Intentionally throw a non-Error to exercise the String(err) catch arm.
      throw "network timeout";
    };

    const result = await fetchAppleCalendarEvents(BASE_CONFIG, WINDOW, throwingTransport);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toBe("network timeout");
  });

  test("fake transport returning empty list → ok:true with empty events", async () => {
    const emptyTransport: CalDavTransport = async () => [];
    const result = await fetchAppleCalendarEvents(BASE_CONFIG, WINDOW, emptyTransport);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.events).toHaveLength(0);
  });
});

// ─── collectCalDavEvents (orchestration over an injected bootstrap) ───────────

describe("collectCalDavEvents", () => {
  /** Build a fake bootstrap that records login + serves per-calendar objects. */
  function fakeBootstrap(
    calendars: { url: string; displayName?: string }[],
    objectsByCal: Record<string, CalDavObject[]>,
  ): CalDavBootstrap & { loggedIn: boolean; windows: { start: string; end: string }[] } {
    const recorder = {
      loggedIn: false,
      windows: [] as { start: string; end: string }[],
      login: async (): Promise<void> => {
        recorder.loggedIn = true;
      },
      fetchCalendars: async () => calendars,
      fetchCalendarObjects: async ({
        calendar,
        timeRange,
        expand,
      }: {
        calendar: { url: string; displayName?: string };
        timeRange: { start: string; end: string };
        expand: boolean;
      }): Promise<CalDavObject[]> => {
        expect(expand).toBe(true);
        recorder.windows.push(timeRange);
        return objectsByCal[calendar.displayName ?? calendar.url] ?? [];
      },
    };
    return recorder;
  }

  test("logs in, selects calendars, and returns expanded ICS per calendar", async () => {
    const boot = fakeBootstrap(
      [
        { url: "https://c/work", displayName: "Work" },
        { url: "https://c/personal", displayName: "Personal" },
      ],
      {
        Work: [{ url: "https://c/work/1.ics", data: FIXTURE_ICS_WORK }],
        Personal: [{ url: "https://c/personal/1.ics", data: FIXTURE_ICS_PERSONAL }],
      },
    );
    const events = await collectCalDavEvents(boot, BASE_CONFIG, WINDOW);
    expect(boot.loggedIn).toBe(true);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ calendar: "Work", ics: FIXTURE_ICS_WORK });
    expect(events[1]).toEqual({ calendar: "Personal", ics: FIXTURE_ICS_PERSONAL });
    expect(boot.windows[0]).toEqual({ start: WINDOW.startUtc, end: WINDOW.endUtc });
  });

  test("honours the include selection (skips unselected calendars)", async () => {
    const boot = fakeBootstrap(
      [
        { url: "https://c/work", displayName: "Work" },
        { url: "https://c/personal", displayName: "Personal" },
      ],
      {
        Work: [{ url: "https://c/work/1.ics", data: FIXTURE_ICS_WORK }],
        Personal: [{ url: "https://c/personal/1.ics", data: FIXTURE_ICS_PERSONAL }],
      },
    );
    const events = await collectCalDavEvents(
      boot,
      { ...BASE_CONFIG, includeCalendars: ["Work"] },
      WINDOW,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.calendar).toBe("Work");
  });

  test("falls back to calendar.url when displayName is absent", async () => {
    const boot = fakeBootstrap([{ url: "https://c/unnamed" }], {
      "https://c/unnamed": [{ url: "https://c/unnamed/1.ics", data: FIXTURE_ICS_WORK }],
    });
    const events = await collectCalDavEvents(boot, BASE_CONFIG, WINDOW);
    expect(events).toHaveLength(1);
    expect(events[0]?.calendar).toBe("https://c/unnamed");
  });

  test("skips objects with empty / non-string data", async () => {
    const boot = fakeBootstrap([{ url: "https://c/work", displayName: "Work" }], {
      Work: [
        { url: "https://c/work/1.ics", data: "   " },
        { url: "https://c/work/2.ics", data: 42 },
        { url: "https://c/work/3.ics" },
        { url: "https://c/work/4.ics", data: FIXTURE_ICS_WORK },
      ],
    });
    const events = await collectCalDavEvents(boot, BASE_CONFIG, WINDOW);
    expect(events).toHaveLength(1);
    expect(events[0]?.ics).toBe(FIXTURE_ICS_WORK);
  });

  test("caps returned objects at maxInstancesPerCalendar", async () => {
    const boot = fakeBootstrap([{ url: "https://c/work", displayName: "Work" }], {
      Work: [
        { url: "https://c/work/1.ics", data: FIXTURE_ICS_WORK },
        { url: "https://c/work/2.ics", data: FIXTURE_ICS_WORK },
        { url: "https://c/work/3.ics", data: FIXTURE_ICS_WORK },
      ],
    });
    const events = await collectCalDavEvents(
      boot,
      { ...BASE_CONFIG, maxInstancesPerCalendar: 2 },
      WINDOW,
    );
    expect(events).toHaveLength(2);
  });
});

// ─── selectCalendars ──────────────────────────────────────────────────────────

describe("selectCalendars", () => {
  const ALL = [
    { url: "https://caldav.icloud.com/1/work", displayName: "Work" },
    { url: "https://caldav.icloud.com/1/personal", displayName: "Personal" },
    { url: "https://caldav.icloud.com/1/family", displayName: "Family" },
  ];

  test("both empty → all calendars returned", () => {
    const result = selectCalendars(ALL, {});
    expect(result).toHaveLength(3);
  });

  test("include list → only matching calendars", () => {
    const result = selectCalendars(ALL, { include: ["Work", "Family"] });
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.displayName)).toEqual(["Work", "Family"]);
  });

  test("include takes precedence over exclude", () => {
    const result = selectCalendars(ALL, { include: ["Work"], exclude: ["Work", "Personal"] });
    expect(result).toHaveLength(1);
    expect(result[0]?.displayName).toBe("Work");
  });

  test("exclude list → all except excluded", () => {
    const result = selectCalendars(ALL, { exclude: ["Personal"] });
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.displayName)).toEqual(["Work", "Family"]);
  });

  test("include list with no match → empty result", () => {
    const result = selectCalendars(ALL, { include: ["Nonexistent"] });
    expect(result).toHaveLength(0);
  });

  test("calendar without displayName is excluded by include filter", () => {
    const withNoName = [...ALL, { url: "https://caldav.icloud.com/1/unnamed" }];
    const result = selectCalendars(withNoName, { include: ["Work"] });
    expect(result).toHaveLength(1);
    expect(result[0]?.displayName).toBe("Work");
  });

  test("calendar without displayName passes exclude filter (no displayName to exclude)", () => {
    const withNoName = [{ url: "https://caldav.icloud.com/1/unnamed" }, ...ALL];
    const result = selectCalendars(withNoName, { exclude: ["Work"] });
    // unnamed has no displayName so it passes; Personal and Family also pass
    expect(result).toHaveLength(3);
  });

  test("empty include array (not undefined) → all returned (treated as absent)", () => {
    const result = selectCalendars(ALL, { include: [] });
    expect(result).toHaveLength(3);
  });

  test("empty exclude array (not undefined) → all returned", () => {
    const result = selectCalendars(ALL, { exclude: [] });
    expect(result).toHaveLength(3);
  });
});

// ─── computeCalWindow ─────────────────────────────────────────────────────────

describe("computeCalWindow", () => {
  test("produces correct start and end ISO strings", () => {
    const nowMs = Date.parse("2026-06-21T00:00:00.000Z");
    const result = computeCalWindow({ windowPastDays: 90, windowFutureDays: 365 }, nowMs);

    const expectedStart = new Date(nowMs - 90 * 86_400_000).toISOString();
    const expectedEnd = new Date(nowMs + 365 * 86_400_000).toISOString();
    expect(result.startUtc).toBe(expectedStart);
    expect(result.endUtc).toBe(expectedEnd);
  });

  test("zero past days → start equals now", () => {
    const nowMs = Date.parse("2026-06-21T00:00:00.000Z");
    const result = computeCalWindow({ windowPastDays: 0, windowFutureDays: 1 }, nowMs);
    expect(result.startUtc).toBe(new Date(nowMs).toISOString());
  });
});

// ─── loadCalConfig ────────────────────────────────────────────────────────────

describe("loadCalConfig", () => {
  test("returns null when icloud_email is absent", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({
      "apple.icloud_email": null,
      "apple.icloud_app_password": "xxxx-yyyy-zzzz-aaaa",
    });
    const result = await loadCalConfig(syncTestContext(db, vault, "apple"));
    expect(result).toBeNull();
  });

  test("returns null when icloud_app_password is absent", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({
      "apple.icloud_email": "user@icloud.com",
      "apple.icloud_app_password": null,
    });
    const result = await loadCalConfig(syncTestContext(db, vault, "apple"));
    expect(result).toBeNull();
  });

  test("returns null when icloud_email is empty string", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({
      "apple.icloud_email": "",
      "apple.icloud_app_password": "xxxx-yyyy-zzzz-aaaa",
    });
    const result = await loadCalConfig(syncTestContext(db, vault, "apple"));
    expect(result).toBeNull();
  });

  test("returns config with default window/limits when only creds present", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({
      "apple.icloud_email": "user@icloud.com",
      "apple.icloud_app_password": "xxxx-yyyy-zzzz-aaaa",
    });
    const result = await loadCalConfig(syncTestContext(db, vault, "apple"));
    expect(result).not.toBeNull();
    expect(result?.email).toBe("user@icloud.com");
    expect(result?.appPw).toBe("xxxx-yyyy-zzzz-aaaa");
    expect(result?.windowPastDays).toBe(90);
    expect(result?.windowFutureDays).toBe(365);
    expect(result?.maxInstancesPerCalendar).toBe(1000);
    expect(result?.includeCalendars).toBeUndefined();
    expect(result?.excludeCalendars).toBeUndefined();
  });

  test("respects overridden window vault keys", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({
      "apple.icloud_email": "user@icloud.com",
      "apple.icloud_app_password": "xxxx-yyyy-zzzz-aaaa",
      "apple.cal_window_past_days": "30",
      "apple.cal_window_future_days": "180",
      "apple.cal_max_instances": "500",
    });
    const result = await loadCalConfig(syncTestContext(db, vault, "apple"));
    expect(result?.windowPastDays).toBe(30);
    expect(result?.windowFutureDays).toBe(180);
    expect(result?.maxInstancesPerCalendar).toBe(500);
  });

  test("parses include_calendars from comma-separated vault key", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({
      "apple.icloud_email": "user@icloud.com",
      "apple.icloud_app_password": "xxxx-yyyy-zzzz-aaaa",
      "apple.cal_include_calendars": "Work, Personal",
    });
    const result = await loadCalConfig(syncTestContext(db, vault, "apple"));
    expect(result?.includeCalendars).toEqual(["Work", "Personal"]);
  });

  test("parses exclude_calendars from comma-separated vault key", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({
      "apple.icloud_email": "user@icloud.com",
      "apple.icloud_app_password": "xxxx-yyyy-zzzz-aaaa",
      "apple.cal_exclude_calendars": "Holidays,Birthdays",
    });
    const result = await loadCalConfig(syncTestContext(db, vault, "apple"));
    expect(result?.excludeCalendars).toEqual(["Holidays", "Birthdays"]);
  });

  test("invalid window_past_days falls back to default 90", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({
      "apple.icloud_email": "user@icloud.com",
      "apple.icloud_app_password": "xxxx-yyyy-zzzz-aaaa",
      "apple.cal_window_past_days": "not-a-number",
    });
    const result = await loadCalConfig(syncTestContext(db, vault, "apple"));
    expect(result?.windowPastDays).toBe(90);
  });

  test("negative window_past_days falls back to default 90", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({
      "apple.icloud_email": "user@icloud.com",
      "apple.icloud_app_password": "xxxx-yyyy-zzzz-aaaa",
      "apple.cal_window_past_days": "-5",
    });
    const result = await loadCalConfig(syncTestContext(db, vault, "apple"));
    expect(result?.windowPastDays).toBe(90);
  });
});
