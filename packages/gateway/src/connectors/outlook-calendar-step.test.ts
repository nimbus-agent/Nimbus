import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { upsertIndexedItem } from "../index/item-store.ts";
import type { SyncContext } from "../sync/types.ts";
import {
  createOAuthConnectorTestSetup,
  registerGlobalFetchRestore,
  requestUrlString,
} from "../testing/bun-test-support.ts";
import {
  type CalendarStepResult,
  type OutlookCalendarCursor,
  runOutlookCalendarStep,
} from "./outlook-calendar-step.ts";

const DAY = 86_400_000;
const MIN = 60_000;
const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);
const WINDOW_START = NOW - DAY;
const DELTA = "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=D1";

registerGlobalFetchRestore(afterEach);

type Seen = { url: URL; headers: Record<string, string> };
const seen: Seen[] = [];

function evt(id: string, hoursFromNow: number, over: Record<string, unknown> = {}) {
  const at = (h: number) => new Date(NOW + h * 3_600_000).toISOString().replace("Z", "0000");
  return {
    id,
    subject: `Event ${id}`,
    start: { dateTime: at(hoursFromNow), timeZone: "UTC" },
    end: { dateTime: at(hoursFromNow + 1), timeZone: "UTC" },
    isAllDay: false,
    isCancelled: false,
    showAs: "busy",
    responseStatus: { response: "accepted" },
    attendees: [{}],
    ...over,
  };
}

type Page = { value?: unknown[]; next?: string; delta?: string };

function install(handler: (url: URL, n: number) => Response): void {
  seen.length = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(requestUrlString(input));
    seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    return handler(url, seen.length - 1);
  }) as typeof fetch;
}

function pages(...ps: Page[]): (url: URL, n: number) => Response {
  return (_url, n) => {
    const p = ps[Math.min(n, ps.length - 1)];
    return new Response(
      JSON.stringify({
        value: p?.value ?? [],
        ...(p?.next === undefined ? {} : { "@odata.nextLink": p.next }),
        ...(p?.delta === undefined ? {} : { "@odata.deltaLink": p.delta }),
      }),
      { status: 200 },
    );
  };
}

async function setup(): Promise<{
  db: Database;
  ctx: SyncContext;
  warnings: string[];
  step: (half: OutlookCalendarCursor | undefined, now?: number) => Promise<CalendarStepResult>;
}> {
  const { db, ctx } = await createOAuthConnectorTestSetup("microsoft", "outlook");
  const warnings: string[] = [];
  const logged: SyncContext = {
    ...ctx,
    logger: {
      ...ctx.logger,
      warn: (_o: unknown, msg?: string) => {
        warnings.push(msg ?? "");
      },
    } as unknown as SyncContext["logger"],
  };
  return {
    db,
    ctx: logged,
    warnings,
    step: (half, now = NOW) => runOutlookCalendarStep(logged, "tok", half, now, "UTC"),
  };
}

function seedEvent(db: Database, id: string, endMs?: number): void {
  upsertIndexedItem(db, {
    service: "outlook",
    type: "event",
    externalId: id,
    title: id,
    modifiedAt: 1,
    syncedAt: 1,
    bodyPreview: id,
    metadata: endMs === undefined ? {} : { end_ms: endMs },
  });
}

function ids(db: Database, type: string): string[] {
  return (
    db
      .query(
        "SELECT external_id FROM item WHERE service = 'outlook' AND type = ? ORDER BY external_id",
      )
      .all(type) as { external_id: string }[]
  ).map((r) => r.external_id);
}

