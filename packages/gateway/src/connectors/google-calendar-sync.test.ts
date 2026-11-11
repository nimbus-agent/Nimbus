import { afterEach, describe, expect, test } from "bun:test";

import type { SyncContext } from "../sync/types.ts";
import { UnauthenticatedError } from "../sync/types.ts";
import {
  createOAuthConnectorTestSetup,
  expectPrefixedCursorCodecRoundTrip,
  registerGlobalFetchRestore,
  requestUrlString,
} from "../testing/bun-test-support.ts";
import {
  createGoogleCalendarSyncable,
  decodeGoogleCalendarCursor,
  encodeGoogleCalendarCursor,
  type GoogleCalendarCursorV1,
} from "./google-calendar-sync.ts";
import { GoogleHttpError } from "./google-sync-shared.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);
const WINDOW_START = NOW - DAY;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function gEvent(id: string, hoursFromNow: number, over: Record<string, unknown> = {}) {
  const start = new Date(NOW + hoursFromNow * 3_600_000).toISOString();
  const end = new Date(NOW + (hoursFromNow + 1) * 3_600_000).toISOString();
  return {
    id,
    status: "confirmed",
    summary: `Event ${id}`,
    start: { dateTime: start },
    end: { dateTime: end },
    organizer: { email: "o@x.com" },
    attendees: [{ self: true, responseStatus: "accepted" }],
    updated: "2026-11-10T00:00:00.000Z",
    ...over,
  };
}

type Router = {
  calendars?: (url: URL) => Response;
  events?: Record<string, (url: URL) => Response>;
};

const requests: URL[] = [];

function install(router: Router): void {
  requests.length = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(requestUrlString(input));
    requests.push(url);
    if (url.pathname.endsWith("/users/me/calendarList")) {
      if (router.calendars === undefined) throw new Error("unexpected calendarList");
      return router.calendars(url);
    }
    const m = /\/calendars\/([^/]+)\/events$/.exec(url.pathname);
    const handler = m === null ? undefined : router.events?.[decodeURIComponent(m[1] ?? "")];
    if (handler === undefined) throw new Error(`unexpected fetch: ${url.toString()}`);
    return handler(url);
  }) as typeof fetch;
}

async function setup(zone = "UTC"): Promise<{
  db: Awaited<ReturnType<typeof createOAuthConnectorTestSetup>>["db"];
  ctx: SyncContext;
  warnings: string[];
  run: (
    cursor: string | null,
    now?: number,
  ) => ReturnType<ReturnType<typeof createGoogleCalendarSyncable>["sync"]>;
}> {
  const { db, vault, ctx } = await createOAuthConnectorTestSetup("google", "google_calendar");
  await vault.set(
    "google_calendar.oauth",
    JSON.stringify({
      accessToken: "cal-token",
      refreshToken: "r",
      expiresAt: Date.now() + 3_600_000,
    }),
  );
  const warnings: string[] = [];
  const logged = {
    ...ctx,
    logger: {
      ...ctx.logger,
      warn: (_o: unknown, msg?: string) => {
        warnings.push(msg ?? "");
      },
    } as unknown as SyncContext["logger"],
  };
  const run = (cursor: string | null, now = NOW) =>
    createGoogleCalendarSyncable({ now: () => now, zone }).sync(logged, cursor);
  return { db, ctx: logged, warnings, run };
}

function rows(db: Awaited<ReturnType<typeof setup>>["db"]): string[] {
  return (
    db
      .query("SELECT external_id FROM item WHERE service = 'google_calendar' ORDER BY external_id")
      .all() as { external_id: string }[]
  ).map((r) => r.external_id);
}

function cursorOf(calendars: GoogleCalendarCursorV1["calendars"]): string {
  return encodeGoogleCalendarCursor({ v: 1, calendars });
}

function listOf(...items: Record<string, unknown>[]): (url: URL) => Response {
  return () => json({ items });
}

