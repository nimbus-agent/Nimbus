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
    if (url.includes("/v2/users/me/recordings")) {
      // Walk B fires every cycle; these Walk-A-focused tests want it to be a
      // no-op (empty recordings list → no transcript downloads). Not counted
      // in fetchCount.n, which tracks meetings-list pages only.
      return new Response(JSON.stringify({ meetings: [], next_page_token: "" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
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

// ----- Walk B (recordings + transcripts) shared fixtures -----

const VTT_SAMPLE = [
  "WEBVTT",
  "",
  "1",
  "00:00:00.500 --> 00:00:03.200",
  "<v Alice>Welcome to the design review.",
  "",
  "2",
  "00:00:03.500 --> 00:00:08.100",
  "<v Bob>Thanks Alice.",
].join("\n");

function makeRecording(opts: {
  meetingId: number;
  uuid: string;
  topic?: string;
  fileId?: string;
  hasTranscript?: boolean;
  hostId?: string;
}) {
  const files: Array<Record<string, unknown>> = [];
  if (opts.hasTranscript !== false) {
    files.push({
      id: opts.fileId ?? "tx-1",
      meeting_id: opts.uuid,
      file_type: "TRANSCRIPT",
      recording_start: "2026-06-01T10:05:00Z",
      play_url: `https://zoom.us/rec/play/${opts.fileId ?? "tx-1"}`,
      download_url: `https://api.zoom.us/v2/transcript-download/${opts.fileId ?? "tx-1"}.vtt`,
    });
  }
  files.push({
    id: `mp4-${opts.fileId ?? "1"}`,
    meeting_id: opts.uuid,
    file_type: "MP4",
    download_url: `https://api.zoom.us/v2/video-download/${opts.fileId ?? "1"}.mp4`,
  });
  return {
    id: opts.meetingId,
    uuid: opts.uuid,
    topic: opts.topic ?? `Meeting ${opts.meetingId}`,
    host_id: opts.hostId ?? "host-1",
    start_time: "2026-06-01T10:00:00Z",
    recording_files: files,
  };
}

/**
 * Stubs every Zoom URL pattern used by Walk A + Walk B in one place. Caller
 * controls meetings / recordings / transcript bodies; defaults are empty
 * lists + the canonical VTT sample (so the transcript-download path is
 * exercised by default).
 */
function stubAllZoomUrls(opts: {
  meetings?: unknown[];
  recordingsMeetings?: unknown[];
  vttByDownloadUrl?: Record<string, { body: string; status?: number }>;
  recordingsStatus?: number;
}): { fetchCount: { n: number }; loggedUrls: string[] } {
  const fetchCount = { n: 0 };
  const loggedUrls: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = urlFromFetchInput(input);
    loggedUrls.push(url);
    fetchCount.n += 1;
    if (url.includes("/v2/users/me/meetings")) {
      return new Response(JSON.stringify({ meetings: opts.meetings ?? [], next_page_token: "" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/v2/users/me/recordings")) {
      const status = opts.recordingsStatus ?? 200;
      if (status !== 200) {
        return new Response("err", { status });
      }
      return new Response(
        JSON.stringify({
          meetings: opts.recordingsMeetings ?? [],
          next_page_token: "",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    // Treat any other URL as a download_url for a recording file.
    const entry = opts.vttByDownloadUrl?.[url];
    if (entry !== undefined) {
      return new Response(entry.body, {
        status: entry.status ?? 200,
        headers: { "Content-Type": "text/vtt" },
      });
    }
    return new Response(VTT_SAMPLE, {
      status: 200,
      headers: { "Content-Type": "text/vtt" },
    });
  }) as typeof fetch;
  return { fetchCount, loggedUrls };
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
    // 2 meetings-list pages + 1 recordings-list page (Walk B, empty result).
    expect(acquireProviders.filter((p) => p === "zoom").length).toBe(3);
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
      if (url.includes("/v2/users/me/recordings")) {
        // Walk B no-op for this Walk-A pagination cap test.
        return new Response(JSON.stringify({ meetings: [], next_page_token: "" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
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

  // ----- Walk B tests -----

  test("Walk B upserts a zoom:transcript row for each TRANSCRIPT file", async () => {
    stubAllZoomUrls({
      recordingsMeetings: [
        makeRecording({ meetingId: 100, uuid: "uuid-100", topic: "Design Review" }),
      ],
    });
    const db = createMemoryIndexDb();
    const sync = createZoomSyncable({ ensureZoomMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, makeZoomVault()), null);
    expect(r.itemsUpserted).toBeGreaterThanOrEqual(2); // meeting + transcript
    expectServiceItemCount(db, "zoom", 2);
    const txRow = db
      .prepare(
        "SELECT id, title, body_preview FROM item WHERE service = 'zoom' AND type = 'transcript'",
      )
      .get() as { id: string; title: string; body_preview: string };
    expect(txRow.id).toBe("zoom:uuid-100:tx-1");
    expect(txRow.title).toBe("Transcript — Design Review");
    expect(txRow.body_preview.startsWith("Welcome to the design review.")).toBe(true);
  });

  test("Walk B parent-meeting dedupe — past recorded meetings get a zoom:meeting row", async () => {
    // Walk A returns nothing (no scheduled meetings); only the recordings walk
    // surfaces this meeting. The parent-meeting upsert path must still create
    // its zoom:meeting row.
    stubAllZoomUrls({
      meetings: [],
      recordingsMeetings: [
        makeRecording({ meetingId: 200, uuid: "uuid-200", topic: "Past Recording" }),
      ],
    });
    const db = createMemoryIndexDb();
    const sync = createZoomSyncable({ ensureZoomMcpRunning: async () => {} });
    await sync.sync(syncTestContext(db, makeZoomVault()), null);
    const meetingRow = db
      .prepare("SELECT id FROM item WHERE service = 'zoom' AND type = 'meeting'")
      .get() as { id: string };
    expect(meetingRow.id).toBe("zoom:200");
  });

  test("Walk B skip-if-exists — pre-seeded transcript row suppresses the download fetch", async () => {
    const recordingsMeeting = makeRecording({
      meetingId: 300,
      uuid: "uuid-300",
      topic: "Already Indexed",
      fileId: "tx-cached",
    });
    const stub = stubAllZoomUrls({ recordingsMeetings: [recordingsMeeting] });

    const db = createMemoryIndexDb();
    // Pre-seed a zoom:transcript row at the canonical external_id.
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at)
       VALUES ('zoom:uuid-300:tx-cached', 'zoom', 'transcript', 'uuid-300:tx-cached',
               'cached', 'cached', 0, 0)`,
    );
    const sync = createZoomSyncable({ ensureZoomMcpRunning: async () => {} });
    await sync.sync(syncTestContext(db, makeZoomVault()), null);

    // No download fetch should have happened — the download_url was never visited.
    const downloadHit = stub.loggedUrls.some((u) => u.includes("transcript-download"));
    expect(downloadHit).toBe(false);
    // The meeting row is still upserted (the dedupe path).
    expectServiceItemCount(db, "zoom", 2); // pre-seeded transcript + new meeting
  });

  test("Walk B — meeting without TRANSCRIPT-typed files emits no zoom:transcript row", async () => {
    stubAllZoomUrls({
      recordingsMeetings: [
        makeRecording({ meetingId: 400, uuid: "uuid-400", hasTranscript: false }),
      ],
    });
    const db = createMemoryIndexDb();
    const sync = createZoomSyncable({ ensureZoomMcpRunning: async () => {} });
    await sync.sync(syncTestContext(db, makeZoomVault()), null);
    const txCount = db
      .prepare("SELECT COUNT(*) AS c FROM item WHERE service = 'zoom' AND type = 'transcript'")
      .get() as { c: number };
    expect(txCount.c).toBe(0);
    // The parent meeting is still upserted.
    expectServiceItemCount(db, "zoom", 1);
  });

  test("Walk B — download fetch sends Bearer header, never URL-token", async () => {
    const observed: { headers: Record<string, string>; url: string }[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = urlFromFetchInput(input);
      observed.push({ url, headers: (init?.headers as Record<string, string>) ?? {} });
      if (url.includes("/v2/users/me/meetings")) {
        return new Response(JSON.stringify({ meetings: [], next_page_token: "" }), { status: 200 });
      }
      if (url.includes("/v2/users/me/recordings")) {
        return new Response(
          JSON.stringify({
            meetings: [makeRecording({ meetingId: 500, uuid: "uuid-500" })],
            next_page_token: "",
          }),
          { status: 200 },
        );
      }
      return new Response(VTT_SAMPLE, { status: 200 });
    }) as typeof fetch;

    const db = createMemoryIndexDb();
    const sync = createZoomSyncable({ ensureZoomMcpRunning: async () => {} });
    await sync.sync(syncTestContext(db, makeZoomVault("test-access-token")), null);

    const downloadCall = observed.find((o) => o.url.includes("transcript-download"));
    expect(downloadCall).toBeDefined();
    expect(downloadCall?.headers["Authorization"]).toBe("Bearer test-access-token");
    // The URL must NEVER carry the token as a query param.
    expect(downloadCall?.url.includes("access_token=")).toBe(false);
    expect(downloadCall?.url.includes("test-access-token")).toBe(false);
  });

  test("Walk B — 429 mid-walk graceful-breaks without advancing lastRecordingsTo", async () => {
    let downloadCallCount = 0;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = urlFromFetchInput(input);
      if (url.includes("/v2/users/me/meetings")) {
        return new Response(JSON.stringify({ meetings: [], next_page_token: "" }), { status: 200 });
      }
      if (url.includes("/v2/users/me/recordings")) {
        return new Response(
          JSON.stringify({
            meetings: [makeRecording({ meetingId: 600, uuid: "uuid-600", fileId: "tx-rate" })],
            next_page_token: "",
          }),
          { status: 200 },
        );
      }
      downloadCallCount += 1;
      return new Response("rate limited", { status: 429 });
    }) as typeof fetch;

    const db = createMemoryIndexDb();
    const sync = createZoomSyncable({ ensureZoomMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, makeZoomVault()), null);

    expect(downloadCallCount).toBe(1); // one 429 → break
    // The transcript was NOT upserted.
    const txCount = db
      .prepare("SELECT COUNT(*) AS c FROM item WHERE service = 'zoom' AND type = 'transcript'")
      .get() as { c: number };
    expect(txCount.c).toBe(0);
    // The cursor was returned (no throw).
    expect(r.cursor).not.toBeNull();
    // The cursor's lastRecordingsTo MUST be null (we did not advance).
    const decoded = JSON.parse(
      Buffer.from((r.cursor as string).slice(CURSOR_PREFIX.length), "base64url").toString("utf8"),
    ) as { lastRecordingsTo: string | null };
    expect(decoded.lastRecordingsTo).toBeNull();
  });

  test("Walk B — successful cycle advances lastRecordingsTo in the cursor", async () => {
    stubAllZoomUrls({
      recordingsMeetings: [makeRecording({ meetingId: 700, uuid: "uuid-700" })],
    });
    const db = createMemoryIndexDb();
    const sync = createZoomSyncable({ ensureZoomMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, makeZoomVault()), null);

    expect(r.cursor).not.toBeNull();
    const decoded = JSON.parse(
      Buffer.from((r.cursor as string).slice(CURSOR_PREFIX.length), "base64url").toString("utf8"),
    ) as { lastRecordingsTo: string | null; pass: number };
    expect(decoded.pass).toBe(1);
    expect(decoded.lastRecordingsTo).not.toBeNull();
    // Within ~10 seconds of now (the walk's `to`).
    const lastToMs = Date.parse(decoded.lastRecordingsTo as string);
    expect(Math.abs(Date.now() - lastToMs)).toBeLessThan(10_000);
  });

  test("Walk B — incremental sync uses lastRecordingsTo as `from`", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = urlFromFetchInput(input);
      urls.push(url);
      if (url.includes("/v2/users/me/meetings")) {
        return new Response(JSON.stringify({ meetings: [], next_page_token: "" }), { status: 200 });
      }
      if (url.includes("/v2/users/me/recordings")) {
        return new Response(JSON.stringify({ meetings: [], next_page_token: "" }), { status: 200 });
      }
      return new Response(VTT_SAMPLE, { status: 200 });
    }) as typeof fetch;

    const priorTo = new Date(Date.now() - 5 * 86_400_000).toISOString(); // 5 days ago
    const priorCursor = `${CURSOR_PREFIX}${Buffer.from(
      JSON.stringify({ pass: 1, lastRecordingsTo: priorTo }),
    ).toString("base64url")}`;
    const db = createMemoryIndexDb();
    const sync = createZoomSyncable({ ensureZoomMcpRunning: async () => {} });
    await sync.sync(syncTestContext(db, makeZoomVault()), priorCursor);

    const recordingsUrl = urls.find((u) => u.includes("/v2/users/me/recordings"));
    expect(recordingsUrl).toBeDefined();
    // The `from` param must be the prior `to`.
    expect(recordingsUrl?.includes(`from=${encodeURIComponent(priorTo)}`)).toBe(true);
  });

  test("Walk B — no log line contains a token-bearing URL", async () => {
    const logged: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = urlFromFetchInput(input);
      if (url.includes("/v2/users/me/meetings")) {
        return new Response(JSON.stringify({ meetings: [], next_page_token: "" }), { status: 200 });
      }
      if (url.includes("/v2/users/me/recordings")) {
        return new Response(
          JSON.stringify({
            meetings: [makeRecording({ meetingId: 800, uuid: "uuid-800", fileId: "tx-err" })],
            next_page_token: "",
          }),
          { status: 200 },
        );
      }
      return new Response("bad gateway", { status: 502 });
    }) as typeof fetch;

    const db = createMemoryIndexDb();
    // A logger that records every formatted log line into `logged`.
    const ctx = {
      db,
      vault: makeZoomVault("supersecrettoken"),
      rateLimiter: new ProviderRateLimiter(),
      logger: {
        info: (...args: unknown[]) => logged.push(JSON.stringify(args)),
        warn: (...args: unknown[]) => logged.push(JSON.stringify(args)),
        error: (...args: unknown[]) => logged.push(JSON.stringify(args)),
        debug: (...args: unknown[]) => logged.push(JSON.stringify(args)),
        trace: (...args: unknown[]) => logged.push(JSON.stringify(args)),
        fatal: (...args: unknown[]) => logged.push(JSON.stringify(args)),
        child: () => ctx.logger,
        level: "silent",
      },
    } as unknown as Parameters<ReturnType<typeof createZoomSyncable>["sync"]>[0];
    const sync = createZoomSyncable({ ensureZoomMcpRunning: async () => {} });
    await sync.sync(ctx, null);

    // The download URL is never logged — only the meeting_uuid + file_id + status are.
    for (const line of logged) {
      expect(line.includes("transcript-download")).toBe(false);
      expect(line.includes("supersecrettoken")).toBe(false);
    }
  });
});
