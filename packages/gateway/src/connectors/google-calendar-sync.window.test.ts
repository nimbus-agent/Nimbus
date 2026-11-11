import { afterEach, describe, expect, test } from "bun:test";

import {
  createOAuthConnectorTestSetup,
  registerGlobalFetchRestore,
  requestUrlString,
} from "../testing/bun-test-support.ts";
import { createGoogleCalendarSyncable } from "./google-calendar-sync.ts";

/** DST and midnight cases, through the syncable (the zone is the gateway's: America/New_York here). */

registerGlobalFetchRestore(afterEach);

const NOW = Date.UTC(2026, 2, 8, 12, 0, 0);

function route(events: unknown[]): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = requestUrlString(input);
    if (url.includes("/calendarList")) {
      return new Response(JSON.stringify({ items: [{ id: "c@x.com", primary: true }] }));
    }
    return new Response(JSON.stringify({ items: events, nextSyncToken: "S" }));
  }) as typeof fetch;
}

async function syncOnce(events: unknown[]) {
  const { db, vault, ctx } = await createOAuthConnectorTestSetup("google", "google_calendar");
  await vault.set(
    "google_calendar.oauth",
    JSON.stringify({ accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 3_600_000 }),
  );
  route(events);
  await createGoogleCalendarSyncable({ now: () => NOW, zone: "America/New_York" }).sync(ctx, null);
  const out = new Map<string, Record<string, unknown>>();
  for (const r of db
    .query("SELECT external_id, metadata FROM item WHERE service = 'google_calendar'")
    .all() as { external_id: string; metadata: string }[]) {
    out.set(r.external_id, JSON.parse(r.metadata) as Record<string, unknown>);
  }
  return out;
}

describe("Google Calendar window edge cases", () => {
  test("an all-day event on the spring-forward day spans 23 hours", async () => {
    const m = await syncOnce([
      { id: "dst", start: { date: "2026-03-08" }, end: { date: "2026-03-09" }, summary: "DST" },
    ]);
    const meta = m.get("c@x.com|dst");
    expect(meta?.["all_day"]).toBe(true);
    expect(((meta?.["end_ms"] as number) - (meta?.["start_ms"] as number)) / 3_600_000).toBe(23);
    // midnight New York on 2026-03-08 is 05:00 UTC (EST, before the gap)
    expect(meta?.["start_ms"]).toBe(Date.UTC(2026, 2, 8, 5));
  });

  test("an event spanning midnight is kept whole as one row", async () => {
    const m = await syncOnce([
      {
        id: "late",
        start: { dateTime: "2026-03-08T23:00:00-04:00" },
        end: { dateTime: "2026-03-09T01:00:00-04:00" },
      },
    ]);
    expect(m.size).toBe(1);
    const meta = m.get("c@x.com|late");
    expect(((meta?.["end_ms"] as number) - (meta?.["start_ms"] as number)) / 3_600_000).toBe(2);
  });

  test("a multi-day all-day event is one row ending at the exclusive end's midnight", async () => {
    const m = await syncOnce([
      { id: "trip", start: { date: "2026-03-09" }, end: { date: "2026-03-12" } },
    ]);
    const meta = m.get("c@x.com|trip");
    expect(m.size).toBe(1);
    expect(meta?.["start_ms"]).toBe(Date.UTC(2026, 2, 9, 4));
    expect(meta?.["end_ms"]).toBe(Date.UTC(2026, 2, 12, 4));
  });
});