function eventPages(...pages: Array<{ items: unknown[]; next?: string; sync?: string }>) {
  let i = 0;
  return (): Response => {
    const p = pages[Math.min(i, pages.length - 1)];
    i += 1;
    return json({
      items: p?.items ?? [],
      ...(p?.next === undefined ? {} : { nextPageToken: p.next }),
      ...(p?.sync === undefined ? {} : { nextSyncToken: p.sync }),
    });
  };
}

registerGlobalFetchRestore(afterEach);

describe("Google Calendar cursor codec", () => {
  test("round trip, with page and sync tokens", () => {
    const samples: GoogleCalendarCursorV1[] = [
      { v: 1, calendars: {} },
      {
        v: 1,
        calendars: { a: { windowStart: 1, syncToken: "s" }, b: { windowStart: 2, pageToken: "p" } },
      },
      { v: 1, calendars: { c: { windowStart: 3, syncToken: "s", pageToken: "p" } } },
    ];
    expectPrefixedCursorCodecRoundTrip(
      samples,
      encodeGoogleCalendarCursor,
      decodeGoogleCalendarCursor,
      "nimbus-gcal1:",
    );
  });

  test("none, other prefixes, junk and a wrong version decode to undefined", () => {
    expect(decodeGoogleCalendarCursor(null)).toBeUndefined();
    expect(decodeGoogleCalendarCursor("")).toBeUndefined();
    expect(decodeGoogleCalendarCursor("nimbus-OTHER:abc")).toBeUndefined();
    expect(decodeGoogleCalendarCursor("nimbus-gcal1:%%%")).toBeUndefined();
    expect(
      decodeGoogleCalendarCursor(encodeNimbusJsonCursor("nimbus-gcal1:", { v: 2, calendars: {} })),
    ).toBeUndefined();
    expect(
      decodeGoogleCalendarCursor(encodeNimbusJsonCursor("nimbus-gcal1:", { v: 1 })),
    ).toBeUndefined();
    expect(
      decodeGoogleCalendarCursor(encodeNimbusJsonCursor("nimbus-gcal1:", [1])),
    ).toBeUndefined();
  });

  test("entries with a bad windowStart are ignored; empty tokens are dropped; the map is capped at 20", () => {
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 25; i += 1) many[`c${String(i)}`] = { windowStart: i };
    const dec = decodeGoogleCalendarCursor(
      encodeNimbusJsonCursor("nimbus-gcal1:", {
        v: 1,
        calendars: {
          bad: { windowStart: "x" },
          nan: { syncToken: "s" },
          scalar: 5,
          empty: { windowStart: 1, syncToken: "", pageToken: "" },
        },
      }),
    );
    expect(dec?.calendars).toEqual({ empty: { windowStart: 1 } });
    const capped = decodeGoogleCalendarCursor(
      encodeNimbusJsonCursor("nimbus-gcal1:", { v: 1, calendars: many }),
    );
    expect(Object.keys(capped?.calendars ?? {})).toHaveLength(20);
  });
});