describe("first run (no calendar half)", () => {
  test("drains 3 pages in one run, stores the deltaLink and sweeps rows that were not returned", async () => {
    const { db, step } = await setup();
    seedEvent(db, "stale");
    upsertIndexedItem(db, {
      service: "outlook",
      type: "email",
      externalId: "mail1",
      title: "m",
      modifiedAt: 1,
      syncedAt: 1,
      bodyPreview: "m",
    });
    install(
      pages(
        {
          value: [evt("a", 1), evt("b", 2)],
          next: "https://graph.microsoft.com/v1.0/me/calendarView/delta?$skiptoken=1",
        },
        {
          value: [evt("c", 3)],
          next: "https://graph.microsoft.com/v1.0/me/calendarView/delta?$skiptoken=2",
        },
        { value: [evt("d", 4)], delta: DELTA },
      ),
    );
    const r = await step(undefined);
    expect(seen).toHaveLength(3);
    expect(r.upserted).toBe(4);
    expect(r.hasMore).toBe(false);
    expect(r.deleted).toBe(1);
    expect(r.bytes).toBeGreaterThan(0);
    expect(r.half).toEqual({ nextUrl: DELTA, windowStart: WINDOW_START, checkedAt: NOW });
    expect(ids(db, "event")).toEqual(["a", "b", "c", "d"]);
    expect(ids(db, "email")).toEqual(["mail1"]);
  });

  test("the request has a 31-day window, ONE Prefer header with both values, no $select; the stored link keeps the header", async () => {
    const { step } = await setup();
    install(pages({ value: [], delta: DELTA }));
    await step(undefined);
    const first = seen[0];
    const start = first?.url.searchParams.get("startDateTime");
    const end = first?.url.searchParams.get("endDateTime");
    expect(start).toBe(new Date(WINDOW_START).toISOString());
    expect((Date.parse(end ?? "") - Date.parse(start ?? "")) / DAY).toBe(31);
    expect(first?.headers["Prefer"]).toBe('odata.maxpagesize=50, outlook.timezone="UTC"');
    expect(first?.headers["Authorization"]).toBe("Bearer tok");
    expect(first?.url.searchParams.has("$select")).toBe(false);
    expect(first?.url.pathname).toBe("/v1.0/me/calendarView/delta");

    install(pages({ value: [], delta: DELTA }));
    await step({ nextUrl: DELTA, windowStart: WINDOW_START, checkedAt: NOW - 10 * MIN });
    expect(seen[0]?.url.toString()).toBe(DELTA);
    expect(seen[0]?.headers["Prefer"]).toBe('odata.maxpagesize=50, outlook.timezone="UTC"');
  });
});

describe("later runs", () => {
  test("request the stored deltaLink; @removed and isCancelled delete, a changed event upserts, nothing is swept", async () => {
    const { db, step } = await setup();
    seedEvent(db, "gone");
    seedEvent(db, "cancelled");
    seedEvent(db, "untouched");
    install(
      pages({
        value: [
          { id: "gone", "@removed": { reason: "deleted" } },
          { id: "never", "@removed": { reason: "deleted" } },
          { id: "", "@removed": {} },
          evt("cancelled", 1, { isCancelled: true }),
          evt("changed", 2),
          { subject: "no id" },
        ],
        delta: DELTA,
      }),
    );
    const r = await step({ nextUrl: DELTA, windowStart: WINDOW_START, checkedAt: NOW - 5 * MIN });
    expect(r.deleted).toBe(2);
    expect(r.upserted).toBe(1);
    expect(ids(db, "event")).toEqual(["changed", "untouched"]);
  });

  test("an event outside the window is removed, never upserted", async () => {
    const { db, step } = await setup();
    seedEvent(db, "moved");
    install(pages({ value: [evt("moved", 24 * 45), evt("early", -90)], delta: DELTA }));
    const r = await step({ nextUrl: DELTA, windowStart: WINDOW_START, checkedAt: NOW - 5 * MIN });
    expect(r.deleted).toBe(1);
    expect(r.upserted).toBe(0);
    expect(ids(db, "event")).toEqual([]);
  });

  test("a page with no deltaLink and no nextLink clears the stored link so the next run re-anchors", async () => {
    const { step } = await setup();
    install(pages({ value: [] }));
    const r = await step({ nextUrl: DELTA, windowStart: WINDOW_START, checkedAt: NOW - 5 * MIN });
    expect(r.half?.nextUrl).toBeNull();
  });
});

