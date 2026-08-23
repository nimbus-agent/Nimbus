import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { parseICalendar } from "@nimbus-dev/sdk";
import { resetConnectorModeForTests, setConnectorMode } from "../../shared/connector-mode.ts";
import type { CalDavClient, CalendarRef } from "../src/caldav-core.ts";
import { registerAppleCalendarTools } from "../src/calendar-tools.ts";

// These cases exercise the TOOL SURFACE, not the consent gate, and pass a minimal fake server.
// Gateway mode is the shape they were written against: the connector registers everything and
// executor.ts (I2) is the gate there. Reset on BOTH sides — bun test runs many files in ONE
// process, so an unreset lock would change every file that runs after this one.
beforeEach(() => {
  resetConnectorModeForTests();
  setConnectorMode("gateway");
});
afterEach(() => {
  resetConnectorModeForTests();
});

// ---------------------------------------------------------------------------
// Stub MCP server (mirrors tools.test.ts pattern)
// ---------------------------------------------------------------------------

function stubServer() {
  const tools: Record<string, (input: unknown) => Promise<unknown>> = {};
  return {
    server: {
      // The consent kit registers through `registerTool`, which returns a handle; the deprecated
      // `tool` below is what the read tools still use. Both record into the same map.
      registerTool: (
        name: string,
        _cfg: unknown,
        cb: (i: unknown) => Promise<unknown>,
      ): { disable: () => void } => {
        tools[name] = cb;
        return { disable: () => undefined };
      },
      tool: (
        name: string,
        _desc: string,
        _schema: unknown,
        cb: (i: unknown) => Promise<unknown>,
      ) => {
        tools[name] = cb;
      },
    },
    tools,
  };
}

