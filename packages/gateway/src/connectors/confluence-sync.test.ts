import { expect, test } from "bun:test";

import { confluenceBodyText, createConfluenceSyncable } from "./confluence-sync.ts";
import {
  boundTestCapabilities,
  createMemoryIndexDb,
  createStubVault,
  describeWithFetchRestore,
  EMPTY_NIMBUS_VAULT,
  expectServiceItemCount,
  type SyncTestFetchParams,
  silentSyncContextExtras,
  testConnectorSyncNoop,
  urlFromFetchInput,
} from "./connector-sync-test-helpers.ts";
import { encodeWatermarkCursorV1 } from "./sync-watermark-cursor-v1.ts";

// ---------------------------------------------------------------------------
// Helper: build a minimal page result row for the Confluence search response
// ---------------------------------------------------------------------------
function makePageResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "page",
    id: "10001",
    title: "Default Page",
    history: {
      lastUpdated: {
        when: "2026-04-01T12:00:00.000+0000",
        by: {
          accountId: "acc-1",
          displayName: "Author One",
          email: "author@example.com",
        },
      },
    },
    ...overrides,
  };
}

// One-shot fetch that returns a response with the given status and body.
function makeFetch(
  status: number,
  body: string,
): (input: SyncTestFetchParams[0], _init?: SyncTestFetchParams[1]) => Promise<Response> {
  return ((_input: SyncTestFetchParams[0], _init?: SyncTestFetchParams[1]) =>
    Promise.resolve(new Response(body, { status }))) as (
    input: SyncTestFetchParams[0],
    _init?: SyncTestFetchParams[1],
  ) => Promise<Response>;
}

// Build a stub context backed by example.atlassian.net credentials
function makeCtx(vaultOverrides: Record<string, string | null> = {}) {
  const db = createMemoryIndexDb();
  const vault = createStubVault({
    "confluence.email": "u@example.com",
    "confluence.api_token": "tok",
    "confluence.base_url": "https://example.atlassian.net",
    ...vaultOverrides,
  });
  return {
    db,
    vault,
    ...silentSyncContextExtras(),
    ...boundTestCapabilities(db, vault, "confluence"),
  };
}

// Encode a valid cursor pointing to a watermark timestamp
function makeWatermarkCursor(when: string): string {
  return encodeWatermarkCursorV1("nimbus-cfl1:", { v: 1, watermark: when });
}