describe("Google Calendar first sync", () => {
  test("lists with minAccessRole=reader, skips unselected, hidden, deleted and pipe ids, primary first", async () => {
    const { db, run } = await setup();
    install({
      calendars: listOf(
        { id: "team@x.com", summary: "Team", selected: true },
        { id: "me@x.com", summary: "Me", primary: true },
        { id: "off@x.com", selected: false },
        { id: "hid@x.com", hidden: true },
        { id: "del@x.com", deleted: true },
        { id: "pipe|id", summary: "pipe" },
        { summary: "no id" },
      ),
      events: {
        "me@x.com": eventPages({ items: [gEvent("e1", 2)], sync: "S-me" }),
        "team@x.com": eventPages({
          items: [gEvent("e2", 3, { status: "tentative" })],
          sync: "S-team",
        }),
      },
    });
    const r = await run(null);
    const list = requests[0];
    expect(list?.searchParams.get("maxResults")).toBe("250");
    expect(list?.searchParams.get("minAccessRole")).toBe("reader");
    expect(
      requests.map((u) =>
        u.pathname.endsWith("/calendarList")
          ? "calendarList"
          : decodeURIComponent(u.pathname.split("/")[4] ?? ""),
      ),
    ).toEqual(["calendarList", "me@x.com", "team@x.com"]);
    expect(r.itemsUpserted).toBe(2);
    expect(r.hasMore).toBe(false);
    expect(rows(db)).toEqual(["me@x.com|e1", "team@x.com|e2"]);
    const meta = JSON.parse(
      (
        db.query("SELECT metadata FROM item WHERE external_id = ?").get("team@x.com|e2") as {
          metadata: string;
        }
      ).metadata,
    ) as Record<string, unknown>;
    for (const k of [
      "start_ms",
      "end_ms",
      "all_day",
      "status",
      "self_response",
      "organizer_email",
      "attendee_count",
    ]) {
      expect(k in meta, k).toBe(true);
    }
    expect(meta["status"]).toBe("tentative");
    expect(meta["calendar_name"]).toBe("Team");
    const dec = decodeGoogleCalendarCursor(r.cursor);
    expect(dec?.calendars["me@x.com"]).toEqual({ windowStart: WINDOW_START, syncToken: "S-me" });
    const ev = requests[1];
    expect(ev?.searchParams.get("timeMin")).toBe(new Date(WINDOW_START).toISOString());
    expect(ev?.searchParams.get("timeMax")).toBe(new Date(WINDOW_START + 31 * DAY).toISOString());
    expect(ev?.searchParams.get("singleEvents")).toBe("true");
    expect(ev?.searchParams.has("orderBy")).toBe(false);
    expect(ev?.searchParams.has("showDeleted")).toBe(false);
    expect(ev?.searchParams.has("syncToken")).toBe(false);
    expect(r.bytesTransferred).toBeGreaterThan(0);
  });

  test("more than 20 selected calendars: 20 are synced, the primary first, and a warning is logged", async () => {
    const { run, warnings } = await setup();
    const cals = Array.from({ length: 22 }, (_, i) => ({ id: `c${String(i)}@x.com` }));
    cals.push({ id: "prim@x.com", primary: true } as never);
    const events: Record<string, (u: URL) => Response> = {};
    for (const c of cals) events[c.id] = eventPages({ items: [], sync: "s" });
    install({ calendars: listOf(...cals), events });
    // 20 calendars exceed the per-run page budget (12): only some are reached, hasMore is set.
    const r = await run(null);
    expect(warnings.some((w) => w.includes("more Google calendars"))).toBe(true);
    expect(requests[1]?.pathname).toContain("prim%40x.com");
    expect(r.hasMore).toBe(true);
  });

  test("a list with a second page logs a warning and is not followed", async () => {
    const { run, warnings } = await setup();
    install({
      calendars: () => json({ items: [], nextPageToken: "more" }),
      events: {},
    });
    await run(null);
    expect(requests).toHaveLength(1);
    expect(warnings.some((w) => w.includes("more than one page"))).toBe(true);
  });

  test("a non-record list body and a non-array items are tolerated", async () => {
    const { run } = await setup();
    install({ calendars: () => json(["x"]) });
    const r = await run(null);
    expect(r.itemsUpserted).toBe(0);
    expect(decodeGoogleCalendarCursor(r.cursor)?.calendars).toEqual({});
  });
});