describe("throttle", () => {
  test("1 minute after the last check: no request, the half is unchanged; 4 minutes: a request", async () => {
    const { step } = await setup();
    const half: OutlookCalendarCursor = {
      nextUrl: DELTA,
      windowStart: WINDOW_START,
      checkedAt: NOW - MIN,
    };
    install(pages({ delta: DELTA }));
    const idle = await step(half);
    expect(seen).toHaveLength(0);
    expect(idle).toEqual({
      half,
      upserted: 0,
      deleted: 0,
      bytes: 0,
      hasMore: false,
      unresolved: 0,
    });
    await step({ ...half, checkedAt: NOW - 4 * MIN });
    expect(seen).toHaveLength(1);
  });

  test("a half with no checkedAt runs; a mid-drain half always runs", async () => {
    const { step } = await setup();
    install(pages({ delta: DELTA }));
    await step({ nextUrl: DELTA, windowStart: WINDOW_START });
    expect(seen).toHaveLength(1);
    const link = "https://graph.microsoft.com/v1.0/me/calendarView/delta?$skiptoken=zz";
    install(pages({ delta: DELTA }));
    await step({ nextUrl: link, windowStart: WINDOW_START, draining: true, checkedAt: NOW - 1 });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url.toString()).toBe(link);
  });
});

describe("re-anchor", () => {
  test("a settled half older than 7 days re-drains with a new window and sweeps with the keep set", async () => {
    const { db, step } = await setup();
    seedEvent(db, "removed-upstream");
    const later = NOW + 8 * DAY;
    install(pages({ value: [evt("kept", 24 * 8 + 2)], delta: DELTA }));
    const r = await step(
      { nextUrl: DELTA, windowStart: WINDOW_START, checkedAt: later - 10 * MIN },
      later,
    );
    expect(seen[0]?.url.searchParams.get("startDateTime")).toBe(
      new Date(later - DAY).toISOString(),
    );
    expect(r.half?.windowStart).toBe(later - DAY);
    expect(ids(db, "event")).toEqual(["kept"]);
    expect(r.deleted).toBe(1);
  });

  test("a mid-drain half is NOT re-anchored (finish first)", async () => {
    const { step } = await setup();
    const link = "https://graph.microsoft.com/v1.0/me/calendarView/delta?$skiptoken=zz";
    install(pages({ delta: DELTA }));
    await step(
      { nextUrl: link, windowStart: WINDOW_START, draining: true, checkedAt: NOW - 20 * DAY },
      NOW + 20 * DAY,
    );
    expect(seen[0]?.url.toString()).toBe(link);
  });

  test("a half whose link was cleared re-anchors immediately", async () => {
    const { step } = await setup();
    install(pages({ delta: DELTA }));
    await step({ nextUrl: null, windowStart: WINDOW_START, checkedAt: NOW - 10 * MIN });
    expect(seen[0]?.url.searchParams.has("startDateTime")).toBe(true);
  });
});

describe("page cap", () => {
  test("21 pages: 20 drained, the half keeps the nextLink, hasMore, no sweep; the completing run prunes only aged-out rows", async () => {
    const { db, step } = await setup();
    seedEvent(db, "stale-in-window", NOW + 3_600_000);
    const all = Array.from({ length: 21 }, (_, i) => ({
      value: i === 0 ? [evt("first", 1)] : [],
      next: `https://graph.microsoft.com/v1.0/me/calendarView/delta?$skiptoken=${String(i)}`,
    }));
    install(pages(...all));
    const r = await step(undefined);
    expect(seen).toHaveLength(20);
    expect(r.hasMore).toBe(true);
    expect(r.half).toEqual({
      nextUrl: "https://graph.microsoft.com/v1.0/me/calendarView/delta?$skiptoken=19",
      windowStart: WINDOW_START,
      draining: true,
      checkedAt: NOW,
    });
    expect(ids(db, "event")).toEqual(["first", "stale-in-window"]);

    seedEvent(db, "ancient", WINDOW_START - 1);
    install(pages({ value: [evt("last", 2)], delta: DELTA }));
    const r2 = await step(r.half, NOW + MIN);
    expect(seen[0]?.url.toString()).toContain("$skiptoken=19");
    expect(r2.hasMore).toBe(false);
    expect(r2.half?.draining).toBeUndefined();
    expect(ids(db, "event")).toEqual(["first", "last", "stale-in-window"]);
  });
});