/** Parse the JSON payload from an mcpJsonResult content envelope. */
function parseResult(result: unknown): unknown {
  if (
    typeof result === "object" &&
    result !== null &&
    "content" in result &&
    Array.isArray((result as { content: unknown[] }).content)
  ) {
    const first = (result as { content: { type: string; text: string }[] }).content[0];
    if (first?.type === "text") {
      return JSON.parse(first.text) as unknown;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Fake CalDavClient
// ---------------------------------------------------------------------------

const WORK_CAL: CalendarRef = {
  url: "https://caldav.icloud.com/calendars/work",
  displayName: "Work",
};
const HOME_CAL: CalendarRef = {
  url: "https://caldav.icloud.com/calendars/home",
  displayName: "Home",
};

const LONG_NOTES = "N".repeat(5000);
const CAPPED_NOTES_LEN = 2000;

function makeFakeCalDavClient(overrides?: Partial<CalDavClient>): {
  client: CalDavClient;
  putCalls: { cal: CalendarRef; uid: string; ics: string }[];
  deleteCalls: string[];
} {
  const putCalls: { cal: CalendarRef; uid: string; ics: string }[] = [];
  const deleteCalls: string[] = [];

  const client: CalDavClient = {
    listCalendars: async () => [WORK_CAL, HOME_CAL],
    listEvents: async (cal) => {
      if (cal.displayName === "Work") {
        return [
          {
            href: "/calendars/work/event1.ics",
            event: {
              uid: "event-1",
              recurrenceId: null,
              summary: "Standup",
              description: LONG_NOTES,
              location: "Room 4",
              start: "20260601T090000Z",
              end: "20260601T091500Z",
              allDay: false,
              status: "CONFIRMED",
              organizer: "boss@icloud.com",
              attendees: ["a@icloud.com", "b@icloud.com"],
              rrule: null,
              dtstamp: "20260601T000000Z",
            },
          },
        ];
      }
      if (cal.displayName === "Home") {
        return [
          {
            href: "/calendars/home/event2.ics",
            event: {
              uid: "event-2",
              recurrenceId: null,
              summary: "Dinner",
              description: "Family dinner",
              location: null,
              start: "20260601T190000Z",
              end: "20260601T210000Z",
              allDay: false,
              status: null,
              organizer: null,
              attendees: ["sister@example.com"],
              rrule: null,
              dtstamp: "20260601T000000Z",
            },
          },
        ];
      }
      return [];
    },
    putEvent: async (cal, uid, ics) => {
      putCalls.push({ cal, uid, ics });
      return { href: `/calendars/${cal.displayName.toLowerCase()}/${uid}.ics` };
    },
    deleteEvent: async (href) => {
      deleteCalls.push(href);
    },
    ...overrides,
  };

  return { client, putCalls, deleteCalls };
}

// ---------------------------------------------------------------------------
// apple_calendar_list
// ---------------------------------------------------------------------------

describe("apple_calendar_list", () => {
  it("returns events from all calendars with attendees included", async () => {
    const { client } = makeFakeCalDavClient();
    const { server, tools } = stubServer();

    registerAppleCalendarTools(server as never, {
      calendar: client,
      now: () => "20260601T000000Z",
    });

    const result = parseResult(
      await tools.apple_calendar_list({
        startUtc: "20260601T000000Z",
        endUtc: "20260601T235959Z",
      }),
    ) as { items: unknown[] };

    expect(result.items).toHaveLength(2);

    const first = result.items[0] as {
      uid: string;
      summary: string;
      attendees: string[];
      notes: string;
      calendar: string;
    };
    expect(first.uid).toBe("event-1");
    expect(first.summary).toBe("Standup");
    expect(first.attendees).toEqual(["a@icloud.com", "b@icloud.com"]);
    expect(first.calendar).toBe("Work");

    const second = result.items[1] as {
      uid: string;
      attendees: string[];
      calendar: string;
    };
    expect(second.uid).toBe("event-2");
    expect(second.attendees).toEqual(["sister@example.com"]);
    expect(second.calendar).toBe("Home");
  });

  it("caps event notes (description) at 2000 chars", async () => {
    const { client } = makeFakeCalDavClient();
    const { server, tools } = stubServer();

    registerAppleCalendarTools(server as never, {
      calendar: client,
      now: () => "20260601T000000Z",
    });

    const result = parseResult(
      await tools.apple_calendar_list({
        startUtc: "20260601T000000Z",
        endUtc: "20260601T235959Z",
      }),
    ) as { items: { notes: string }[] };

    // The first event has a 5000-char description — must be capped at 2000.
    expect(result.items[0]?.notes.length).toBeLessThanOrEqual(CAPPED_NOTES_LEN);
    expect(result.items[0]?.notes).toHaveLength(CAPPED_NOTES_LEN);
  });

  it("filters to the requested calendar when calendar arg is supplied", async () => {
    const { client } = makeFakeCalDavClient();
    const { server, tools } = stubServer();

    registerAppleCalendarTools(server as never, {
      calendar: client,
      now: () => "20260601T000000Z",
    });

    const result = parseResult(
      await tools.apple_calendar_list({
        startUtc: "20260601T000000Z",
        endUtc: "20260601T235959Z",
        calendar: "Work",
      }),
    ) as { items: { calendar: string }[] };

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.calendar).toBe("Work");
  });
});

// ---------------------------------------------------------------------------
// apple_calendar_event_create
// ---------------------------------------------------------------------------

describe("apple_calendar_event_create", () => {
  it("calls putEvent with a valid ICS and returns uid + href", async () => {
    const { client, putCalls } = makeFakeCalDavClient();
    const { server, tools } = stubServer();

    registerAppleCalendarTools(server as never, {
      calendar: client,
      now: () => "20260601T000000Z",
    });

    const result = parseResult(
      await tools.apple_calendar_event_create({
        summary: "Team Meeting",
        start: "20260601T100000Z",
        end: "20260601T110000Z",
        uid: "test-uid-123",
      }),
    ) as { uid: string; href: string };

    expect(result.uid).toBe("test-uid-123");
    expect(result.href).toBeTruthy();
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0]?.uid).toBe("test-uid-123");
  });

  it("produces an ICS that round-trips through parseICalendar", async () => {
    const { client, putCalls } = makeFakeCalDavClient();
    const { server, tools } = stubServer();

    registerAppleCalendarTools(server as never, {
      calendar: client,
      now: () => "20260601T000000Z",
    });

    await tools.apple_calendar_event_create({
      summary: "Round-trip Test",
      start: "20260602T140000Z",
      end: "20260602T150000Z",
      description: "Check escaping",
      location: "Online",
      attendees: ["alice@example.com", "bob@example.com"],
      uid: "rt-uid-456",
    });

    expect(putCalls).toHaveLength(1);
    const ics = putCalls[0]?.ics ?? "";

    // The ICS must be valid and parse back to the original fields.
    const events = parseICalendar(ics);
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev?.uid).toBe("rt-uid-456");
    expect(ev?.summary).toBe("Round-trip Test");
    expect(ev?.start).toBe("20260602T140000Z");
    expect(ev?.end).toBe("20260602T150000Z");
    expect(ev?.description).toBe("Check escaping");
    expect(ev?.location).toBe("Online");
    expect(ev?.attendees).toEqual(["alice@example.com", "bob@example.com"]);
  });

  it("targets the specified calendar when calendar arg is supplied", async () => {
    const { client, putCalls } = makeFakeCalDavClient();
    const { server, tools } = stubServer();

    registerAppleCalendarTools(server as never, {
      calendar: client,
      now: () => "20260601T000000Z",
    });

    await tools.apple_calendar_event_create({
      summary: "Home Task",
      start: "20260603T080000Z",
      end: "20260603T090000Z",
      calendar: "Home",
      uid: "home-uid-789",
    });

    expect(putCalls).toHaveLength(1);
    expect(putCalls[0]?.cal.displayName).toBe("Home");
  });

  it("generates a uid when none is supplied", async () => {
    const { client, putCalls } = makeFakeCalDavClient();
    const { server, tools } = stubServer();

    registerAppleCalendarTools(server as never, {
      calendar: client,
      now: () => "20260601T120000Z",
    });

    const result = parseResult(
      await tools.apple_calendar_event_create({
        summary: "Auto UID Event",
        start: "20260604T100000Z",
        end: "20260604T110000Z",
      }),
    ) as { uid: string };

    expect(result.uid).toBeTruthy();
    expect(result.uid.length).toBeGreaterThan(0);
    expect(putCalls[0]?.uid).toBe(result.uid);
  });

  it("throws when the specified calendar does not exist", async () => {
    const { client } = makeFakeCalDavClient();
    const { server, tools } = stubServer();

    registerAppleCalendarTools(server as never, {
      calendar: client,
      now: () => "20260601T000000Z",
    });

    await expect(
      tools.apple_calendar_event_create({
        summary: "Orphan",
        start: "20260601T100000Z",
        end: "20260601T110000Z",
        calendar: "NonExistent",
        uid: "orphan-uid",
      }),
    ).rejects.toThrow('Calendar "NonExistent" not found');
  });
});

// ---------------------------------------------------------------------------
// apple_calendar_event_delete
// ---------------------------------------------------------------------------

describe("apple_calendar_event_delete", () => {
  it("calls deleteEvent with the provided href and returns { deleted: true }", async () => {
    const { client, deleteCalls } = makeFakeCalDavClient();
    const { server, tools } = stubServer();

    registerAppleCalendarTools(server as never, {
      calendar: client,
      now: () => "20260601T000000Z",
    });

    const result = parseResult(
      await tools.apple_calendar_event_delete({
        href: "/calendars/work/event1.ics",
      }),
    ) as { deleted: boolean };

    expect(result.deleted).toBe(true);
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]).toBe("/calendars/work/event1.ics");
  });

  it("propagates errors from deleteEvent", async () => {
    const { client } = makeFakeCalDavClient({
      deleteEvent: async () => {
        throw new Error("404 Not Found");
      },
    });
    const { server, tools } = stubServer();

    registerAppleCalendarTools(server as never, {
      calendar: client,
      now: () => "20260601T000000Z",
    });

    await expect(
      tools.apple_calendar_event_delete({ href: "/calendars/work/gone.ics" }),
    ).rejects.toThrow("404 Not Found");
  });
});