describeWithFetchRestore("confluence-sync", () => {
  // -------------------------------------------------------------------------
  // Basic no-op: credentials missing
  // -------------------------------------------------------------------------
  testConnectorSyncNoop(
    "no-op when credentials missing",
    () => createConfluenceSyncable({ ensureConfluenceMcpRunning: async () => {} }),
    EMPTY_NIMBUS_VAULT,
  );

  // -------------------------------------------------------------------------
  // No-op: empty base_url → wikiApiBase returns "" → syncNoopResult (line 275-276)
  // -------------------------------------------------------------------------
  test("no-op when base_url normalises to empty string", async () => {
    // normalizeAtlassianSiteBaseUrl strips slashes; "/" → "" → wikiApiBase → ""
    const ctxDb = createMemoryIndexDb();
    const ctx = {
      db: ctxDb,
      vault: createStubVault({
        "confluence.email": "u@example.com",
        "confluence.api_token": "tok",
        "confluence.base_url": "/",
      }),
      ...silentSyncContextExtras(),
      ...boundTestCapabilities(
        ctxDb,
        createStubVault({
          "confluence.email": "u@example.com",
          "confluence.api_token": "tok",
          "confluence.base_url": "/",
        }),
        "confluence",
      ),
    };
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("should not be called", { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = createConfluenceSyncable({ ensureConfluenceMcpRunning: async () => {} });
    const r = await sync.sync(ctx, null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Basic happy path: page indexed, cursor advances (existing test — kept)
  // -------------------------------------------------------------------------
  test("indexes pages from Confluence CQL search and advances cursor", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      expect(u).toContain("example.atlassian.net/wiki/rest/api/content/search");
      expect(u).toContain("cql=");
      return new Response(
        JSON.stringify({
          results: [
            {
              type: "page",
              id: "12345",
              title: "Wiki Page",
              history: {
                lastUpdated: {
                  when: "2026-04-01T12:00:00.000+0000",
                  by: {
                    accountId: "atlassian-acct-1",
                    displayName: "Wiki Author",
                    email: "wiki.author@example.com",
                  },
                },
              },
            },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const sync = createConfluenceSyncable({ ensureConfluenceMcpRunning: async () => {} });
    const ctx = {
      vault: createStubVault({
        "confluence.email": "u@example.com",
        "confluence.api_token": "tok",
        "confluence.base_url": "https://example.atlassian.net",
      }),
      db,
      ...silentSyncContextExtras(),
      ...boundTestCapabilities(
        db,
        createStubVault({
          "confluence.email": "u@example.com",
          "confluence.api_token": "tok",
          "confluence.base_url": "https://example.atlassian.net",
        }),
        "confluence",
      ),
    };
    const r = await sync.sync(ctx, null);
    expect(r.itemsUpserted).toBe(1);
    expect(r.cursor).toContain("nimbus-cfl1:");
    expectServiceItemCount(db, "confluence", 1);
    const row = db
      .prepare("SELECT author_id FROM item WHERE service = 'confluence' LIMIT 1")
      .get() as { author_id: string | null } | undefined;
    expect(row?.author_id).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // wikiApiBase: base url already ends with /wiki (line 26 branch)
  // -------------------------------------------------------------------------
  test("handles base_url that already ends with /wiki", async () => {
    const ctxDb = createMemoryIndexDb();
    const ctx = {
      db: ctxDb,
      vault: createStubVault({
        "confluence.email": "u@example.com",
        "confluence.api_token": "tok",
        "confluence.base_url": "https://example.atlassian.net/wiki",
      }),
      ...silentSyncContextExtras(),
      ...boundTestCapabilities(
        ctxDb,
        createStubVault({
          "confluence.email": "u@example.com",
          "confluence.api_token": "tok",
          "confluence.base_url": "https://example.atlassian.net/wiki",
        }),
        "confluence",
      ),
    };
    // We just need to capture the URL that was fetched; return a valid empty page
    let fetchedUrl = "";
    globalThis.fetch = ((input: SyncTestFetchParams[0]) => {
      fetchedUrl = urlFromFetchInput(input);
      return Promise.resolve(new Response(JSON.stringify({ results: [] }), { status: 200 }));
    }) as typeof fetch;

    const sync = createConfluenceSyncable({ ensureConfluenceMcpRunning: async () => {} });
    await sync.sync(ctx, null);
    // Must NOT double up /wiki/wiki
    expect(fetchedUrl).toContain("example.atlassian.net/wiki/rest/api/content/search");
    expect(fetchedUrl).not.toContain("/wiki/wiki");
  });

  // -------------------------------------------------------------------------
  // Failure responses: rate-limit (lines 181-183), non-OK (185-186), unparseable body (193)
  // -------------------------------------------------------------------------
  test.each([
    ["429 rate-limit response", 429, "rate limited", "rate limited"],
    ["non-ok HTTP response", 500, "internal server error", "Confluence sync HTTP 500"],
    ["invalid JSON body", 200, "not json {{{{", "invalid JSON"],
  ])("throws on %s", async (_label, status, body, expectedMessage) => {
    const ctx = makeCtx();
    globalThis.fetch = makeFetch(status, body) as typeof fetch;

    const sync = createConfluenceSyncable({ ensureConfluenceMcpRunning: async () => {} });
    await expect(sync.sync(ctx, null)).rejects.toThrow(expectedMessage);
  });

  // -------------------------------------------------------------------------
  // Missing results array (line 197-198)
  // -------------------------------------------------------------------------
  test("throws when results field is absent from response", async () => {
    const ctx = makeCtx();
    globalThis.fetch = makeFetch(200, JSON.stringify({ notResults: [] })) as typeof fetch;

    const sync = createConfluenceSyncable({ ensureConfluenceMcpRunning: async () => {} });
    await expect(sync.sync(ctx, null)).rejects.toThrow("missing results");
  });

  // -------------------------------------------------------------------------
  // Non-record item in results (lines 115-116)
  // -------------------------------------------------------------------------
  test("skips non-record items in results", async () => {
    const ctx = makeCtx();
    globalThis.fetch = makeFetch(
      200,
      JSON.stringify({ results: [null, 42, "string-item", makePageResult()] }),
    ) as typeof fetch;

    const sync = createConfluenceSyncable({ ensureConfluenceMcpRunning: async () => {} });
    const r = await sync.sync(ctx, null);
    // Only the valid page should be indexed; the three non-records are skipped
    expect(r.itemsUpserted).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Non-page type item (lines 118-119)
  // -------------------------------------------------------------------------
  test("skips non-page type items (e.g. blogpost)", async () => {
    const ctx = makeCtx();
    globalThis.fetch = makeFetch(
      200,
      JSON.stringify({ results: [{ type: "blogpost", id: "99", title: "Blog" }] }),
    ) as typeof fetch;

    const sync = createConfluenceSyncable({ ensureConfluenceMcpRunning: async () => {} });
    const r = await sync.sync(ctx, null);
    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(ctx.db, "confluence", 0);
  });

  // -------------------------------------------------------------------------
  // Missing id field (lines 122-123)
  // -------------------------------------------------------------------------
  test("skips page with missing id field", async () => {
    const ctx = makeCtx();
    globalThis.fetch = makeFetch(
      200,
      JSON.stringify({ results: [{ type: "page", title: "No ID Page" }] }),
    ) as typeof fetch;

    const sync = createConfluenceSyncable({ ensureConfluenceMcpRunning: async () => {} });
    const r = await sync.sync(ctx, null);
    expect(r.itemsUpserted).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Title fallback to id when title field absent (line 125)
  // -------------------------------------------------------------------------
  test("falls back to id as title when title field is absent", async () => {
    const ctx = makeCtx();
    globalThis.fetch = makeFetch(
      200,
      JSON.stringify({
        results: [
          {
            type: "page",
            id: "9999",
            // no title field
            history: {
              lastUpdated: { when: "2026-04-01T10:00:00.000+0000", by: { accountId: "acc-2" } },
            },
          },
        ],
      }),
    ) as typeof fetch;

    const sync = createConfluenceSyncable({ ensureConfluenceMcpRunning: async () => {} });
    const r = await sync.sync(ctx, null);
    expect(r.itemsUpserted).toBe(1);
    const row = ctx.db
      .prepare("SELECT title FROM item WHERE service = 'confluence' AND external_id = '9999'")
      .get() as { title: string } | undefined;
    expect(row?.title).toBe("9999");
  });

  // -------------------------------------------------------------------------
  // Title truncated to 512 chars (line 140)
  // -------------------------------------------------------------------------
  test("truncates title longer than 512 characters", async () => {
    const ctx = makeCtx();
    const longTitle = "A".repeat(600);
    globalThis.fetch = makeFetch(
      200,
      JSON.stringify({ results: [makePageResult({ title: longTitle })] }),
    ) as typeof fetch;

    const sync = createConfluenceSyncable({ ensureConfluenceMcpRunning: async () => {} });
    const r = await sync.sync(ctx, null);
    expect(r.itemsUpserted).toBe(1);
    const row = ctx.db
      .prepare("SELECT title FROM item WHERE service = 'confluence' LIMIT 1")
      .get() as { title: string } | undefined;
    expect(row?.title ?? "").toHaveLength(512);
  });

  // -------------------------------------------------------------------------
  // lastModifiedFromContent: hist field absent (lines 40-41)
  // -------------------------------------------------------------------------
  test("indexes page with missing history field (no lastModified)", async () => {
    const ctx = makeCtx();
    globalThis.fetch = makeFetch(
      200,
      JSON.stringify({
        results: [{ type: "page", id: "111", title: "No History" }],
      }),
    ) as typeof fetch;

    const sync = createConfluenceSyncable({ ensureConfluenceMcpRunning: async () => {} });
    const r = await sync.sync(ctx, null);
    expect(r.itemsUpserted).toBe(1);
    // No watermark so cursor watermark stays null → re-encode with null
    expect(r.cursor).toContain("nimbus-cfl1:");
  });

  // -------------------------------------------------------------------------
  // lastModifiedFromContent: hist present but lastUpdated absent (lines 44-45)
  // -------------------------------------------------------------------------
  test("indexes page where history exists but lastUpdated is missing", async () => {
    const ctx = makeCtx();
    globalThis.fetch = makeFetch(
      200,
      JSON.stringify({
        results: [{ type: "page", id: "222", title: "Partial History", history: {} }],
      }),
    ) as typeof fetch;

    const sync = createConfluenceSyncable({ ensureConfluenceMcpRunning: async () => {} });
    const r = await sync.sync(ctx, null);
    expect(r.itemsUpserted).toBe(1);
  });

  // -------------------------------------------------------------------------
  // confluenceLastUpdatedBy: author without email — resolves by accountId only
  // (lines 52-54 / resolveConfluenceAuthorId fallback path lines 83-86)
  // -------------------------------------------------------------------------
  test("resolves author when email is absent (display-name only path)", async () => {
    const ctx = makeCtx();
    globalThis.fetch = makeFetch(
      200,
      JSON.stringify({
        results: [
          makePageResult({
            history: {
              lastUpdated: {
                when: "2026-04-02T10:00:00.000+0000",
                by: {
                  accountId: "acc-no-email",
                  displayName: "No Email Author",
                  // email intentionally absent
                },
              },
            },
          }),
        ],
      }),
    ) as typeof fetch;

    const sync = createConfluenceSyncable({ ensureConfluenceMcpRunning: async () => {} });
    const r = await sync.sync(ctx, null);
    expect(r.itemsUpserted).toBe(1);
    const row = ctx.db
      .prepare("SELECT author_id FROM item WHERE service = 'confluence' LIMIT 1")
      .get() as { author_id: string | null } | undefined;
    // resolvePersonForSync returns a person id
    expect(row?.author_id).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // resolveConfluenceAuthorId: accountId empty/absent → returns null (lines 71-72)
  // -------------------------------------------------------------------------
  test("sets null authorId when by.accountId is empty", async () => {
    const ctx = makeCtx();
    globalThis.fetch = makeFetch(
      200,
      JSON.stringify({
        results: [
          makePageResult({
            history: {
              lastUpdated: {
                when: "2026-04-02T10:00:00.000+0000",
                by: { accountId: "", displayName: "Ghost" },
              },
            },
          }),
        ],
      }),
    ) as typeof fetch;

    const sync = createConfluenceSyncable({ ensureConfluenceMcpRunning: async () => {} });
    const r = await sync.sync(ctx, null);
    expect(r.itemsUpserted).toBe(1);
    const row = ctx.db
      .prepare("SELECT author_id FROM item WHERE service = 'confluence' LIMIT 1")
      .get() as { author_id: string | null } | undefined;
    expect(row?.author_id).toBeNull();
  });

  // -------------------------------------------------------------------------
  // resolveConfluenceAuthorId: email present but no @ sign → fallback path
  // (line 76 false branch)
  // -------------------------------------------------------------------------
  test("uses displayName-only path when email has no @ character", async () => {
    const ctx = makeCtx();
    globalThis.fetch = makeFetch(
      200,
      JSON.stringify({
        results: [
          makePageResult({
            history: {
              lastUpdated: {
                when: "2026-04-02T10:00:00.000+0000",
                by: {
                  accountId: "acc-bad-email",
                  displayName: "Bad Email",
                  email: "not-an-email",
                },
              },
            },
          }),
        ],
      }),
    ) as typeof fetch;

    const sync = createConfluenceSyncable({ ensureConfluenceMcpRunning: async () => {} });
    const r = await sync.sync(ctx, null);
    expect(r.itemsUpserted).toBe(1);
  });

  // -------------------------------------------------------------------------
  // confluenceLastUpdatedBy: by field absent → authorId null (lines 53-54, 135)
  // -------------------------------------------------------------------------
  test("sets null authorId when lastUpdated.by is absent", async () => {
    const ctx = makeCtx();
    globalThis.fetch = makeFetch(
      200,
      JSON.stringify({
        results: [
          {
            type: "page",
            id: "333",
            title: "No By Field",
            history: { lastUpdated: { when: "2026-04-02T10:00:00.000+0000" } },
          },
        ],
      }),
    ) as typeof fetch;

    const sync = createConfluenceSyncable({ ensureConfluenceMcpRunning: async () => {} });
    const r = await sync.sync(ctx, null);
    expect(r.itemsUpserted).toBe(1);
    const row = ctx.db
      .prepare("SELECT author_id FROM item WHERE service = 'confluence' LIMIT 1")
      .get() as { author_id: string | null } | undefined;
    expect(row?.author_id).toBeNull();
  });

  // -------------------------------------------------------------------------
  // confluenceWatermarkStopOrBumpMax: watermark stop branch
  // An item whose `when` is ≤ existing watermark causes shouldStop = true (lines 97-98)
  // -------------------------------------------------------------------------
  test("stops pagination when item is at or before the watermark", async () => {
    // watermark = 2026-04-01T12:00:00Z; item when = 2026-04-01T10:00:00Z (older → stop)
    const watermarkCursor = makeWatermarkCursor("2026-04-01T12:00:00.000+0000");
    const ctx = makeCtx();

    let callCount = 0;
    globalThis.fetch = ((_input: SyncTestFetchParams[0]) => {
      callCount += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            results: [
              makePageResult({
                history: {
                  lastUpdated: {
                    when: "2026-04-01T10:00:00.000+0000", // older than watermark → stop
                    by: { accountId: "acc-1", displayName: "A", email: "a@b.com" },
                  },
                },
              }),
            ],
          }),
          { status: 200 },
        ),
      );
    }) as typeof fetch;

    const sync = createConfluenceSyncable({ ensureConfluenceMcpRunning: async () => {} });
    const r = await sync.sync(ctx, watermarkCursor);
    // The item was at/before watermark so upserted = 0 and shouldStop caused early exit
    expect(r.itemsUpserted).toBe(0);
    // Only one fetch call (stopped immediately)
    expect(callCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // confluenceWatermarkStopOrBumpMax: when empty string → returns false (line 94)
  // -------------------------------------------------------------------------
  test("treats page with empty when string as no-watermark (upserts without stopping)", async () => {
    const ctx = makeCtx();
    globalThis.fetch = makeFetch(
      200,
      JSON.stringify({
        results: [
          {
            type: "page",
            id: "444",
            title: "Empty When",
            history: { lastUpdated: { when: "" } },
          },
        ],
      }),
    ) as typeof fetch;

    const sync = createConfluenceSyncable({ ensureConfluenceMcpRunning: async () => {} });
    const r = await sync.sync(ctx, null);
    expect(r.itemsUpserted).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Pagination: two pages of results (lines 225-234)
  // First batch full (25 items — the page-fetch limit), second batch shorter → stops
  // -------------------------------------------------------------------------
  test("fetches multiple pages when first batch is full (limit=25)", async () => {
    const ctx = makeCtx();
    let callCount = 0;

    globalThis.fetch = ((_input: SyncTestFetchParams[0]) => {
      callCount += 1;
      let results: unknown[];
      if (callCount === 1) {
        // Full batch of 25 pages — the server can never return more than the
        // requested `limit`, so this pins the `results.length === limit`
        // boundary that keeps pagination going.
        results = Array.from({ length: 25 }, (_, i) =>
          makePageResult({ id: String(i + 1), title: `Page ${String(i + 1)}` }),
        );
      } else {
        // Second batch — partial, terminates pagination
        results = [makePageResult({ id: "9001", title: "Last Page" })];
      }
      return Promise.resolve(new Response(JSON.stringify({ results }), { status: 200 }));
    }) as typeof fetch;

    const sync = createConfluenceSyncable({ ensureConfluenceMcpRunning: async () => {} });
    const r = await sync.sync(ctx, null);
    expect(callCount).toBe(2);
    expect(r.itemsUpserted).toBe(26);
    expectServiceItemCount(ctx.db, "confluence", 26);
  });

  // -------------------------------------------------------------------------
  // Cursor decode: malformed cursor string → treated as null watermark (line 281)
  // -------------------------------------------------------------------------
  test("handles malformed cursor gracefully (falls back to initial sync)", async () => {
    const ctx = makeCtx();
    globalThis.fetch = makeFetch(
      200,
      JSON.stringify({ results: [makePageResult()] }),
    ) as typeof fetch;

    const sync = createConfluenceSyncable({ ensureConfluenceMcpRunning: async () => {} });
    // A cursor that doesn't match the prefix → decodeCursor returns null → watermarkMs = -1
    const r = await sync.sync(ctx, "garbage-cursor-value");
    expect(r.itemsUpserted).toBe(1);
    // CQL should use the initial-depth variant (no watermark)
    expect(r.cursor).toContain("nimbus-cfl1:");
  });

  // -------------------------------------------------------------------------
  // Cursor with valid watermark → uses incremental CQL (line 284)
  // -------------------------------------------------------------------------
  test("uses incremental CQL when a valid watermark cursor is supplied", async () => {
    const watermark = "2026-04-01T12:00:00.000+0000";
    const cursor = makeWatermarkCursor(watermark);
    const ctx = makeCtx();

    let fetchedUrl = "";
    globalThis.fetch = ((input: SyncTestFetchParams[0]) => {
      fetchedUrl = urlFromFetchInput(input);
      return Promise.resolve(new Response(JSON.stringify({ results: [] }), { status: 200 }));
    }) as typeof fetch;

    const sync = createConfluenceSyncable({ ensureConfluenceMcpRunning: async () => {} });
    await sync.sync(ctx, cursor);
    // CQL should reference lastModified > "<watermark>" (incremental branch)
    expect(fetchedUrl).toContain("lastModified+%3E");
  });

  // -------------------------------------------------------------------------
  // maxEdited advances (line 100): multiple pages with newer items
  // -------------------------------------------------------------------------
  test("advances cursor watermark to the newest item when when-fields differ", async () => {
    const ctx = makeCtx();
    globalThis.fetch = makeFetch(
      200,
      JSON.stringify({
        results: [
          makePageResult({
            id: "A1",
            history: {
              lastUpdated: { when: "2026-06-01T10:00:00.000+0000", by: { accountId: "a" } },
            },
          }),
          makePageResult({
            id: "A2",
            history: {
              lastUpdated: { when: "2026-06-02T10:00:00.000+0000", by: { accountId: "b" } },
            },
          }),
        ],
      }),
    ) as typeof fetch;

    const sync = createConfluenceSyncable({ ensureConfluenceMcpRunning: async () => {} });
    const r = await sync.sync(ctx, null);
    expect(r.itemsUpserted).toBe(2);
    // The cursor must encode a watermark (not null), pointing to the max
    expect(r.cursor).toContain("nimbus-cfl1:");
    // Decode and verify the watermark is the newer one
    const decoded = Buffer.from(r.cursor!.replace("nimbus-cfl1:", ""), "base64url").toString(
      "utf8",
    );
    const obj = JSON.parse(decoded) as { watermark: string };
    expect(obj.watermark).toBe("2026-06-02T10:00:00.000+0000");
  });

  // -------------------------------------------------------------------------
  // Empty results: cursor watermark carries forward (line 237 maxEdited === "")
  // -------------------------------------------------------------------------
  test("carries the previous watermark forward when there are no new results", async () => {
    const prevWatermark = "2026-05-01T00:00:00.000+0000";
    const cursor = makeWatermarkCursor(prevWatermark);
    const ctx = makeCtx();
    globalThis.fetch = makeFetch(200, JSON.stringify({ results: [] })) as typeof fetch;

    const sync = createConfluenceSyncable({ ensureConfluenceMcpRunning: async () => {} });
    const r = await sync.sync(ctx, cursor);
    expect(r.itemsUpserted).toBe(0);
    // Cursor should re-encode the same watermark
    const decoded = Buffer.from(r.cursor!.replace("nimbus-cfl1:", ""), "base64url").toString(
      "utf8",
    );
    const obj = JSON.parse(decoded) as { watermark: string };
    expect(obj.watermark).toBe(prevWatermark);
  });

  // -------------------------------------------------------------------------
  // modifiedAt: when field absent → uses syncTime (line 132 opts.syncTime branch)
  // -------------------------------------------------------------------------
  test("uses syncTime as modifiedAt when when field is absent from history", async () => {
    const ctx = makeCtx();
    const before = Date.now();
    globalThis.fetch = makeFetch(
      200,
      JSON.stringify({
        results: [
          {
            type: "page",
            id: "555",
            title: "No Date",
            // history present but no lastUpdated → when === undefined
            history: {},
          },
        ],
      }),
    ) as typeof fetch;

    const sync = createConfluenceSyncable({ ensureConfluenceMcpRunning: async () => {} });
    const r = await sync.sync(ctx, null);
    const after = Date.now();
    expect(r.itemsUpserted).toBe(1);
    const row = ctx.db
      .prepare("SELECT modified_at FROM item WHERE service = 'confluence' LIMIT 1")
      .get() as { modified_at: number } | undefined;
    // modified_at should be approximately now (syncTime fallback)
    expect(row?.modified_at).toBeGreaterThanOrEqual(before);
    expect(row?.modified_at).toBeLessThanOrEqual(after + 100);
  });

  // -------------------------------------------------------------------------
  // No-op: individual credential absent (lines 265-272): only token missing
  // -------------------------------------------------------------------------
  test("no-op when api_token is empty string", async () => {
    const ctxDb = createMemoryIndexDb();
    const ctx = {
      db: ctxDb,
      vault: createStubVault({
        "confluence.email": "u@example.com",
        "confluence.api_token": "",
        "confluence.base_url": "https://example.atlassian.net",
      }),
      ...silentSyncContextExtras(),
      ...boundTestCapabilities(
        ctxDb,
        createStubVault({
          "confluence.email": "u@example.com",
          "confluence.api_token": "",
          "confluence.base_url": "https://example.atlassian.net",
        }),
        "confluence",
      ),
    };
    globalThis.fetch = (() =>
      Promise.resolve(new Response("nope", { status: 200 }))) as unknown as typeof fetch;

    const sync = createConfluenceSyncable({ ensureConfluenceMcpRunning: async () => {} });
    const r = await sync.sync(ctx, null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Full-body indexing via the body.storage expand (V48)
  // -------------------------------------------------------------------------
  test("indexes the storage body as full text", async () => {
    const ctx = makeCtx();
    globalThis.fetch = makeFetch(
      200,
      JSON.stringify({
        results: [
          makePageResult({
            body: { storage: { value: "<p>Hello <b>there</b></p>", representation: "storage" } },
          }),
        ],
      }),
    ) as typeof fetch;
    await createConfluenceSyncable({ ensureConfluenceMcpRunning: async () => {} }).sync(ctx, null);
    const row = ctx.db
      .query<{ body: string; body_complete: number }, []>(
        "SELECT body, body_complete FROM item WHERE service = 'confluence'",
      )
      .get();
    expect(row?.body).toBe("Hello there");
    expect(row?.body_complete).toBe(1);
  });

  test("requests the body.storage expand at limit 25", async () => {
    const seen: string[] = [];
    const ctx = makeCtx();
    globalThis.fetch = ((input: SyncTestFetchParams[0]) => {
      seen.push(urlFromFetchInput(input));
      return Promise.resolve(new Response(JSON.stringify({ results: [] }), { status: 200 }));
    }) as typeof fetch;
    await createConfluenceSyncable({ ensureConfluenceMcpRunning: async () => {} }).sync(ctx, null);
    expect(seen[0]).toContain("body.storage");
    expect(seen[0]).toContain("limit=25");
  });

  test("a page with no body.storage indexes title-only and does not claim completeness", async () => {
    const ctx = makeCtx();
    globalThis.fetch = makeFetch(
      200,
      JSON.stringify({ results: [makePageResult()] }),
    ) as typeof fetch;
    await createConfluenceSyncable({ ensureConfluenceMcpRunning: async () => {} }).sync(ctx, null);
    const row = ctx.db
      .query<{ body: string; body_complete: number }, []>(
        "SELECT body, body_complete FROM item WHERE service = 'confluence'",
      )
      .get();
    expect(row?.body_complete).toBe(0);
  });

  test("a storage body over the prose cap clamps and reports incomplete", async () => {
    const ctx = makeCtx();
    globalThis.fetch = makeFetch(
      200,
      JSON.stringify({
        results: [makePageResult({ body: { storage: { value: `<p>${"z".repeat(20_000)}</p>` } } })],
      }),
    ) as typeof fetch;
    await createConfluenceSyncable({ ensureConfluenceMcpRunning: async () => {} }).sync(ctx, null);
    const row = ctx.db
      .query<{ len: number; body_complete: number }, []>(
        "SELECT length(body) AS len, body_complete FROM item WHERE service = 'confluence'",
      )
      .get();
    expect(row?.len).toBe(16_384);
    expect(row?.body_complete).toBe(0);
  });

  test("macro markup strips to its inner text", () => {
    expect(
      confluenceBodyText({
        body: {
          storage: {
            value:
              '<ac:structured-macro ac:name="info"><ac:rich-text-body><p>Note</p></ac:rich-text-body></ac:structured-macro>',
          },
        },
      }),
    ).toBe("Note");
  });
});