describe("Google Calendar incremental pass", () => {
  test("sends the syncToken and none of timeMin, timeMax, orderBy; cancelled and out-of-window rows are deleted", async () => {
    const { db, run } = await setup();
    install({
      calendars: listOf({ id: "c@x.com" }),
      events: {
        "c@x.com": eventPages({
          items: [
            gEvent("keep", 1),
            gEvent("cancel", 2),
            gEvent("old", -80),
            gEvent("far", 24 * 40),
          ],
          sync: "S1",
        }),
      },
    });
    await run(null);
    // seed rows that the incremental pass will drop (cancelled, aged out, too far)
    expect(rows(db)).toEqual(["c@x.com|cancel", "c@x.com|keep"]);
    install({
      calendars: listOf({ id: "c@x.com" }),
      events: {
        "c@x.com": eventPages({
          items: [
            { id: "cancel", status: "cancelled" },
            { id: "never-indexed", status: "cancelled" },
            gEvent("keep", 1, { summary: "Renamed" }),
            gEvent("far", 24 * 40),
            gEvent("fresh", 5),
          ],
          sync: "S2",
        }),
      },
    });
    const r = await run(
      cursorOf({ "c@x.com": { windowStart: WINDOW_START, syncToken: "S1" } }),
      NOW + 3_600_000,
    );
    const ev = requests[1];
    expect(ev?.searchParams.get("syncToken")).toBe("S1");
    for (const k of ["timeMin", "timeMax", "orderBy"])
      expect(ev?.searchParams.has(k), k).toBe(false);
    expect(r.itemsDeleted).toBe(1);
    expect(r.itemsUpserted).toBe(2);
    expect(rows(db)).toEqual(["c@x.com|fresh", "c@x.com|keep"]);
    expect(decodeGoogleCalendarCursor(r.cursor)?.calendars["c@x.com"]).toEqual({
      windowStart: WINDOW_START,
      syncToken: "S2",
    });
  });

  test("an event outside the window that is indexed is removed by the incremental pass", async () => {
    const { db, run } = await setup();
    install({
      calendars: listOf({ id: "c@x.com" }),
      events: { "c@x.com": eventPages({ items: [gEvent("moved", 5)], sync: "S1" }) },
    });
    await run(null);
    install({
      calendars: listOf({ id: "c@x.com" }),
      events: { "c@x.com": eventPages({ items: [gEvent("moved", 24 * 45)], sync: "S2" }) },
    });
    const r = await run(cursorOf({ "c@x.com": { windowStart: WINDOW_START, syncToken: "S1" } }));
    expect(r.itemsDeleted).toBe(1);
    expect(rows(db)).toEqual([]);
  });

  test("an incremental page that runs out of budget keeps the sync token and the page token", async () => {
    const { run } = await setup();
    const pages = Array.from({ length: 12 }, (_, i) => ({ items: [], next: `p${String(i)}` }));
    install({
      calendars: listOf({ id: "c@x.com" }),
      events: { "c@x.com": eventPages(...pages) },
    });
    const r = await run(cursorOf({ "c@x.com": { windowStart: WINDOW_START, syncToken: "S1" } }));
    expect(r.hasMore).toBe(true);
    const entry = decodeGoogleCalendarCursor(r.cursor)?.calendars["c@x.com"];
    expect(entry?.syncToken).toBe("S1");
    expect(entry?.pageToken).toBe("p9");
    // resume: the stored page token and sync token are sent together
    install({
      calendars: listOf({ id: "c@x.com" }),
      events: { "c@x.com": eventPages({ items: [], sync: "S2" }) },
    });
    const r2 = await run(r.cursor);
    expect(requests[1]?.searchParams.get("syncToken")).toBe("S1");
    expect(requests[1]?.searchParams.get("pageToken")).toBe("p9");
    expect(r2.hasMore).toBe(false);
    expect(decodeGoogleCalendarCursor(r2.cursor)?.calendars["c@x.com"]?.syncToken).toBe("S2");
  });
});

