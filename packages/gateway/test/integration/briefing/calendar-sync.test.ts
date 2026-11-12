/**
 * Morning briefing MB2b, end to end over real SQLite: the REAL Google Calendar and Outlook syncables
 * (and iCloud's, for the contract) through the production capability set (`syncTestContext` binds a
 * service the way `sync/scheduler.ts` does), with a fake HTTP layer per provider. Everything runs in
 * this process: production syncables run inside the gateway and start no subprocess.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createAppleSyncable } from "../../../src/connectors/apple-sync.ts";
import {
  createStubVault,
  syncTestContext,
} from "../../../src/connectors/connector-sync-test-helpers.ts";
import {
  createGoogleCalendarSyncable,
  decodeGoogleCalendarCursor,
} from "../../../src/connectors/google-calendar-sync.ts";
import { createOutlookSyncable } from "../../../src/connectors/outlook-sync.ts";
import {
  openMemoryIndexDatabase,
  requestUrlString,
} from "../../../src/testing/bun-test-support.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 5, 30, 12);

const realFetch = globalThis.fetch;
let requests: URL[] = [];
let router: (url: URL) => Response = () => new Response("{}", { status: 404 });

beforeEach(() => {
  requests = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(requestUrlString(input));
    requests.push(url);
    return router(url);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

const tokenJson = (): string =>
  JSON.stringify({ accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 3_600_000 });

/** ONE database and ONE vault holding every provider's credential, as a real install does. */
function setup() {
  const db = openMemoryIndexDatabase();
  const vault = createStubVault({
    "google_calendar.oauth": tokenJson(),
    "microsoft.oauth": tokenJson(),
    "apple.icloud_email": "me@icloud.com",
    "apple.icloud_app_password": "pw",
  });
  const google = (cursor: string | null, now = NOW) =>
    createGoogleCalendarSyncable({ now: () => now, zone: "Europe/London" }).sync(
      syncTestContext(db, vault, "google_calendar"),
      cursor,
    );
  const outlook = (cursor: string | null, now = NOW) =>
    createOutlookSyncable({
      ensureMicrosoftMcpRunning: async () => {},
      now: () => now,
      zone: "Europe/London",
    }).sync(syncTestContext(db, vault, "outlook"), cursor);
  const apple = (ics: string) =>
    createAppleSyncable({
      ensureAppleMcpRunning: async () => {},
      fetchMessages: async () => ({ ok: true, messages: [] }),
      fetchEvents: async () => ({ ok: true, events: [{ calendar: "Home", ics }] }),
    }).sync(syncTestContext(db, vault, "apple"), null);
  return { db, google, outlook, apple };
}

function externalIds(db: { query: (sql: string) => { all: () => unknown[] } }, where: string) {
  return (
    db.query(`SELECT external_id FROM item WHERE ${where} ORDER BY external_id`).all() as {
      external_id: string;
    }[]
  ).map((r) => r.external_id);
}

function gEvent(id: string, hoursFromNow: number, over: Record<string, unknown> = {}) {
  const at = (h: number) => new Date(NOW + h * 3_600_000).toISOString();
  return {
    id,
    status: "confirmed",
    summary: `Roadmap ${id}`,
    start: { dateTime: at(hoursFromNow) },
    end: { dateTime: at(hoursFromNow + 1) },
    organizer: { email: "o@x.com" },
    attendees: [{ self: true, responseStatus: "accepted" }],
    ...over,
  };
}

