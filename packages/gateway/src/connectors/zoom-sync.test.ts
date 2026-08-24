import { expect, test } from "bun:test";
import { ProviderRateLimiter } from "../sync/rate-limiter.ts";
import {
  boundTestCapabilities,
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
    const r = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "zoom"), null);
    expectSyncNoopResult(r);
    expectServiceItemCount(db, "zoom", 0);
  });

  test("upserts a single page of meetings and acquires the rate limiter", async () => {
    const { fetchCount } = stubMeetingsFetch([
      { meetings: [makeMeeting(1, "Alpha", "2026-06-01T10:00:00Z")], next_page_token: "" },
    ]);
    const db = createMemoryIndexDb();
    const sync = createZoomSyncable({ ensureZoomMcpRunning: async () => {} });
    const baseCtx = syncTestContext(db, makeZoomVault(), "zoom");
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
    const baseCtx = syncTestContext(db, makeZoomVault(), "zoom");
    const { ctx, acquireProviders } = withAcquireTracking(baseCtx);

    const r = await sync.sync(ctx, null);

    expect(fetchCount.n).toBe(2);
    // 2 meetings-list pages + 1 recordings-list page (Walk B, empty result).
    expect(acquireProviders.filter((p) => p === "zoom")).toHaveLength(3);
    expect(r.itemsUpserted).toBe(2);
    expectServiceItemCount(db, "zoom", 2);
  });

  test("first-page HTTP error returns pass-cursor-empty (cursor unchanged)", async () => {
    stubMeetingsFetch([{ meetings: [], next_page_token: "", status: 500 }]);
    const db = createMemoryIndexDb();
    const sync = createZoomSyncable({ ensureZoomMcpRunning: async () => {} });
    const priorCursor = "nimbus-zoom1:cHJpb3I=";
    const r = await sync.sync(syncTestContext(db, makeZoomVault(), "zoom"), priorCursor);

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

    const r = await sync.sync(syncTestContext(db, makeZoomVault(), "zoom"), null);

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
      ...boundTestCapabilities(db, makeZoomVault(), "zoom"),
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
    const r = await sync.sync(syncTestContext(db, makeZoomVault(), "zoom"), null);
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
    await sync.sync(syncTestContext(db, makeZoomVault(), "zoom"), null);
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
    await sync.sync(syncTestContext(db, makeZoomVault(), "zoom"), null);

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
    await sync.sync(syncTestContext(db, makeZoomVault(), "zoom"), null);
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
    await sync.sync(syncTestContext(db, makeZoomVault("test-access-token"), "zoom"), null);

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
    const r = await sync.sync(syncTestContext(db, makeZoomVault(), "zoom"), null);

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
    const r = await sync.sync(syncTestContext(db, makeZoomVault(), "zoom"), null);

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
    await sync.sync(syncTestContext(db, makeZoomVault(), "zoom"), priorCursor);

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
    const ctxVault = makeZoomVault("supersecrettoken");
    // A logger that records every formatted log line into `logged`.
    const ctx = {
      db,
      vault: ctxVault,
      // This literal is cast with `as unknown as`, so the compiler cannot tell it is missing a
      // capability — it was the ONLY site in the migration the type system could not catch.
      ...boundTestCapabilities(db, ctxVault, "zoom"),
      rateLimiter: new ProviderRateLimiter(),
      depth: "full",
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

  // ----- Additional branch coverage -----

  test("noop when getValidZoomAccessToken throws (corrupt token store)", async () => {
    // vault has a zoom.oauth key but with a payload that causes getValidZoomAccessToken
    // to throw (expired token with no refresh token → the token-refresh path throws).
    const vault = createStubVault({
      "zoom.oauth": JSON.stringify({
        accessToken: "",
        refreshToken: "",
        // Far-past expiry so the "needs refresh" path tries to call refresh and fails
        expiresAt: Date.now() - 10 * 60 * 1000,
      }),
    });
    // No HTTP stub — getValidZoomAccessToken will throw when it attempts refresh
    const db = createMemoryIndexDb();
    const sync = createZoomSyncable({ ensureZoomMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, vault, "zoom"), null);
    expectSyncNoopResult(r);
    expectServiceItemCount(db, "zoom", 0);
  });

  test("noop when zoom.oauth is empty string", async () => {
    // raw === "" branch in the sync function
    const vault = createStubVault({ "zoom.oauth": "" });
    const db = createMemoryIndexDb();
    const sync = createZoomSyncable({ ensureZoomMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, vault, "zoom"), null);
    expectSyncNoopResult(r);
  });

  test("decodeCursor handles empty string cursor the same as null", async () => {
    // cursor === "" branch: should behave as null (initial sync)
    stubAllZoomUrls({ meetings: [], recordingsMeetings: [] });
    const db = createMemoryIndexDb();
    const sync = createZoomSyncable({ ensureZoomMcpRunning: async () => {} });
    // Pass empty string — should not throw and should return a valid cursor
    const r = await sync.sync(syncTestContext(db, makeZoomVault(), "zoom"), "");
    expect(r.cursor).not.toBeNull();
    expect((r.cursor as string).startsWith(CURSOR_PREFIX)).toBe(true);
  });

  test("decodeCursor handles a cursor payload that is not a JSON object", async () => {
    // asRecord(parsed) returns undefined → falls back to emptyCursor()
    // A base64url of a JSON array is a valid prefix-decoded payload but not an object
    const arrayPayload = Buffer.from(JSON.stringify([1, 2, 3])).toString("base64url");
    const badCursor = `${CURSOR_PREFIX}${arrayPayload}`;
    stubAllZoomUrls({ meetings: [], recordingsMeetings: [] });
    const db = createMemoryIndexDb();
    const sync = createZoomSyncable({ ensureZoomMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, makeZoomVault(), "zoom"), badCursor);
    // Should not throw; should return a valid cursor (treated as initial sync)
    expect(r.cursor).not.toBeNull();
    expect((r.cursor as string).startsWith(CURSOR_PREFIX)).toBe(true);
  });

  test("decodeCursor lastRecordingsTo: empty string field treated as null", async () => {
    // lastTo field is an empty string → treated as null → initial sync window
    const urls: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = urlFromFetchInput(input);
      urls.push(url);
      if (url.includes("/v2/users/me/meetings")) {
        return new Response(JSON.stringify({ meetings: [], next_page_token: "" }), { status: 200 });
      }
      return new Response(JSON.stringify({ meetings: [], next_page_token: "" }), { status: 200 });
    }) as typeof fetch;

    const emptyStringToPayload = Buffer.from(
      JSON.stringify({ pass: 1, lastRecordingsTo: "" }),
    ).toString("base64url");
    const cursor = `${CURSOR_PREFIX}${emptyStringToPayload}`;
    const db = createMemoryIndexDb();
    const sync = createZoomSyncable({ ensureZoomMcpRunning: async () => {} });
    await sync.sync(syncTestContext(db, makeZoomVault(), "zoom"), cursor);

    // Since lastRecordingsTo is treated as null, the initial-sync 30-day window
    // is used → recordings URL should have a 'from' param (not a future date).
    const recUrl = urls.find((u) => u.includes("/v2/users/me/recordings"));
    expect(recUrl).toBeDefined();
    expect(recUrl).toContain("from=");
  });

  test("nextRecordingsWindow returns null when lastRecordingsTo is in the future", async () => {
    // lastToMs >= nowMs → window === null → Walk B is skipped
    const futureDate = new Date(Date.now() + 2 * 86_400_000).toISOString(); // 2 days in the future
    const payload = Buffer.from(JSON.stringify({ pass: 1, lastRecordingsTo: futureDate })).toString(
      "base64url",
    );
    const futCursor = `${CURSOR_PREFIX}${payload}`;

    const urls: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = urlFromFetchInput(input);
      urls.push(url);
      if (url.includes("/v2/users/me/meetings")) {
        return new Response(JSON.stringify({ meetings: [], next_page_token: "" }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const db = createMemoryIndexDb();
    const sync = createZoomSyncable({ ensureZoomMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, makeZoomVault(), "zoom"), futCursor);

    // No recordings URL should have been fetched — Walk B was skipped
    expect(urls.some((u) => u.includes("/v2/users/me/recordings"))).toBe(false);
    // Should still return a valid cursor
    expect(r.cursor).not.toBeNull();
  });

  test("nextRecordingsWindow returns null when lastRecordingsTo is unparseable", async () => {
    // !Number.isFinite(Date.parse(lastTo)) → return null → Walk B skipped
    const payload = Buffer.from(
      JSON.stringify({ pass: 1, lastRecordingsTo: "not-a-date" }),
    ).toString("base64url");
    const badDateCursor = `${CURSOR_PREFIX}${payload}`;

    const urls: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = urlFromFetchInput(input);
      urls.push(url);
      if (url.includes("/v2/users/me/meetings")) {
        return new Response(JSON.stringify({ meetings: [], next_page_token: "" }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const db = createMemoryIndexDb();
    const sync = createZoomSyncable({ ensureZoomMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, makeZoomVault(), "zoom"), badDateCursor);

    // Walk B must have been skipped (no recordings URL hit)
    expect(urls.some((u) => u.includes("/v2/users/me/recordings"))).toBe(false);
    expect(r.cursor).not.toBeNull();
  });

  test("Walk A mid-walk (page >= 2) HTTP error still runs Walk B", async () => {
    // page === 1 OK, page === 2 HTTP 500 → break out of Walk A, Walk B still runs
    let meetingsPage = 0;
    let recordingsCalled = false;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = urlFromFetchInput(input);
      if (url.includes("/v2/users/me/meetings")) {
        meetingsPage += 1;
        if (meetingsPage === 1) {
          return new Response(
            JSON.stringify({
              meetings: [makeMeeting(901, "Meeting A", "2026-06-01T10:00:00Z")],
              next_page_token: "page2token",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        // Page 2: HTTP error
        return new Response("Internal Server Error", { status: 500 });
      }
      if (url.includes("/v2/users/me/recordings")) {
        recordingsCalled = true;
        return new Response(JSON.stringify({ meetings: [], next_page_token: "" }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const db = createMemoryIndexDb();
    const sync = createZoomSyncable({ ensureZoomMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, makeZoomVault(), "zoom"), null);

    // Walk A page 1 gave us one meeting
    expect(r.itemsUpserted).toBe(1);
    // Walk B was still invoked
    expect(recordingsCalled).toBe(true);
  });

  test("extractPage handles non-object meetings response body", async () => {
    // connectorFetch returns a non-object parsed value → extractPage root === undefined
    // We achieve this by returning something like `"not-an-object"` as JSON body
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = urlFromFetchInput(input);
      if (url.includes("/v2/users/me/meetings")) {
        // Return a JSON string (not an object) — connectorFetch parses it OK but
        // asRecord("string") returns undefined → extractPage returns empty lists
        return new Response(JSON.stringify("not-an-object"), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/v2/users/me/recordings")) {
        return new Response(JSON.stringify({ meetings: [], next_page_token: "" }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const db = createMemoryIndexDb();
    const sync = createZoomSyncable({ ensureZoomMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, makeZoomVault(), "zoom"), null);

    // extractPage returned empty → 0 meetings upserted from Walk A, Walk B no-op
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).not.toBeNull();
  });

  test("upsertMeetings skips malformed meeting records (null id)", async () => {
    // mapZoomMeetingToItem returns null when id field is absent → `continue` branch
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = urlFromFetchInput(input);
      if (url.includes("/v2/users/me/meetings")) {
        return new Response(
          JSON.stringify({
            // A meeting without an 'id' field → mapZoomMeetingToItem returns null
            meetings: [{ topic: "No ID meeting", start_time: "2026-06-01T10:00:00Z" }],
            next_page_token: "",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/v2/users/me/recordings")) {
        return new Response(JSON.stringify({ meetings: [], next_page_token: "" }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const db = createMemoryIndexDb();
    const sync = createZoomSyncable({ ensureZoomMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, makeZoomVault(), "zoom"), null);

    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "zoom", 0);
  });

  test("Walk B transcript download network error is skipped (catch branch)", async () => {
    // fetch throws a network error → catch block → kind === "skip"
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = urlFromFetchInput(input);
      if (url.includes("/v2/users/me/meetings")) {
        return new Response(JSON.stringify({ meetings: [], next_page_token: "" }), { status: 200 });
      }
      if (url.includes("/v2/users/me/recordings")) {
        return new Response(
          JSON.stringify({
            meetings: [makeRecording({ meetingId: 910, uuid: "uuid-910", fileId: "tx-net" })],
            next_page_token: "",
          }),
          { status: 200 },
        );
      }
      // Transcript download → network error
      throw new TypeError("network failure");
    }) as typeof fetch;

    const db = createMemoryIndexDb();
    const sync = createZoomSyncable({ ensureZoomMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, makeZoomVault(), "zoom"), null);

    // The cycle should complete (error was swallowed), transcript was not upserted
    expect(r.cursor).not.toBeNull();
    const txCount = db
      .prepare("SELECT COUNT(*) AS c FROM item WHERE service = 'zoom' AND type = 'transcript'")
      .get() as { c: number };
    expect(txCount.c).toBe(0);
    // The parent meeting was still upserted
    const meetingCount = db
      .prepare("SELECT COUNT(*) AS c FROM item WHERE service = 'zoom' AND type = 'meeting'")
      .get() as { c: number };
    expect(meetingCount.c).toBe(1);
  });

  test("Walk B transcript: non-ok, non-429 HTTP response → kind done, upserted 0", async () => {
    // res.ok is false but status !== 429 → line 248 branch
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = urlFromFetchInput(input);
      if (url.includes("/v2/users/me/meetings")) {
        return new Response(JSON.stringify({ meetings: [], next_page_token: "" }), { status: 200 });
      }
      if (url.includes("/v2/users/me/recordings")) {
        return new Response(
          JSON.stringify({
            meetings: [makeRecording({ meetingId: 920, uuid: "uuid-920", fileId: "tx-403" })],
            next_page_token: "",
          }),
          { status: 200 },
        );
      }
      // Transcript download → 403 Forbidden
      return new Response("Forbidden", { status: 403 });
    }) as typeof fetch;

    const db = createMemoryIndexDb();
    const sync = createZoomSyncable({ ensureZoomMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, makeZoomVault(), "zoom"), null);

    // Cycle completed, no transcript upserted, meeting was upserted
    expect(r.cursor).not.toBeNull();
    const txCount = db
      .prepare("SELECT COUNT(*) AS c FROM item WHERE service = 'zoom' AND type = 'transcript'")
      .get() as { c: number };
    expect(txCount.c).toBe(0);
    expectServiceItemCount(db, "zoom", 1); // just the meeting
  });

  test("Walk B transcript: empty VTT body → mapZoomTranscriptToItem returns null (row null branch)", async () => {
    // vttToPlainText("") returns "" → plainText.trim() === "" → mapZoomTranscriptToItem returns null
    // → line 257 branch: kind done, upserted 0
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = urlFromFetchInput(input);
      if (url.includes("/v2/users/me/meetings")) {
        return new Response(JSON.stringify({ meetings: [], next_page_token: "" }), { status: 200 });
      }
      if (url.includes("/v2/users/me/recordings")) {
        return new Response(
          JSON.stringify({
            meetings: [makeRecording({ meetingId: 930, uuid: "uuid-930", fileId: "tx-empty" })],
            next_page_token: "",
          }),
          { status: 200 },
        );
      }
      // Empty VTT body — plaintext will be empty string
      return new Response("", { status: 200, headers: { "Content-Type": "text/vtt" } });
    }) as typeof fetch;

    const db = createMemoryIndexDb();
    const sync = createZoomSyncable({ ensureZoomMcpRunning: async () => {} });
    await sync.sync(syncTestContext(db, makeZoomVault(), "zoom"), null);

    // No transcript row (empty body → mapper returned null)
    const txCount = db
      .prepare("SELECT COUNT(*) AS c FROM item WHERE service = 'zoom' AND type = 'transcript'")
      .get() as { c: number };
    expect(txCount.c).toBe(0);
    // Parent meeting still upserted
    expectServiceItemCount(db, "zoom", 1);
  });

  test("Walk B processTranscriptsForMeeting: recording_files not an array is a no-op", async () => {
    // meeting["recording_files"] is not an array → early return (line 272)
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = urlFromFetchInput(input);
      if (url.includes("/v2/users/me/meetings")) {
        return new Response(JSON.stringify({ meetings: [], next_page_token: "" }), { status: 200 });
      }
      if (url.includes("/v2/users/me/recordings")) {
        return new Response(
          JSON.stringify({
            meetings: [
              {
                id: 940,
                uuid: "uuid-940",
                topic: "No files field",
                host_id: "host-1",
                start_time: "2026-06-01T10:00:00Z",
                // recording_files is a string, not an array
                recording_files: "not-an-array",
              },
            ],
            next_page_token: "",
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const db = createMemoryIndexDb();
    const sync = createZoomSyncable({ ensureZoomMcpRunning: async () => {} });
    await sync.sync(syncTestContext(db, makeZoomVault(), "zoom"), null);

    // No transcript rows; parent meeting was upserted
    const txCount = db
      .prepare("SELECT COUNT(*) AS c FROM item WHERE service = 'zoom' AND type = 'transcript'")
      .get() as { c: number };
    expect(txCount.c).toBe(0);
    expectServiceItemCount(db, "zoom", 1);
  });

  test("Walk B processTranscriptsForMeeting: missing uuid is a no-op for transcripts", async () => {
    // meetingUuid === undefined || meetingUuid === "" → early return (line 276)
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = urlFromFetchInput(input);
      if (url.includes("/v2/users/me/meetings")) {
        return new Response(JSON.stringify({ meetings: [], next_page_token: "" }), { status: 200 });
      }
      if (url.includes("/v2/users/me/recordings")) {
        return new Response(
          JSON.stringify({
            meetings: [
              {
                id: 950,
                // uuid is absent entirely
                topic: "No UUID meeting",
                host_id: "host-1",
                start_time: "2026-06-01T10:00:00Z",
                recording_files: [
                  {
                    id: "tx-nouuid",
                    file_type: "TRANSCRIPT",
                    download_url: "https://api.zoom.us/v2/transcript-download/tx-nouuid.vtt",
                  },
                ],
              },
            ],
            next_page_token: "",
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const db = createMemoryIndexDb();
    const sync = createZoomSyncable({ ensureZoomMcpRunning: async () => {} });
    await sync.sync(syncTestContext(db, makeZoomVault(), "zoom"), null);

    // No transcripts; meeting was upserted (meeting has id=950)
    const txCount = db
      .prepare("SELECT COUNT(*) AS c FROM item WHERE service = 'zoom' AND type = 'transcript'")
      .get() as { c: number };
    expect(txCount.c).toBe(0);
    expectServiceItemCount(db, "zoom", 1);
  });

  test("Walk B selectTranscriptFile: file with empty-string id is skipped", async () => {
    // fileId === "" → selectTranscriptFile returns null → skip
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = urlFromFetchInput(input);
      if (url.includes("/v2/users/me/meetings")) {
        return new Response(JSON.stringify({ meetings: [], next_page_token: "" }), { status: 200 });
      }
      if (url.includes("/v2/users/me/recordings")) {
        return new Response(
          JSON.stringify({
            meetings: [
              {
                id: 960,
                uuid: "uuid-960",
                topic: "Empty file id",
                host_id: "host-1",
                start_time: "2026-06-01T10:00:00Z",
                recording_files: [
                  {
                    id: "", // empty string id
                    file_type: "TRANSCRIPT",
                    download_url: "https://api.zoom.us/v2/transcript-download/empty.vtt",
                  },
                ],
              },
            ],
            next_page_token: "",
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const db = createMemoryIndexDb();
    const sync = createZoomSyncable({ ensureZoomMcpRunning: async () => {} });
    await sync.sync(syncTestContext(db, makeZoomVault(), "zoom"), null);

    const txCount = db
      .prepare("SELECT COUNT(*) AS c FROM item WHERE service = 'zoom' AND type = 'transcript'")
      .get() as { c: number };
    expect(txCount.c).toBe(0);
  });

  test("Walk B selectTranscriptFile: file with missing download_url is skipped", async () => {
    // downloadUrl === undefined || downloadUrl === "" → selectTranscriptFile returns null
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = urlFromFetchInput(input);
      if (url.includes("/v2/users/me/meetings")) {
        return new Response(JSON.stringify({ meetings: [], next_page_token: "" }), { status: 200 });
      }
      if (url.includes("/v2/users/me/recordings")) {
        return new Response(
          JSON.stringify({
            meetings: [
              {
                id: 970,
                uuid: "uuid-970",
                topic: "No download URL",
                host_id: "host-1",
                start_time: "2026-06-01T10:00:00Z",
                recording_files: [
                  {
                    id: "tx-nodl",
                    file_type: "TRANSCRIPT",
                    // download_url is absent
                  },
                ],
              },
            ],
            next_page_token: "",
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const db = createMemoryIndexDb();
    const sync = createZoomSyncable({ ensureZoomMcpRunning: async () => {} });
    await sync.sync(syncTestContext(db, makeZoomVault(), "zoom"), null);

    const txCount = db
      .prepare("SELECT COUNT(*) AS c FROM item WHERE service = 'zoom' AND type = 'transcript'")
      .get() as { c: number };
    expect(txCount.c).toBe(0);
  });

  test("Walk B — recordings HTTP error stops walk without advancing cursor", async () => {
    // runRecordingsWalk: outcome.kind !== "ok" on first page → return out (line 388)
    stubAllZoomUrls({ meetings: [], recordingsStatus: 500 });
    const db = createMemoryIndexDb();
    const sync = createZoomSyncable({ ensureZoomMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, makeZoomVault(), "zoom"), null);

    // Walk completed without error but advancedTo stays null → cursor lastRecordingsTo stays null
    expect(r.cursor).not.toBeNull();
    const decoded = JSON.parse(
      Buffer.from((r.cursor as string).slice(CURSOR_PREFIX.length), "base64url").toString("utf8"),
    ) as { lastRecordingsTo: string | null };
    expect(decoded.lastRecordingsTo).toBeNull();
  });

  test("Walk B — recordings pagination uses next_page_token", async () => {
    // runRecordingsWalk loop: pageResult.stop === false → pageToken = pageResult.nextPageToken
    let recordingsPage = 0;
    const urls: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = urlFromFetchInput(input);
      urls.push(url);
      if (url.includes("/v2/users/me/meetings")) {
        return new Response(JSON.stringify({ meetings: [], next_page_token: "" }), { status: 200 });
      }
      if (url.includes("/v2/users/me/recordings")) {
        recordingsPage += 1;
        if (recordingsPage === 1) {
          return new Response(
            JSON.stringify({
              meetings: [makeRecording({ meetingId: 980, uuid: "uuid-980" })],
              next_page_token: "rec-page-2-token",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        // Page 2: last page
        return new Response(JSON.stringify({ meetings: [], next_page_token: "" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // Transcript download
      return new Response(VTT_SAMPLE, { status: 200, headers: { "Content-Type": "text/vtt" } });
    }) as typeof fetch;

    const db = createMemoryIndexDb();
    const sync = createZoomSyncable({ ensureZoomMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, makeZoomVault(), "zoom"), null);

    expect(recordingsPage).toBe(2);
    // The second page URL should contain the page token
    const page2Url = urls.find((u) => u.includes("next_page_token=rec-page-2-token"));
    expect(page2Url).toBeDefined();
    // Walk completed cleanly → advancedTo was set
    const decoded = JSON.parse(
      Buffer.from((r.cursor as string).slice(CURSOR_PREFIX.length), "base64url").toString("utf8"),
    ) as { lastRecordingsTo: string | null };
    expect(decoded.lastRecordingsTo).not.toBeNull();
  });

  test("Walk B processRecordingsPage: non-array meetings field is treated as empty", async () => {
    // meetingsRaw is not an array → meetings = [] (line 353, falsy branch)
    // Results in stop === true (meetings.length === 0)
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = urlFromFetchInput(input);
      if (url.includes("/v2/users/me/meetings")) {
        return new Response(JSON.stringify({ meetings: [], next_page_token: "" }), { status: 200 });
      }
      if (url.includes("/v2/users/me/recordings")) {
        return new Response(
          JSON.stringify({
            // meetings is an object, not an array
            meetings: { not: "an-array" },
            next_page_token: "",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const db = createMemoryIndexDb();
    const sync = createZoomSyncable({ ensureZoomMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, makeZoomVault(), "zoom"), null);

    // Zero items; walk should have advanced (empty result = clean finish)
    expect(r.itemsUpserted).toBe(0);
    const decoded = JSON.parse(
      Buffer.from((r.cursor as string).slice(CURSOR_PREFIX.length), "base64url").toString("utf8"),
    ) as { lastRecordingsTo: string | null };
    // Empty page means stop=true, walk "completes" → advancedTo set
    expect(decoded.lastRecordingsTo).not.toBeNull();
  });

  test("Walk B processRecordingsPage: non-record meeting entry is skipped", async () => {
    // asRecord(meetingRaw) === undefined → continue (line 356-358)
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = urlFromFetchInput(input);
      if (url.includes("/v2/users/me/meetings")) {
        return new Response(JSON.stringify({ meetings: [], next_page_token: "" }), { status: 200 });
      }
      if (url.includes("/v2/users/me/recordings")) {
        return new Response(
          JSON.stringify({
            // One valid meeting + one non-record (null) entry
            meetings: [
              null, // asRecord(null) === undefined → skipped
              makeRecording({ meetingId: 990, uuid: "uuid-990" }),
            ],
            next_page_token: "",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(VTT_SAMPLE, { status: 200, headers: { "Content-Type": "text/vtt" } });
    }) as typeof fetch;

    const db = createMemoryIndexDb();
    const sync = createZoomSyncable({ ensureZoomMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, makeZoomVault(), "zoom"), null);

    // The valid meeting (+ transcript) should have been upserted; null entry skipped
    expect(r.itemsUpserted).toBeGreaterThanOrEqual(1);
    expectServiceItemCount(db, "zoom", 2); // meeting + transcript
  });

  test("Walk B runRecordingsWalk: non-object parsed body breaks the walk cleanly", async () => {
    // asRecord(outcome.parsed) === undefined → break, then advancedTo = window.to
    // We achieve this by returning a JSON string as the recordings response body
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = urlFromFetchInput(input);
      if (url.includes("/v2/users/me/meetings")) {
        return new Response(JSON.stringify({ meetings: [], next_page_token: "" }), { status: 200 });
      }
      if (url.includes("/v2/users/me/recordings")) {
        // A JSON number (not an object) — connectorFetch parses fine; asRecord returns undefined
        return new Response(JSON.stringify(42), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const db = createMemoryIndexDb();
    const sync = createZoomSyncable({ ensureZoomMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, makeZoomVault(), "zoom"), null);

    // Walk broke cleanly (no rate-limit) → advancedTo was still set
    expect(r.cursor).not.toBeNull();
    const decoded = JSON.parse(
      Buffer.from((r.cursor as string).slice(CURSOR_PREFIX.length), "base64url").toString("utf8"),
    ) as { lastRecordingsTo: string | null };
    expect(decoded.lastRecordingsTo).not.toBeNull();
  });

  test("recordingsPath includes next_page_token when pageToken is non-empty", async () => {
    // Indirectly exercises line 81 (recordingsPath pageToken !== "")
    // The recordings pagination test above already hits this;
    // this test verifies the URL shape explicitly.
    // NOTE: processRecordingsPage sets stop=true when meetings.length === 0,
    // so page 1 must have ≥1 meeting to allow the loop to continue to page 2.
    const urls: string[] = [];
    let recordingsPage = 0;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = urlFromFetchInput(input);
      urls.push(url);
      if (url.includes("/v2/users/me/meetings")) {
        return new Response(JSON.stringify({ meetings: [], next_page_token: "" }), { status: 200 });
      }
      if (url.includes("/v2/users/me/recordings")) {
        recordingsPage += 1;
        if (recordingsPage === 1) {
          return new Response(
            JSON.stringify({
              // Non-empty meetings list keeps stop=false so the loop continues
              meetings: [makeRecording({ meetingId: 991, uuid: "uuid-991" })],
              next_page_token: "next-token-abc",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ meetings: [], next_page_token: "" }), { status: 200 });
      }
      // Transcript download
      return new Response(VTT_SAMPLE, { status: 200, headers: { "Content-Type": "text/vtt" } });
    }) as typeof fetch;

    const db = createMemoryIndexDb();
    const sync = createZoomSyncable({ ensureZoomMcpRunning: async () => {} });
    await sync.sync(syncTestContext(db, makeZoomVault(), "zoom"), null);

    // Second recordings URL must contain the next_page_token param
    const page2Url = urls.find(
      (u) => u.includes("/v2/users/me/recordings") && u.includes("next_page_token=next-token-abc"),
    );
    expect(page2Url).toBeDefined();
  });
});