describe("Google Calendar 410 restart", () => {
  test("drops the entry and re-fetches that calendar in full in the same run; others keep theirs", async () => {
    const { db, run } = await setup();
    let calls = 0;
    install({
      calendars: listOf({ id: "a@x.com" }, { id: "b@x.com" }),
      events: {
        "a@x.com": (url) => {
          calls += 1;
          if (url.searchParams.has("syncToken")) return json({ error: { message: "gone" } }, 410);
          return json({ items: [gEvent("a1", 2)], nextSyncToken: "A2" });
        },
        "b@x.com": eventPages({ items: [], sync: "B2" }),
      },
    });
    const r = await run(
      cursorOf({
        "a@x.com": { windowStart: WINDOW_START, syncToken: "A1" },
        "b@x.com": { windowStart: WINDOW_START, syncToken: "B1" },
      }),
    );
    expect(calls).toBe(2);
    const aRequests = requests.filter((u) => u.pathname.includes("a%40x.com"));
    expect(aRequests[0]?.searchParams.get("syncToken")).toBe("A1");
    expect(aRequests[1]?.searchParams.has("syncToken")).toBe(false);
    expect(aRequests[1]?.searchParams.has("timeMin")).toBe(true);
    expect(rows(db)).toEqual(["a@x.com|a1"]);
    const dec = decodeGoogleCalendarCursor(r.cursor);
    expect(dec?.calendars["a@x.com"]?.syncToken).toBe("A2");
    expect(dec?.calendars["b@x.com"]?.syncToken).toBe("B2");
  });

  test("a second 410 in one run does not loop", async () => {
    const { run } = await setup();
    let calls = 0;
    install({
      calendars: listOf({ id: "a@x.com" }),
      events: {
        "a@x.com": () => {
          calls += 1;
          return json({}, 410);
        },
      },
    });
    await expect(
      run(cursorOf({ "a@x.com": { windowStart: WINDOW_START, syncToken: "A1" } })),
    ).rejects.toBeInstanceOf(GoogleHttpError);
    expect(calls).toBe(2);
  });
});

describe("Google Calendar window re-anchor", () => {
  test("an entry older than 7 days is re-fetched in full with a new window, then swept per calendar", async () => {
    const { db, run } = await setup();
    // seed: stale rows in both calendars, an aged-out one in a, and one in b (not re-anchored this run)
    install({
      calendars: listOf({ id: "a@x.com" }, { id: "b@x.com" }),
      events: {
        "a@x.com": eventPages({
          items: [gEvent("gone-upstream", 3), gEvent("aged", -20), gEvent("kept", 4)],
          sync: "A1",
        }),
        "b@x.com": eventPages({ items: [gEvent("b1", 3)], sync: "B1" }),
      },
    });
    await run(null);
    expect(rows(db)).toEqual([
      "a@x.com|aged",
      "a@x.com|gone-upstream",
      "a@x.com|kept",
      "b@x.com|b1",
    ]);
    const later = NOW + 8 * DAY;
    install({
      calendars: listOf({ id: "a@x.com" }, { id: "b@x.com" }),
      events: {
        "a@x.com": eventPages({ items: [gEvent("kept", 24 * 8 + 4)], sync: "A2" }),
        "b@x.com": eventPages({ items: [], sync: "B2" }),
      },
    });
    const r = await run(
      cursorOf({
        "a@x.com": { windowStart: WINDOW_START, syncToken: "A1" },
        "b@x.com": { windowStart: later - 2 * DAY, syncToken: "B1" },
      }),
      later,
    );
    const aReq = requests.find((u) => u.pathname.includes("a%40x.com"));
    expect(aReq?.searchParams.get("timeMin")).toBe(new Date(later - DAY).toISOString());
    expect(aReq?.searchParams.has("syncToken")).toBe(false);
    const bReq = requests.find((u) => u.pathname.includes("b%40x.com"));
    expect(bReq?.searchParams.get("syncToken")).toBe("B1");
    // a's removed-upstream and aged-out rows are swept; b is untouched
    expect(rows(db)).toEqual(["a@x.com|kept", "b@x.com|b1"]);
    expect(r.itemsDeleted).toBe(2);
    expect(decodeGoogleCalendarCursor(r.cursor)?.calendars["a@x.com"]).toEqual({
      windowStart: later - DAY,
      syncToken: "A2",
    });
  });
});