describe("failure handling", () => {
  test("a 410 drops the half and re-drains once in the same run", async () => {
    const { db, step } = await setup();
    install((url, n) =>
      n === 0
        ? new Response("{}", { status: 410 })
        : pages({ value: [evt("fresh", 1)], delta: DELTA })(url, 0),
    );
    const r = await step({ nextUrl: DELTA, windowStart: WINDOW_START, checkedAt: NOW - 10 * MIN });
    expect(seen).toHaveLength(2);
    expect(seen[0]?.url.toString()).toBe(DELTA);
    expect(seen[1]?.url.searchParams.has("startDateTime")).toBe(true);
    expect(ids(db, "event")).toEqual(["fresh"]);
    expect(r.half?.nextUrl).toBe(DELTA);
  });

  test("a second 410 in one run does not loop and is swallowed", async () => {
    const { step, warnings } = await setup();
    install(() => new Response("{}", { status: 410 }));
    const half: OutlookCalendarCursor = {
      nextUrl: DELTA,
      windowStart: WINDOW_START,
      checkedAt: NOW - 10 * MIN,
    };
    const r = await step(half);
    expect(seen).toHaveLength(2);
    expect(r.half).toEqual(half);
    expect(warnings).toHaveLength(1);
  });

  test("a 401 or 403 backs off for 6 hours without throwing; no calendar request before then", async () => {
    for (const status of [401, 403]) {
      const { step, warnings } = await setup();
      install(() => new Response("{}", { status }));
      const r = await step(undefined);
      expect(r.half?.retryAt, String(status)).toBe(NOW + 6 * 60 * MIN);
      expect(r.half?.nextUrl).toBeNull();
      expect(warnings.some((w) => w.includes("Calendars.Read"))).toBe(true);
      install(() => new Response("{}", { status: 500 }));
      const quiet = await step(r.half, NOW + 5 * 60 * MIN);
      expect(seen).toHaveLength(0);
      expect(quiet.half).toEqual(r.half);
      await step(r.half, NOW + 6 * 60 * MIN + 1);
      expect(seen).toHaveLength(1);
    }
  });

  test("a denial of an existing half keeps its link, window and draining flag", async () => {
    const { step } = await setup();
    install(() => new Response("{}", { status: 403 }));
    const link = "https://graph.microsoft.com/v1.0/me/calendarView/delta?$skiptoken=q";
    const r = await step({ nextUrl: link, windowStart: WINDOW_START, draining: true });
    expect(r.half).toEqual({
      nextUrl: link,
      windowStart: WINDOW_START,
      draining: true,
      checkedAt: NOW,
      retryAt: NOW + 6 * 60 * MIN,
    });
  });

  test("a 500 and a network throw are swallowed with a fixed warning and the half is kept as it was", async () => {
    const { step, warnings } = await setup();
    const half: OutlookCalendarCursor = {
      nextUrl: DELTA,
      windowStart: WINDOW_START,
      checkedAt: NOW - 10 * MIN,
    };
    install(() => new Response("secret provider body", { status: 500 }));
    expect((await step(half)).half).toEqual(half);
    globalThis.fetch = (async () => {
      throw new Error("socket closed");
    }) as unknown as typeof fetch;
    expect((await step(half)).half).toEqual(half);
    expect(warnings).toHaveLength(2);
    expect(warnings.join(" ")).not.toContain("secret");
    expect(warnings.join(" ")).not.toContain("socket");
  });
});

describe("unresolved zones", () => {
  test("events with an unresolvable zone are indexed without epoch keys and counted", async () => {
    const { db, step } = await setup();
    install(
      pages({
        value: [
          evt("ok", 1),
          evt("win", 2, {
            start: { dateTime: "2026-11-12T09:30:00.0000000", timeZone: "Pacific Standard Time" },
            end: { dateTime: "2026-11-12T10:30:00.0000000", timeZone: "Pacific Standard Time" },
          }),
        ],
        delta: DELTA,
      }),
    );
    const r = await step(undefined);
    expect(r.unresolved).toBe(1);
    expect(r.upserted).toBe(2);
    const meta = JSON.parse(
      (
        db.query("SELECT metadata FROM item WHERE external_id = 'win'").get() as {
          metadata: string;
        }
      ).metadata,
    ) as Record<string, unknown>;
    expect("start_ms" in meta).toBe(false);
  });
});