describe("Google Calendar over real SQLite", () => {
  test("two calendars, an all-day event, a recurring instance and a cancellation converge across syncs, a 410 and a re-anchor", async () => {
    const { db, google: sync } = setup();
    let phase = 1;
    router = (url) => {
      if (url.pathname.endsWith("/calendarList")) {
        return json({ items: [{ id: "me@x.com", primary: true }, { id: "team@x.com" }] });
      }
      const cal = decodeURIComponent(url.pathname.split("/")[4] ?? "");
      if (cal === "me@x.com") {
        if (url.searchParams.has("syncToken")) {
          return phase === 3
            ? json({}, 410)
            : json({
                items: [{ id: "standup", status: "cancelled" }],
                nextSyncToken: "ME2",
              });
        }
        return json({
          items: [
            gEvent("standup", 2),
            gEvent("offsite", 0, { start: { date: "2026-07-01" }, end: { date: "2026-07-02" } }),
          ],
          nextSyncToken: phase === 3 ? "ME3" : "ME1",
        });
      }
      return json({
        items: [gEvent("series_20260701T090000Z", 5, { recurringEventId: "series" })],
        nextSyncToken: "T1",
      });
    };

    const first = await sync(null);
    expect(first.itemsUpserted).toBe(3);
    expect(externalIds(db, "service = 'google_calendar'")).toEqual([
      "me@x.com|offsite",
      "me@x.com|standup",
      "team@x.com|series_20260701T090000Z",
    ]);
    const offsite = db
      .query("SELECT metadata FROM item WHERE external_id = 'me@x.com|offsite'")
      .get() as { metadata: string };
    const meta = JSON.parse(offsite.metadata) as Record<string, unknown>;
    expect(meta["all_day"]).toBe(true);
    expect(meta["start_ms"]).toBe(Date.UTC(2026, 5, 30, 23));
    for (const k of [
      "start_ms",
      "end_ms",
      "status",
      "self_response",
      "organizer_email",
      "attendee_count",
    ]) {
      expect(k in meta, k).toBe(true);
    }
    const fts = db
      .query("SELECT COUNT(*) AS n FROM item_fts WHERE item_fts MATCH 'Roadmap'")
      .get() as { n: number };
    expect(fts.n).toBeGreaterThan(0);

    phase = 2;
    const second = await sync(first.cursor);
    expect(second.itemsDeleted).toBe(1);
    expect(externalIds(db, "service = 'google_calendar'")).toEqual([
      "me@x.com|offsite",
      "team@x.com|series_20260701T090000Z",
    ]);

    // a 410 restarts the calendar in full and converges to the same set the full fetch yields
    phase = 3;
    const third = await sync(second.cursor);
    expect(decodeGoogleCalendarCursor(third.cursor)?.calendars["me@x.com"]?.syncToken).toBe("ME3");
    expect(
      externalIds(db, "service = 'google_calendar' AND external_id LIKE 'me@x.com|%'"),
    ).toEqual(["me@x.com|offsite", "me@x.com|standup"]);

    // 8 days later the window re-anchors and sweeps what is no longer in the new window
    phase = 4;
    const later = NOW + 8 * DAY;
    router = (url) => {
      if (url.pathname.endsWith("/calendarList")) return json({ items: [{ id: "me@x.com" }] });
      return json({ items: [], nextSyncToken: "ME4" });
    };
    const fourth = await sync(third.cursor, later);
    expect(externalIds(db, "service = 'google_calendar'")).toEqual([]);
    expect(fourth.itemsDeleted).toBeGreaterThan(0);
  });
});

describe("Outlook calendar over real SQLite", () => {
  test("an outl3 cursor continues the mail link, a calendar half appears and mail rows survive the calendar sweep", async () => {
    const { db, outlook: sync } = setup();
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
       VALUES ('outlook:old-mail', 'outlook', 'email', 'old-mail', 't', 1, 1)`,
    );
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
       VALUES ('outlook:stale-event', 'outlook', 'event', 'stale-event', 't', 1, 1)`,
    );
    const mailLink = "https://graph.microsoft.com/v1.0/me/messages/delta?$skiptoken=mid";
    const outl3 = `nimbus-outl3:${Buffer.from(JSON.stringify({ v: 1, nextUrl: mailLink })).toString("base64url")}`;
    router = (url) => {
      if (url.pathname.includes("/calendarView/")) {
        return json({
          value: [
            {
              id: "evt1",
              subject: "Planning",
              start: { dateTime: "2026-07-01T08:30:00.0000000", timeZone: "UTC" },
              end: { dateTime: "2026-07-01T09:30:00.0000000", timeZone: "UTC" },
            },
          ],
          "@odata.deltaLink":
            "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=C",
        });
      }
      return json({
        value: [{ id: "new-mail", subject: "s", bodyPreview: "p" }],
        "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/messages/delta?$deltatoken=M",
      });
    };
    const r = await sync(outl3);
    expect(requests[0]?.toString()).toBe(mailLink);
    expect(requests[1]?.pathname).toBe("/v1.0/me/calendarView/delta");
    expect(r.cursor?.startsWith("nimbus-outl4:")).toBe(true);
    expect(externalIds(db, "service = 'outlook' AND type = 'email'")).toEqual([
      "new-mail",
      "old-mail",
    ]);
    expect(externalIds(db, "service = 'outlook' AND type = 'event'")).toEqual(["evt1"]);
  });
});

