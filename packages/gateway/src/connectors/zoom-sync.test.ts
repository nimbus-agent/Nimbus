import { expect, test } from "bun:test";
import { ProviderRateLimiter } from "../sync/rate-limiter.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  describeWithFetchRestore,
  EMPTY_NIMBUS_VAULT,
  expectServiceItemCount,
  expectSyncNoopResult,
  silentSyncContextExtras,
  syncTestContext,
  urlFromFetchInput,
} from "./connector-sync-test-helpers.ts";
import { createZoomSyncable } from "./zoom-sync.ts";

const CURSOR_PREFIX = "nimbus-zoom1:";

function makeZoomVault(accessToken = "test-access-token") {
  return createStubVault({
    "zoom.oauth": JSON.stringify({
      accessToken,
      refreshToken: "test-refresh-token",
      expiresAt: Date.now() + 60 * 60 * 1000, // 1 hour from now — well past 2-min margin
    }),
  });
}

function makeMeeting(id: number, topic = "Test Meeting", startTime = "2026-06-01T10:00:00Z") {
  return { id, topic, start_time: startTime };
}

function stubMeetingsFetch(
  pages: Array<{ meetings: unknown[]; next_page_token: string; status?: number }>,
): { fetchCount: { n: number } } {
  const fetchCount = { n: 0 };
  let i = 0;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = urlFromFetchInput(input);
    if (!url.includes("/v2/users/me/meetings")) {
      throw new Error(`stubMeetingsFetch: unexpected URL: ${url}`);
    }
    fetchCount.n += 1;
    const page = pages[i];
    i += 1;
    if (page === undefined) {
      throw new Error(`stubMeetingsFetch: call ${fetchCount.n} exceeds ${pages.length} pages`);
    }
    const status = page.status ?? 200;
    if (status !== 200) {
      return new Response("Internal Server Error", { status });
    }
    return new Response(
      JSON.stringify({ meetings: page.meetings, next_page_token: page.next_page_token }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  return { fetchCount };
}

function withAcquireTracking(ctx: ReturnType<typeof syncTestContext>) {
  const acquireProviders: string[] = [];
  const originalAcquire = ctx.rateLimiter.acquire.bind(ctx.rateLimiter);
  ctx.rateLimiter.acquire = async (provider, tokens?) => {
    acquireProviders.push(provider);
    return originalAcquire(provider, tokens);
  };
  return { ctx, acquireProviders };
}

describeWithFetchRestore("zoom-sync", () => {
  test("noop when zoom.oauth is absent", async () => {
    const db = createMemoryIndexDb();
    const sync = createZoomSyncable({ ensureZoomMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT), null);
    expectSyncNoopResult(r);
    expectServiceItemCount(db, "zoom", 0);
  });

  test("upserts a single page of meetings and acquires the rate limiter", async () => {
    const { fetchCount } = stubMeetingsFetch([
      { meetings: [makeMeeting(1, "Alpha", "2026-06-01T10:00:00Z")], next_page_token: "" },
    ]);
    const db = createMemoryIndexDb();
    const sync = createZoomSyncable({ ensureZoomMcpRunning: async () => {} });
    const baseCtx = syncTestContext(db, makeZoomVault());
    const { ctx, acquireProviders } = withAcquireTracking(baseCtx);

    const r = await sync.sync(ctx, null);

    expect(r.itemsUpserted).toBe(1);
    expect(fetchCount.n).toBeGreaterThanOrEqual(1);
    expect(acquireProviders.filter((p) => p === "zoom").length).toBeGreaterThanOrEqual(1);
    expectServiceItemCount(db, "zoom", 1);
  });

  test("follows next_page_token for two pages then stops", async () => {
    const { fetchCount } = stubMeetingsFetch([
      {
        meetings: [makeMeeting(1, "A", "2026-06-01T10:00:00Z")],
        next_page_token: "token2",
      },
      {
        meetings: [makeMeeting(2, "B", "2026-06-02T10:00:00Z")],
        next_page_token: "",
      },
    ]);
    const db = createMemoryIndexDb();
    const sync = createZoomSyncable({ ensureZoomMcpRunning: async () => {} });
    const baseCtx = syncTestContext(db, makeZoomVault());
    const { ctx, acquireProviders } = withAcquireTracking(baseCtx);

    const r = await sync.sync(ctx, null);

    expect(fetchCount.n).toBe(2);
    expect(acquireProviders.filter((p) => p === "zoom").length).toBe(2);
    expect(r.itemsUpserted).toBe(2);
    expectServiceItemCount(db, "zoom", 2);
  });

  test("first-page HTTP error returns pass-cursor-empty (cursor unchanged)", async () => {
    stubMeetingsFetch([{ meetings: [], next_page_token: "", status: 500 }]);
    const db = createMemoryIndexDb();
    const sync = createZoomSyncable({ ensureZoomMcpRunning: async () => {} });
    const priorCursor = "nimbus-zoom1:cHJpb3I=";
    const r = await sync.sync(syncTestContext(db, makeZoomVault()), priorCursor);

    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toBe(priorCursor);
    expectServiceItemCount(db, "zoom", 0);
  });

  test("first-page parse error returns pass-cursor-empty (cursor reset to pass1)", async () => {
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = urlFromFetchInput(input);
      if (!url.includes("/v2/users/me/meetings")) {
        throw new Error(`unexpected fetch: ${url}`);
      }
      return new Response("not json at all", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }) as typeof fetch;

    const db = createMemoryIndexDb();
    const sync = createZoomSyncable({ ensureZoomMcpRunning: async () => {} });

    const r = await sync.sync(syncTestContext(db, makeZoomVault()), null);

    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).not.toBeNull();
    expect((r.cursor as string).startsWith(CURSOR_PREFIX)).toBe(true);
    expectServiceItemCount(db, "zoom", 0);
  });

  test("MAX_PAGES caps the walk at 20 fetches", async () => {
    let fetchCount = 0;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = urlFromFetchInput(input);
      if (!url.includes("/v2/users/me/meetings")) {
        throw new Error(`unexpected fetch: ${url}`);
      }
      fetchCount += 1;
      const meetingId = fetchCount;
      return new Response(
        JSON.stringify({
          meetings: [makeMeeting(meetingId, `Meeting ${meetingId}`, "2026-06-01T10:00:00Z")],
          next_page_token: "more",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const db = createMemoryIndexDb();
    const sync = createZoomSyncable({ ensureZoomMcpRunning: async () => {} });
    const fastLimiter = new ProviderRateLimiter({
      zoom: { requestsPerMinute: 6000, burstSize: 100 },
    });
    const ctx = {
      db,
      vault: makeZoomVault(),
      ...silentSyncContextExtras(),
      rateLimiter: fastLimiter,
    };

    const r = await sync.sync(ctx, null);

    expect(fetchCount).toBe(20);
    expect(r.itemsUpserted).toBe(20);
    expectServiceItemCount(db, "zoom", 20);
  });
});