describe("Google Calendar page cap", () => {
  test("11 pages of a full fetch: 10 drained, the entry keeps pageToken, no sweep; the resume prunes only aged-out rows", async () => {
    const { db, run } = await setup();
    // a stale row that a sweep would remove, and an aged-out one that only the resumed prune removes
    // (seeded by an earlier run, whose window still held it)
    install({
      calendars: listOf({ id: "c@x.com" }),
      events: {
        "c@x.com": eventPages({ items: [gEvent("stale", 3), gEvent("ancient", -50)], sync: "S0" }),
      },
    });
    await run(null, NOW - 3 * DAY);
    expect(rows(db)).toEqual(["c@x.com|ancient", "c@x.com|stale"]);

    const pages = Array.from({ length: 10 }, (_, i) => ({
      items: i === 0 ? [gEvent("p0", 2)] : [],
      next: `t${String(i)}`,
    }));
    install({ calendars: listOf({ id: "c@x.com" }), events: { "c@x.com": eventPages(...pages) } });
    const r = await run(null);
    expect(requests.filter((u) => u.pathname.includes("c%40x.com"))).toHaveLength(10);
    expect(r.hasMore).toBe(true);
    const entry = decodeGoogleCalendarCursor(r.cursor)?.calendars["c@x.com"];
    expect(entry).toEqual({ windowStart: WINDOW_START, pageToken: "t9" });
    // no sweep: the stale row survives the gap
    expect(rows(db)).toContain("c@x.com|stale");

    install({
      calendars: listOf({ id: "c@x.com" }),
      events: { "c@x.com": eventPages({ items: [gEvent("p10", 4)], sync: "S1" }) },
    });
    const r2 = await run(r.cursor);
    const resume = requests.find((u) => u.pathname.includes("c%40x.com"));
    expect(resume?.searchParams.get("pageToken")).toBe("t9");
    expect(resume?.searchParams.get("timeMin")).toBe(new Date(WINDOW_START).toISOString());
    expect(r2.hasMore).toBe(false);
    // prune of end_ms < windowStart only: the ancient row goes, the stale in-window row stays
    expect(rows(db)).toEqual(["c@x.com|p0", "c@x.com|p10", "c@x.com|stale"]);
  });

  test("the shared run budget leaves later calendars for the next run, keeping their entries", async () => {
    const { run } = await setup();
    const cals = Array.from({ length: 4 }, (_, i) => ({ id: `c${String(i)}@x.com` }));
    const events: Record<string, (u: URL) => Response> = {};
    for (const c of cals) {
      events[c.id] = eventPages(
        ...Array.from({ length: 4 }, (_, i) => ({ items: [], next: `n${String(i)}` })),
        { items: [], sync: "done" },
      );
    }
    install({ calendars: listOf(...cals), events });
    const prior = { windowStart: WINDOW_START, syncToken: "old" };
    const r = await run(cursorOf({ "c3@x.com": prior }));
    expect(r.hasMore).toBe(true);
    // 12 pages: c0 takes 5, c1 takes 5, c2 gets 2 (cut), c3 is not reached and keeps its prior entry
    const dec = decodeGoogleCalendarCursor(r.cursor);
    expect(dec?.calendars["c3@x.com"]).toEqual(prior);
    expect(dec?.calendars["c2@x.com"]?.pageToken).toBeDefined();
    expect(requests.filter((u) => u.pathname.includes("events"))).toHaveLength(12);
  });
});

describe("Google Calendar departed calendars", () => {
  test("a calendar that left the selection has its rows deleted and its entry dropped", async () => {
    const { db, run } = await setup();
    install({
      calendars: listOf({ id: "a@x.com" }, { id: "b@x.com" }),
      events: {
        "a@x.com": eventPages({ items: [gEvent("a1", 2)], sync: "A1" }),
        "b@x.com": eventPages({ items: [gEvent("b1", 2)], sync: "B1" }),
      },
    });
    const first = await run(null);
    install({
      calendars: listOf({ id: "a@x.com" }),
      events: { "a@x.com": eventPages({ items: [], sync: "A2" }) },
    });
    const r = await run(first.cursor);
    expect(rows(db)).toEqual(["a@x.com|a1"]);
    expect(r.itemsDeleted).toBe(1);
    expect(Object.keys(decodeGoogleCalendarCursor(r.cursor)?.calendars ?? {})).toEqual(["a@x.com"]);
  });

  test("a failed calendar list throws before anything is removed", async () => {
    const { db, run } = await setup();
    install({
      calendars: listOf({ id: "a@x.com" }),
      events: { "a@x.com": eventPages({ items: [gEvent("a1", 2)], sync: "A1" }) },
    });
    const first = await run(null);
    install({ calendars: () => json({}, 500) });
    await expect(run(first.cursor)).rejects.toBeInstanceOf(GoogleHttpError);
    expect(rows(db)).toEqual(["a@x.com|a1"]);
  });
});