describe("the normalized contract across providers", () => {
  const KEYS = [
    "all_day",
    "attendee_count",
    "end_ms",
    "organizer_email",
    "self_response",
    "start_ms",
    "status",
  ];

  test("the same wall-clock meeting from Google, Outlook and iCloud gives the same instants and the same seven keys", async () => {
    const { db, google, outlook, apple } = setup();
    const startMs = Date.UTC(2026, 6, 1, 8, 30);
    router = (url) => {
      if (url.pathname.endsWith("/calendarList")) return json({ items: [{ id: "me@x.com" }] });
      if (url.pathname.includes("/calendarView/")) {
        return json({
          value: [
            {
              id: "o1",
              subject: "Sync",
              start: { dateTime: "2026-07-01T08:30:00.0000000", timeZone: "UTC" },
              end: { dateTime: "2026-07-01T09:30:00.0000000", timeZone: "UTC" },
              responseStatus: { response: "accepted" },
              organizer: { emailAddress: { address: "boss@x.com" } },
              attendees: [{}, {}],
            },
          ],
          "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?t=1",
        });
      }
      if (url.pathname.includes("/messages/delta")) {
        return json({ value: [], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/x?t=1" });
      }
      return json({
        items: [
          {
            id: "g1",
            summary: "Sync",
            start: { dateTime: "2026-07-01T09:30:00+01:00" },
            end: { dateTime: "2026-07-01T10:30:00+01:00" },
            organizer: { email: "boss@x.com" },
            attendees: [{ self: true, responseStatus: "accepted" }, { email: "b@x.com" }],
          },
        ],
        nextSyncToken: "S",
      });
    };
    await google(null);
    await outlook(null);
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:a1",
      "SUMMARY:Sync",
      "DTSTART;TZID=Europe/London:20260701T093000",
      "DTEND;TZID=Europe/London:20260701T103000",
      "ORGANIZER:mailto:boss@x.com",
      "ATTENDEE;PARTSTAT=ACCEPTED:mailto:me@icloud.com",
      "ATTENDEE:mailto:b@x.com",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    await apple(ics);

    // The query MB5 will use to union the providers' events.
    const rows = db
      .query(
        `SELECT service, json_extract(metadata, '$.start_ms') AS s, json_extract(metadata, '$.end_ms') AS e,
                metadata
           FROM item WHERE type = 'event' ORDER BY service`,
      )
      .all() as { service: string; s: number; e: number; metadata: string }[];
    expect(rows.map((r) => r.service)).toEqual(["apple", "google_calendar", "outlook"]);
    for (const r of rows) {
      expect(r.s, r.service).toBe(startMs);
      expect(r.e, r.service).toBe(startMs + 3_600_000);
      const meta = JSON.parse(r.metadata) as Record<string, unknown>;
      for (const k of KEYS) expect(k in meta, `${r.service}.${k}`).toBe(true);
      expect(typeof meta["start_ms"]).toBe("number");
      expect(typeof meta["end_ms"]).toBe("number");
      expect(typeof meta["all_day"]).toBe("boolean");
      expect(typeof meta["attendee_count"]).toBe("number");
      // iCloud keeps the raw iCal STATUS, absent (null) when the ICS has none; Google and Outlook always set it
      expect(["string", "object"]).toContain(typeof meta["status"]);
      expect(["accepted", "declined", "tentative", "needs-action", null]).toContain(
        meta["self_response"] as string | null,
      );
      expect(meta["organizer_email"]).toBe("boss@x.com");
    }
  });
});

describe("scoping end to end", () => {
  test("a Google sync never changes an outlook row and an Outlook sweep never changes a google row", async () => {
    const { db, google, outlook } = setup();
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
       VALUES ('outlook:keep-event', 'outlook', 'event', 'keep-event', 't', 1, 1),
              ('outlook:a-mail', 'outlook', 'email', 'a-mail', 't', 1, 1)`,
    );
    router = (url) => {
      if (url.pathname.endsWith("/calendarList")) return json({ items: [{ id: "me@x.com" }] });
      if (url.pathname.includes("/calendarView/")) {
        return json({
          value: [],
          "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?t=1",
        });
      }
      if (url.pathname.includes("/messages/delta")) {
        return json({ value: [], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/x?t=1" });
      }
      return json({ items: [gEvent("g1", 2)], nextSyncToken: "S" });
    };
    await google(null);
    // the Google sweep (its own calendar prefix, its own service) left every outlook row alone
    expect(externalIds(db, "service = 'outlook'")).toEqual(["a-mail", "keep-event"]);
    expect(externalIds(db, "service = 'google_calendar'")).toEqual(["me@x.com|g1"]);

    await outlook(null);
    // the Outlook sweep removed ITS OWN stale event, kept the mail row, and left the google row alone
    expect(externalIds(db, "service = 'outlook'")).toEqual(["a-mail"]);
    expect(externalIds(db, "service = 'google_calendar'")).toEqual(["me@x.com|g1"]);
  });
});