describe("Google Calendar failure isolation", () => {
  test("a 403 and a 404 on one calendar warn and keep its entry; the others sync", async () => {
    const { db, run, warnings } = await setup();
    install({
      calendars: listOf({ id: "a@x.com" }, { id: "b@x.com" }, { id: "c@x.com" }),
      events: {
        "a@x.com": () => json({ error: { message: "forbidden" } }, 403),
        "b@x.com": () => json({ error: { message: "nf" } }, 404),
        "c@x.com": eventPages({ items: [gEvent("c1", 2)], sync: "C1" }),
      },
    });
    const prior = { windowStart: WINDOW_START, syncToken: "A-old" };
    const r = await run(cursorOf({ "a@x.com": prior }));
    expect(rows(db)).toEqual(["c@x.com|c1"]);
    const dec = decodeGoogleCalendarCursor(r.cursor);
    expect(dec?.calendars["a@x.com"]).toEqual(prior);
    expect(dec?.calendars["b@x.com"]).toBeUndefined();
    expect(dec?.calendars["c@x.com"]?.syncToken).toBe("C1");
    expect(warnings.filter((w) => w.includes("refused"))).toHaveLength(2);
    expect(warnings.join(" ")).not.toContain("forbidden");
  });

  test("a 429 and a 500 rethrow; a 401 is an UnauthenticatedError", async () => {
    for (const status of [429, 500]) {
      const { run } = await setup();
      install({
        calendars: listOf({ id: "a@x.com" }),
        events: { "a@x.com": () => json({}, status) },
      });
      await expect(run(null), String(status)).rejects.toMatchObject({ status });
    }
    const { run } = await setup();
    install({ calendars: listOf({ id: "a@x.com" }), events: { "a@x.com": () => json({}, 401) } });
    await expect(run(null)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  test("the same event id in two calendars yields two rows; cancelling it in one leaves the other", async () => {
    const { db, run } = await setup();
    install({
      calendars: listOf({ id: "a@x.com" }, { id: "b@x.com" }),
      events: {
        "a@x.com": eventPages({ items: [gEvent("same", 2)], sync: "A1" }),
        "b@x.com": eventPages({ items: [gEvent("same", 2)], sync: "B1" }),
      },
    });
    const first = await run(null);
    expect(rows(db)).toEqual(["a@x.com|same", "b@x.com|same"]);
    install({
      calendars: listOf({ id: "a@x.com" }, { id: "b@x.com" }),
      events: {
        "a@x.com": eventPages({ items: [{ id: "same", status: "cancelled" }], sync: "A2" }),
        "b@x.com": eventPages({ items: [], sync: "B2" }),
      },
    });
    await run(first.cursor);
    expect(rows(db)).toEqual(["b@x.com|same"]);
  });
});

describe("Google Calendar syncable shape", () => {
  test("declares its service, a 5 minute interval, and takes no mesh option", () => {
    const s = createGoogleCalendarSyncable();
    expect(s.serviceId).toBe("google_calendar");
    expect(s.defaultIntervalMs).toBe(5 * 60 * 1000);
    expect(createGoogleCalendarSyncable.length).toBeLessThanOrEqual(1);
  });

  test("defaults the clock and the zone", async () => {
    const { ctx } = await setup();
    install({ calendars: listOf() });
    const r = await createGoogleCalendarSyncable().sync(ctx, null);
    expect(r.itemsUpserted).toBe(0);
  });

  test("an unconfigured vault throws the not-configured error and makes no request", async () => {
    const { db: _db, ctx } = await (async () => {
      const { db, ctx: c } = await createOAuthConnectorTestSetup("google", "google_calendar");
      return { db, ctx: c };
    })();
    // only the shared key exists: Calendar is own-key-only, so it is not configured
    install({});
    await expect(createGoogleCalendarSyncable().sync(ctx, null)).rejects.toThrow(/not configured/);
    expect(requests).toHaveLength(0);
  });
});
