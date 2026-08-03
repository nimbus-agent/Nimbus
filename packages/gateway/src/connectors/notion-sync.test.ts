import { expect, test } from "bun:test";
import { ProviderRateLimiter } from "../sync/rate-limiter.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  describeWithFetchRestore,
  EMPTY_NIMBUS_VAULT,
  expectServiceItemCount,
  type SyncTestFetchParams,
  silentSyncContextExtras,
  syncTestContext,
  testConnectorSyncNoop,
  urlFromFetchInput,
} from "./connector-sync-test-helpers.ts";
import { NOTION_BODY_FETCH_BUDGET_PER_SYNC } from "./notion-page-body.ts";
import { createNotionSyncable } from "./notion-sync.ts";
import { encodeWatermarkCursorV1 } from "./sync-watermark-cursor-v1.ts";

/** Build a valid oauth payload accepted by getValidNotionAccessToken */
function makeOauthPayload(overrides?: Partial<{ accessToken: string; expiresAt: number }>): string {
  return JSON.stringify({
    accessToken: overrides?.accessToken ?? "notion_secret_test",
    refreshToken: "refresh_test",
    expiresAt: overrides?.expiresAt ?? Date.now() + 86_400_000,
    scopes: [] as string[],
  });
}

/** A minimal valid page result object */
function makePage(
  id: string,
  opts?: {
    last_edited_time?: string;
    created_by?: unknown;
    properties?: unknown;
    object?: string;
  },
): Record<string, unknown> {
  return {
    object: opts?.object ?? "page",
    id,
    last_edited_time: opts?.last_edited_time ?? "2026-04-01T12:00:00.000Z",
    created_by: opts?.created_by ?? { object: "user", id: "notion-user-abc" },
    properties: opts?.properties ?? {
      title: {
        type: "title",
        title: [{ type: "text", text: { content: "Hello" } }],
      },
    },
  };
}

/** Install a fetch stub that returns a single-page Notion search response */
function installFetchSinglePage(
  results: unknown[],
  opts?: { hasMore?: boolean; nextCursor?: string | null },
): void {
  globalThis.fetch = (async (): Promise<Response> => {
    return new Response(
      JSON.stringify({
        results,
        has_more: opts?.hasMore ?? false,
        next_cursor: opts?.nextCursor ?? null,
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
}

/** Serve one search page, then block children per parent id. */
function installSearchAndBlocks(
  pages: Record<string, unknown>[],
  blocks: Record<string, unknown[]>,
): { count: () => number } {
  let blockCalls = 0;
  globalThis.fetch = ((input: SyncTestFetchParams[0]) => {
    const url = urlFromFetchInput(input);
    if (url.includes("/v1/search")) {
      return Promise.resolve(
        new Response(JSON.stringify({ results: pages, has_more: false, next_cursor: null }), {
          status: 200,
        }),
      );
    }
    blockCalls += 1;
    const m = /\/v1\/blocks\/([^/?]+)\/children/.exec(url);
    const parent = decodeURIComponent(m?.[1] ?? "");
    return Promise.resolve(
      new Response(
        JSON.stringify({ results: blocks[parent] ?? [], has_more: false, next_cursor: null }),
        { status: 200 },
      ),
    );
  }) as unknown as typeof fetch;
  return { count: () => blockCalls };
}

describeWithFetchRestore("notion-sync", () => {
  testConnectorSyncNoop(
    "no-op when notion.oauth missing",
    () => createNotionSyncable({ ensureNotionMcpRunning: async () => {} }),
    EMPTY_NIMBUS_VAULT,
  );

  // ── covers line 247–249: getValidNotionAccessToken throws → syncNoopResult ──
  test("no-op when oauth payload is malformed (getValidNotionAccessToken throws)", async () => {
    const db = createMemoryIndexDb();
    // "notion.oauth" present but payload is unparseable JSON
    const vault = createStubVault({ "notion.oauth": "not-valid-json" });
    const sync = createNotionSyncable({ ensureNotionMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, vault), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.itemsDeleted).toBe(0);
    expect(r.cursor).toBeNull();
  });

  test("indexes pages from Notion search and advances cursor", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = (async (
      input: SyncTestFetchParams[0],
      init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      const u = urlFromFetchInput(input);
      expect(u).toContain("api.notion.com/v1/search");
      const body =
        init?.body !== undefined && typeof init.body === "string" ? JSON.parse(init.body) : {};
      expect(body.filter?.value).toBe("page");
      return new Response(
        JSON.stringify({
          results: [
            {
              object: "page",
              id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
              last_edited_time: "2026-04-01T12:00:00.000Z",
              created_by: { object: "user", id: "notion-user-abc" },
              properties: {
                title: {
                  type: "title",
                  title: [{ type: "text", text: { content: "Hello" } }],
                },
              },
            },
          ],
          has_more: false,
          next_cursor: null,
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const sync = createNotionSyncable({ ensureNotionMcpRunning: async () => {} });
    const ctx = {
      vault: createStubVault({ "notion.oauth": makeOauthPayload() }),
      db,
      ...silentSyncContextExtras(),
    };
    const r = await sync.sync(ctx, null);
    expect(r.itemsUpserted).toBe(1);
    expect(r.cursor).toContain("nimbus-ntn1:");
    expectServiceItemCount(db, "notion", 1);
    const row = db.prepare("SELECT author_id FROM item WHERE service = 'notion' LIMIT 1").get() as
      | { author_id: string | null }
      | undefined;
    expect(row?.author_id).not.toBeNull();
  });

  // ── covers lines 109–111 (429), 113–114 (non-ok status) and 117–121 (unparseable body) ──
  test.each([
    ["HTTP 429 rate-limited response", 429, "", "rate limited"],
    ["non-ok HTTP response", 500, "Internal Server Error", "Notion sync HTTP 500"],
    ["invalid JSON response body", 200, "not json at all!!!", "invalid JSON"],
  ])("throws on %s", async (_label, status, body, expectedMessage) => {
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(body, { status });
    }) as unknown as typeof fetch;

    const db = createMemoryIndexDb();
    const sync = createNotionSyncable({ ensureNotionMcpRunning: async () => {} });
    const ctx = {
      vault: createStubVault({ "notion.oauth": makeOauthPayload() }),
      db,
      ...silentSyncContextExtras(),
    };
    await expect(sync.sync(ctx, null)).rejects.toThrow(expectedMessage);
  });

  // ── covers lines 122–124: valid JSON but not a record (e.g. array) ──
  test("throws when response JSON is not a record", async () => {
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(JSON.stringify([1, 2, 3]), { status: 200 });
    }) as unknown as typeof fetch;

    const db = createMemoryIndexDb();
    const sync = createNotionSyncable({ ensureNotionMcpRunning: async () => {} });
    const ctx = {
      vault: createStubVault({ "notion.oauth": makeOauthPayload() }),
      db,
      ...silentSyncContextExtras(),
    };
    await expect(sync.sync(ctx, null)).rejects.toThrow("invalid response");
  });

  // ── covers lines 126–128: missing results field ──
  test("throws when results field is missing", async () => {
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(JSON.stringify({ has_more: false }), { status: 200 });
    }) as unknown as typeof fetch;

    const db = createMemoryIndexDb();
    const sync = createNotionSyncable({ ensureNotionMcpRunning: async () => {} });
    const ctx = {
      vault: createStubVault({ "notion.oauth": makeOauthPayload() }),
      db,
      ...silentSyncContextExtras(),
    };
    await expect(sync.sync(ctx, null)).rejects.toThrow("missing results");
  });

  // ── covers lines 177–179: non-record item in results → skipped ──
  test("skips non-record items in results", async () => {
    installFetchSinglePage([null, "string", 42, makePage("page-id-001")]);
    const db = createMemoryIndexDb();
    const sync = createNotionSyncable({ ensureNotionMcpRunning: async () => {} });
    const ctx = {
      vault: createStubVault({ "notion.oauth": makeOauthPayload() }),
      db,
      ...silentSyncContextExtras(),
    };
    const r = await sync.sync(ctx, null);
    // Only the valid page should be indexed; nulls/strings/numbers skipped
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "notion", 1);
  });

  // ── covers lines 180–181: object !== "page" → skipped ──
  test("skips items whose object field is not 'page'", async () => {
    installFetchSinglePage([
      { object: "database", id: "db-001", last_edited_time: "2026-04-01T12:00:00.000Z" },
      { object: "block", id: "blk-001", last_edited_time: "2026-04-01T12:00:00.000Z" },
      makePage("page-id-001"),
    ]);
    const db = createMemoryIndexDb();
    const sync = createNotionSyncable({ ensureNotionMcpRunning: async () => {} });
    const ctx = {
      vault: createStubVault({ "notion.oauth": makeOauthPayload() }),
      db,
      ...silentSyncContextExtras(),
    };
    const r = await sync.sync(ctx, null);
    expect(r.itemsUpserted).toBe(1);
  });

  // ── covers lines 183–185: missing/empty id → skipped ──
  test("skips pages with missing or empty id", async () => {
    installFetchSinglePage([
      { object: "page", last_edited_time: "2026-04-01T12:00:00.000Z" }, // no id
      { object: "page", id: "", last_edited_time: "2026-04-01T12:00:00.000Z" }, // empty id
      makePage("valid-page-id"),
    ]);
    const db = createMemoryIndexDb();
    const sync = createNotionSyncable({ ensureNotionMcpRunning: async () => {} });
    const ctx = {
      vault: createStubVault({ "notion.oauth": makeOauthPayload() }),
      db,
      ...silentSyncContextExtras(),
    };
    const r = await sync.sync(ctx, null);
    expect(r.itemsUpserted).toBe(1);
  });

  // ── covers lines 147–149: edited undefined/empty → watermark returns "continue" ──
  test("processes pages with missing last_edited_time using syncTime as modifiedAt", async () => {
    installFetchSinglePage([
      { object: "page", id: "page-no-time" }, // no last_edited_time
      { object: "page", id: "page-empty-time", last_edited_time: "" }, // empty
    ]);
    const db = createMemoryIndexDb();
    const sync = createNotionSyncable({ ensureNotionMcpRunning: async () => {} });
    const ctx = {
      vault: createStubVault({ "notion.oauth": makeOauthPayload() }),
      db,
      ...silentSyncContextExtras(),
    };
    const r = await sync.sync(ctx, null);
    // Both pages have no time → neither advances maxEdited, both should still upsert
    expect(r.itemsUpserted).toBe(2);
    expectServiceItemCount(db, "notion", 2);
  });

  // ── covers lines 150–152: watermark stop when item older than watermark ──
  test("stops accumulating when item is at or before watermark", async () => {
    const db = createMemoryIndexDb();
    // First sync: index a page so we get a cursor with a watermark
    installFetchSinglePage([makePage("page-a", { last_edited_time: "2026-04-02T12:00:00.000Z" })]);
    const vault = createStubVault({ "notion.oauth": makeOauthPayload() });
    const sync = createNotionSyncable({ ensureNotionMcpRunning: async () => {} });
    const ctx = syncTestContext(db, vault);
    const r1 = await sync.sync(ctx, null);
    expect(r1.cursor).not.toBeNull();

    // Second sync with two pages: one older than watermark (should trigger stop), one same
    installFetchSinglePage([
      // older → should trigger watermark stop
      makePage("page-old", { last_edited_time: "2026-03-01T00:00:00.000Z" }),
      makePage("page-never-reached", { last_edited_time: "2026-02-01T00:00:00.000Z" }),
    ]);
    const r2 = await sync.sync(ctx, r1.cursor);
    // The loop should have stopped after the first page (watermark hit)
    // page-old and page-never-reached were NOT upserted (watermark stop)
    expect(r2.itemsUpserted).toBe(0);
  });

  // ── covers lines 274–276: shouldStop → break out of pagination loop ──
  test("breaks pagination loop when watermark stop is triggered", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({ "notion.oauth": makeOauthPayload() });
    const sync = createNotionSyncable({ ensureNotionMcpRunning: async () => {} });
    const ctx = syncTestContext(db, vault);

    // First sync to establish a cursor/watermark
    installFetchSinglePage([makePage("page-a", { last_edited_time: "2026-05-01T12:00:00.000Z" })]);
    const r1 = await sync.sync(ctx, null);
    expect(r1.cursor).not.toBeNull();

    // Second sync: has_more=true but first result is older than watermark → should stop immediately
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          results: [makePage("old-page", { last_edited_time: "2026-01-01T00:00:00.000Z" })],
          has_more: true,
          next_cursor: "some-cursor-value",
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const r2 = await sync.sync(ctx, r1.cursor);
    expect(r2.itemsUpserted).toBe(0);
    // cursor should be retained (watermark unchanged)
  });

  // ── covers lines 277–279: !batch.hasMore → break ──
  test("stops pagination when has_more is false", async () => {
    installFetchSinglePage([makePage("page-a")], { hasMore: false });
    const db = createMemoryIndexDb();
    const sync = createNotionSyncable({ ensureNotionMcpRunning: async () => {} });
    const ctx = {
      vault: createStubVault({ "notion.oauth": makeOauthPayload() }),
      db,
      ...silentSyncContextExtras(),
    };
    const r = await sync.sync(ctx, null);
    expect(r.itemsUpserted).toBe(1);
    expect(r.hasMore).toBe(false);
  });

  // ── covers lines 280–282: nextCursor is undefined → break ──
  test("stops pagination when next_cursor is null/empty", async () => {
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          results: [makePage("page-a")],
          has_more: true,
          next_cursor: "", // empty string → nextCursor becomes undefined → break
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const db = createMemoryIndexDb();
    const sync = createNotionSyncable({ ensureNotionMcpRunning: async () => {} });
    const ctx = {
      vault: createStubVault({ "notion.oauth": makeOauthPayload() }),
      db,
      ...silentSyncContextExtras(),
    };
    const r = await sync.sync(ctx, null);
    expect(r.itemsUpserted).toBe(1);
  });

  // ── covers lines 283, 81: next_cursor present + multi-page pagination ──
  test("follows pagination cursor across multiple pages", async () => {
    let searchCallCount = 0;
    globalThis.fetch = (async (
      input: SyncTestFetchParams[0],
      init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      const url = urlFromFetchInput(input);
      if (!url.includes("/v1/search")) {
        // Block-children request from the body walk: no children.
        return new Response(JSON.stringify({ results: [], has_more: false, next_cursor: null }), {
          status: 200,
        });
      }
      searchCallCount += 1;
      const body =
        init?.body !== undefined && typeof init.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : {};
      if (searchCallCount === 1) {
        // First page: no start_cursor in body
        expect(body["start_cursor"]).toBeUndefined();
        return new Response(
          JSON.stringify({
            results: [makePage("page-1", { last_edited_time: "2026-04-03T12:00:00.000Z" })],
            has_more: true,
            next_cursor: "cursor-page-2",
          }),
          { status: 200 },
        );
      }
      // Second page: start_cursor should be set
      expect(body["start_cursor"]).toBe("cursor-page-2");
      return new Response(
        JSON.stringify({
          results: [makePage("page-2", { last_edited_time: "2026-04-02T12:00:00.000Z" })],
          has_more: false,
          next_cursor: null,
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const db = createMemoryIndexDb();
    const sync = createNotionSyncable({ ensureNotionMcpRunning: async () => {} });
    const ctx = {
      vault: createStubVault({ "notion.oauth": makeOauthPayload() }),
      db,
      ...silentSyncContextExtras(),
    };
    const r = await sync.sync(ctx, null);
    expect(searchCallCount).toBe(2);
    expect(r.itemsUpserted).toBe(2);
    expectServiceItemCount(db, "notion", 2);
  });

  // ── covers line 132: next_cursor present in response ──
  test("captures next_cursor string from response", async () => {
    let searchCallCount = 0;
    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const url = urlFromFetchInput(input);
      if (!url.includes("/v1/search")) {
        // Block-children request from the body walk: no children.
        return new Response(JSON.stringify({ results: [], has_more: false, next_cursor: null }), {
          status: 200,
        });
      }
      searchCallCount += 1;
      if (searchCallCount === 1) {
        return new Response(
          JSON.stringify({
            results: [makePage("page-1", { last_edited_time: "2026-04-03T12:00:00.000Z" })],
            has_more: true,
            next_cursor: "the-cursor-value",
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          results: [],
          has_more: false,
          next_cursor: null,
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const db = createMemoryIndexDb();
    const sync = createNotionSyncable({ ensureNotionMcpRunning: async () => {} });
    const ctx = {
      vault: createStubVault({ "notion.oauth": makeOauthPayload() }),
      db,
      ...silentSyncContextExtras(),
    };
    await sync.sync(ctx, null);
    expect(searchCallCount).toBe(2);
  });

  // ── covers line 253: malformed cursor → treated as null watermark ──
  test("handles malformed cursor gracefully (treats as null watermark)", async () => {
    installFetchSinglePage([makePage("page-a")]);
    const db = createMemoryIndexDb();
    const sync = createNotionSyncable({ ensureNotionMcpRunning: async () => {} });
    const ctx = {
      vault: createStubVault({ "notion.oauth": makeOauthPayload() }),
      db,
      ...silentSyncContextExtras(),
    };
    // Pass a cursor that doesn't match the nimbus-ntn1: prefix
    const r = await sync.sync(ctx, "totally-invalid-cursor-garbage");
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "notion", 1);
  });

  // ── covers line 63: properties is not a record → returns "Untitled" ──
  test("uses 'Untitled' when properties is not a record", async () => {
    installFetchSinglePage([
      {
        object: "page",
        id: "page-no-props",
        last_edited_time: "2026-04-01T12:00:00.000Z",
        properties: null, // not a record
      },
      {
        object: "page",
        id: "page-arr-props",
        last_edited_time: "2026-04-01T12:00:00.000Z",
        properties: [1, 2, 3], // array, not a record
      },
    ]);
    const db = createMemoryIndexDb();
    const sync = createNotionSyncable({ ensureNotionMcpRunning: async () => {} });
    const ctx = {
      vault: createStubVault({ "notion.oauth": makeOauthPayload() }),
      db,
      ...silentSyncContextExtras(),
    };
    const r = await sync.sync(ctx, null);
    expect(r.itemsUpserted).toBe(2);
    const rows = db
      .prepare("SELECT title FROM item WHERE service = 'notion' ORDER BY title")
      .all() as Array<{ title: string }>;
    for (const row of rows) {
      expect(row.title).toBe("Untitled");
    }
  });

  // ── covers lines 67–70: title extraction iterates values; fallback Untitled ──
  test("uses 'Untitled' when no property has type='title'", async () => {
    installFetchSinglePage([
      makePage("page-no-title-prop", {
        properties: {
          status: { type: "select", select: { name: "Done" } },
          number: { type: "number", number: 42 },
        },
      }),
    ]);
    const db = createMemoryIndexDb();
    const sync = createNotionSyncable({ ensureNotionMcpRunning: async () => {} });
    const ctx = {
      vault: createStubVault({ "notion.oauth": makeOauthPayload() }),
      db,
      ...silentSyncContextExtras(),
    };
    await sync.sync(ctx, null);
    const row = db.prepare("SELECT title FROM item WHERE service = 'notion' LIMIT 1").get() as {
      title: string;
    };
    expect(row.title).toBe("Untitled");
  });

  // ── covers line 54: property type is not 'title' → returns null ──
  test("skips property values with type != 'title' when extracting title", async () => {
    installFetchSinglePage([
      makePage("page-title-not-first", {
        properties: {
          desc: { type: "rich_text", rich_text: [] },
          name: {
            type: "title",
            title: [{ type: "text", text: { content: "My Title" } }],
          },
        },
      }),
    ]);
    const db = createMemoryIndexDb();
    const sync = createNotionSyncable({ ensureNotionMcpRunning: async () => {} });
    const ctx = {
      vault: createStubVault({ "notion.oauth": makeOauthPayload() }),
      db,
      ...silentSyncContextExtras(),
    };
    await sync.sync(ctx, null);
    const row = db.prepare("SELECT title FROM item WHERE service = 'notion' LIMIT 1").get() as {
      title: string;
    };
    expect(row.title).toBe("My Title");
  });

  // ── covers lines 28–29: titleArr not array → returns [] ──
  test("handles non-array title rich text (returns empty title → Untitled)", async () => {
    installFetchSinglePage([
      makePage("page-string-title", {
        properties: {
          title: { type: "title", title: "not-an-array" },
        },
      }),
    ]);
    const db = createMemoryIndexDb();
    const sync = createNotionSyncable({ ensureNotionMcpRunning: async () => {} });
    const ctx = {
      vault: createStubVault({ "notion.oauth": makeOauthPayload() }),
      db,
      ...silentSyncContextExtras(),
    };
    await sync.sync(ctx, null);
    const row = db.prepare("SELECT title FROM item WHERE service = 'notion' LIMIT 1").get() as {
      title: string;
    };
    expect(row.title).toBe("Untitled");
  });

  // ── covers line 34: non-record item in title array → continue ──
  test("skips non-record items inside title rich-text array", async () => {
    installFetchSinglePage([
      makePage("page-mixed-title", {
        properties: {
          title: {
            type: "title",
            title: [
              null, // non-record → skip
              "a string", // non-record → skip
              { type: "text", text: { content: "Actual Title" } }, // valid
            ],
          },
        },
      }),
    ]);
    const db = createMemoryIndexDb();
    const sync = createNotionSyncable({ ensureNotionMcpRunning: async () => {} });
    const ctx = {
      vault: createStubVault({ "notion.oauth": makeOauthPayload() }),
      db,
      ...silentSyncContextExtras(),
    };
    await sync.sync(ctx, null);
    const row = db.prepare("SELECT title FROM item WHERE service = 'notion' LIMIT 1").get() as {
      title: string;
    };
    expect(row.title).toBe("Actual Title");
  });

  // ── covers line 37: rich-text item type !== "text" → continue ──
  test("skips rich-text items with type != text", async () => {
    installFetchSinglePage([
      makePage("page-mention-title", {
        properties: {
          title: {
            type: "title",
            title: [
              { type: "mention", mention: { user: {} } }, // not "text" → skip
              { type: "text", text: { content: "Real Part" } },
            ],
          },
        },
      }),
    ]);
    const db = createMemoryIndexDb();
    const sync = createNotionSyncable({ ensureNotionMcpRunning: async () => {} });
    const ctx = {
      vault: createStubVault({ "notion.oauth": makeOauthPayload() }),
      db,
      ...silentSyncContextExtras(),
    };
    await sync.sync(ctx, null);
    const row = db.prepare("SELECT title FROM item WHERE service = 'notion' LIMIT 1").get() as {
      title: string;
    };
    expect(row.title).toBe("Real Part");
  });

  // ── covers lines 41–42: text field missing or content is empty/undefined ──
  test("skips rich-text items with missing or empty content", async () => {
    installFetchSinglePage([
      makePage("page-empty-content", {
        properties: {
          title: {
            type: "title",
            title: [
              { type: "text" }, // no text field → tx undefined → c undefined → skip
              { type: "text", text: null }, // text is null → tx undefined → skip
              { type: "text", text: { content: "" } }, // empty string → skip
              { type: "text", text: { content: "Valid" } },
            ],
          },
        },
      }),
    ]);
    const db = createMemoryIndexDb();
    const sync = createNotionSyncable({ ensureNotionMcpRunning: async () => {} });
    const ctx = {
      vault: createStubVault({ "notion.oauth": makeOauthPayload() }),
      db,
      ...silentSyncContextExtras(),
    };
    await sync.sync(ctx, null);
    const row = db.prepare("SELECT title FROM item WHERE service = 'notion' LIMIT 1").get() as {
      title: string;
    };
    expect(row.title).toBe("Valid");
  });

  // ── covers line 51: titleFromNotionPropertyValue with non-record val → null ──
  test("skips non-record property values when extracting title", async () => {
    installFetchSinglePage([
      makePage("page-null-prop-val", {
        properties: {
          someField: null, // non-record → titleFromNotionPropertyValue returns null
          title: {
            type: "title",
            title: [{ type: "text", text: { content: "Found" } }],
          },
        },
      }),
    ]);
    const db = createMemoryIndexDb();
    const sync = createNotionSyncable({ ensureNotionMcpRunning: async () => {} });
    const ctx = {
      vault: createStubVault({ "notion.oauth": makeOauthPayload() }),
      db,
      ...silentSyncContextExtras(),
    };
    await sync.sync(ctx, null);
    const row = db.prepare("SELECT title FROM item WHERE service = 'notion' LIMIT 1").get() as {
      title: string;
    };
    expect(row.title).toBe("Found");
  });

  // ── covers line 161–164: created_by missing or no notionUserId → authorId null ──
  test("indexes pages with missing or invalid created_by as null author", async () => {
    installFetchSinglePage([
      {
        object: "page",
        id: "page-no-created-by",
        last_edited_time: "2026-04-01T12:00:00.000Z",
        // no created_by
      },
      {
        object: "page",
        id: "page-non-user-created-by",
        last_edited_time: "2026-04-01T12:00:00.000Z",
        created_by: { object: "bot", id: "bot-id" }, // object != "user"
      },
      {
        object: "page",
        id: "page-empty-user-id",
        last_edited_time: "2026-04-01T12:00:00.000Z",
        created_by: { object: "user", id: "" }, // empty id
      },
    ]);
    const db = createMemoryIndexDb();
    const sync = createNotionSyncable({ ensureNotionMcpRunning: async () => {} });
    const ctx = {
      vault: createStubVault({ "notion.oauth": makeOauthPayload() }),
      db,
      ...silentSyncContextExtras(),
    };
    const r = await sync.sync(ctx, null);
    expect(r.itemsUpserted).toBe(3);
    const rows = db
      .prepare("SELECT author_id FROM item WHERE service = 'notion' ORDER BY external_id")
      .all() as Array<{ author_id: string | null }>;
    for (const row of rows) {
      expect(row.author_id).toBeNull();
    }
  });

  // ── covers line 200: title longer than 512 chars gets truncated ──
  test("truncates titles longer than 512 characters", async () => {
    const longTitle = "A".repeat(600);
    installFetchSinglePage([
      makePage("page-long-title", {
        properties: {
          title: {
            type: "title",
            title: [{ type: "text", text: { content: longTitle } }],
          },
        },
      }),
    ]);
    const db = createMemoryIndexDb();
    const sync = createNotionSyncable({ ensureNotionMcpRunning: async () => {} });
    const ctx = {
      vault: createStubVault({ "notion.oauth": makeOauthPayload() }),
      db,
      ...silentSyncContextExtras(),
    };
    await sync.sync(ctx, null);
    const row = db.prepare("SELECT title FROM item WHERE service = 'notion' LIMIT 1").get() as {
      title: string;
    };
    expect(row.title).toHaveLength(512);
    expect(row.title).toBe("A".repeat(512));
  });

  // ── covers line 193: edited is present → use isoMs(edited) as modifiedAt ──
  // ── covers line 204: modifiedAt is finite → uses it directly ──
  test("uses last_edited_time as modifiedAt when present", async () => {
    const editedTime = "2026-04-01T12:00:00.000Z";
    installFetchSinglePage([makePage("page-with-time", { last_edited_time: editedTime })]);
    const db = createMemoryIndexDb();
    const sync = createNotionSyncable({ ensureNotionMcpRunning: async () => {} });
    const ctx = {
      vault: createStubVault({ "notion.oauth": makeOauthPayload() }),
      db,
      ...silentSyncContextExtras(),
    };
    await sync.sync(ctx, null);
    const row = db
      .prepare("SELECT modified_at FROM item WHERE service = 'notion' LIMIT 1")
      .get() as { modified_at: number };
    expect(row.modified_at).toBe(new Date(editedTime).getTime());
  });

  // ── covers line 286: maxEdited === "" → use watermark as nextW ──
  test("preserves prior watermark when no new pages are processed", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({ "notion.oauth": makeOauthPayload() });
    const sync = createNotionSyncable({ ensureNotionMcpRunning: async () => {} });
    const ctx = syncTestContext(db, vault);

    // First sync: index a page to get a cursor with watermark
    installFetchSinglePage([makePage("page-a", { last_edited_time: "2026-04-01T12:00:00.000Z" })]);
    const r1 = await sync.sync(ctx, null);
    expect(r1.cursor).toContain("nimbus-ntn1:");

    // Second sync: empty results (no new pages) → maxEdited stays "" → watermark preserved
    installFetchSinglePage([]);
    const r2 = await sync.sync(ctx, r1.cursor);
    expect(r2.cursor).toContain("nimbus-ntn1:");
    // Cursor should contain the same watermark
    expect(r2.cursor).toBe(r1.cursor);
  });

  // ── covers line 154: maxIso path (maxEdited was already set, update with newer) ──
  test("advances maxEdited to the most recent last_edited_time across multiple pages", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({ "notion.oauth": makeOauthPayload() });
    const sync = createNotionSyncable({ ensureNotionMcpRunning: async () => {} });
    const ctx = syncTestContext(db, vault);

    // Two pages with different times; the first should be newer (desc ordering)
    let callCount = 0;
    globalThis.fetch = (async (): Promise<Response> => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            results: [
              makePage("page-newer", { last_edited_time: "2026-05-01T12:00:00.000Z" }),
              makePage("page-older", { last_edited_time: "2026-04-01T12:00:00.000Z" }),
            ],
            has_more: false,
            next_cursor: null,
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ results: [], has_more: false, next_cursor: null }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const r = await sync.sync(ctx, null);
    expect(r.itemsUpserted).toBe(2);
    // cursor should encode a watermark with the newer timestamp
    expect(r.cursor).toContain("nimbus-ntn1:");
  });

  // ── covers multi-rich-text join (concatenation) ──
  test("concatenates multiple rich-text parts in title", async () => {
    installFetchSinglePage([
      makePage("page-multi-text", {
        properties: {
          title: {
            type: "title",
            title: [
              { type: "text", text: { content: "Hello" } },
              { type: "text", text: { content: " " } },
              { type: "text", text: { content: "World" } },
            ],
          },
        },
      }),
    ]);
    const db = createMemoryIndexDb();
    const sync = createNotionSyncable({ ensureNotionMcpRunning: async () => {} });
    const ctx = {
      vault: createStubVault({ "notion.oauth": makeOauthPayload() }),
      db,
      ...silentSyncContextExtras(),
    };
    await sync.sync(ctx, null);
    const row = db.prepare("SELECT title FROM item WHERE service = 'notion' LIMIT 1").get() as {
      title: string;
    };
    expect(row.title).toBe("Hello World");
  });

  // ── Task 5: full-body walk integration ──────────────────────────────────

  test("indexes a page body from its blocks", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({ "notion.oauth": makeOauthPayload() });
    installSearchAndBlocks([makePage("pg-1")], {
      "pg-1": [
        {
          id: "b1",
          type: "paragraph",
          has_children: false,
          paragraph: { rich_text: [{ plain_text: "decided to ship" }] },
        },
      ],
    });
    await createNotionSyncable({ ensureNotionMcpRunning: async () => {} }).sync(
      syncTestContext(db, vault),
      null,
    );
    const row = db
      .query<{ body: string; body_complete: number; meta: string }, []>(
        "SELECT body, body_complete, metadata AS meta FROM item WHERE service = 'notion'",
      )
      .get();
    expect(row?.body).toBe("decided to ship");
    expect(row?.body_complete).toBe(1);
    expect(JSON.parse(row?.meta ?? "{}").bodyFetch).toBe("complete");
    db.close();
  });

  test("skips a page whose bodyFetch is recorded and modified_at is unchanged", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({ "notion.oauth": makeOauthPayload() });
    const page = makePage("pg-1");
    const first = installSearchAndBlocks([page], { "pg-1": [] });
    const syncable = createNotionSyncable({ ensureNotionMcpRunning: async () => {} });
    await syncable.sync(syncTestContext(db, vault), null);
    expect(first.count()).toBe(1);
    // Second pass with the watermark cleared: same page, unchanged.
    const second = installSearchAndBlocks([page], { "pg-1": [] });
    await syncable.sync(syncTestContext(db, vault), null);
    expect(second.count()).toBe(0);
    db.close();
  });

  test("a capped page is skipped on the next pass — no perpetual re-fetch", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({ "notion.oauth": makeOauthPayload() });
    const page = makePage("pg-1");
    // Nesting one level past MAX_DEPTH (3) forces outcome "capped".
    const deep = {
      "pg-1": [
        {
          id: "b1",
          type: "bulleted_list_item",
          has_children: true,
          bulleted_list_item: { rich_text: [{ plain_text: "L1" }] },
        },
      ],
      b1: [
        {
          id: "b2",
          type: "bulleted_list_item",
          has_children: true,
          bulleted_list_item: { rich_text: [{ plain_text: "L2" }] },
        },
      ],
      b2: [
        {
          id: "b3",
          type: "bulleted_list_item",
          has_children: true,
          bulleted_list_item: { rich_text: [{ plain_text: "L3" }] },
        },
      ],
      b3: [
        {
          id: "b4",
          type: "bulleted_list_item",
          has_children: false,
          bulleted_list_item: { rich_text: [{ plain_text: "L4" }] },
        },
      ],
    };
    const syncable = createNotionSyncable({ ensureNotionMcpRunning: async () => {} });
    installSearchAndBlocks([page], deep);
    await syncable.sync(syncTestContext(db, vault), null);
    const row = db
      .query<{ body_complete: number; meta: string }, []>(
        "SELECT body_complete, metadata AS meta FROM item WHERE service = 'notion'",
      )
      .get();
    expect(row?.body_complete).toBe(0);
    expect(JSON.parse(row?.meta ?? "{}").bodyFetch).toBe("capped");
    const second = installSearchAndBlocks([page], deep);
    await syncable.sync(syncTestContext(db, vault), null);
    expect(second.count()).toBe(0); // the regression this whole design exists to prevent
    db.close();
  });

  test("an errored page indexes title-only with no bodyFetch key, and the sync still succeeds", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({ "notion.oauth": makeOauthPayload() });
    const page = makePage("pg-1");
    globalThis.fetch = ((input: SyncTestFetchParams[0]) => {
      const url = urlFromFetchInput(input);
      if (url.includes("/v1/search")) {
        return Promise.resolve(
          new Response(JSON.stringify({ results: [page], has_more: false, next_cursor: null }), {
            status: 200,
          }),
        );
      }
      return Promise.resolve(new Response("{}", { status: 500 }));
    }) as unknown as typeof fetch;
    // A block-fetch failure must not reject the whole sync — the page still
    // indexes with what we already know about it (title, URL), just no body.
    const r = await createNotionSyncable({ ensureNotionMcpRunning: async () => {} }).sync(
      syncTestContext(db, vault),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .query<{ title: string; meta: string; body_complete: number }, []>(
        "SELECT title, metadata AS meta, body_complete FROM item WHERE service = 'notion'",
      )
      .get();
    expect(row?.title).toBe("Hello"); // title-only: the title still indexed despite the body error
    // Absence of `bodyFetch` is the retry signal, but a later pass only
    // re-examines this page if it is edited again (new last_edited_time) or
    // `nimbus index rebody` clears the watermark — see notion-sync.ts.
    expect(JSON.parse(row?.meta ?? "{}").bodyFetch).toBeUndefined();
    expect(row?.body_complete).toBe(0);
    db.close();
  });

  test("the watermark is pinned when the budget stops the pass", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({ "notion.oauth": makeOauthPayload() });
    // More pages than the budget can serve: BUDGET / PER_PAGE_MAX pages fit.
    const many = Array.from({ length: NOTION_BODY_FETCH_BUDGET_PER_SYNC + 5 }, (_, i) =>
      makePage(`pg-${String(i)}`),
    );
    installSearchAndBlocks(many, {});
    // Real Notion quota (burst 5) would force this test to wait on real
    // wall-clock refills once the walk issues more than a handful of
    // requests — same override pattern as notion-page-body.test.ts's `deps()`
    // and zoom-sync.test.ts's `fastLimiter`.
    const fastLimiter = new ProviderRateLimiter({
      notion: { requestsPerMinute: 600_000, burstSize: 1000 },
    });
    const ctx = {
      db,
      vault,
      ...silentSyncContextExtras(),
      rateLimiter: fastLimiter,
    };
    const r = await createNotionSyncable({ ensureNotionMcpRunning: async () => {} }).sync(
      ctx,
      null,
    );
    expect(r.cursor).toBe(encodeWatermarkCursorV1("nimbus-ntn1:", { v: 1, watermark: null }));
    db.close();
  });

  test("the watermark advances when the budget does not stop the pass", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({ "notion.oauth": makeOauthPayload() });
    installSearchAndBlocks([makePage("pg-1")], { "pg-1": [] });
    const r = await createNotionSyncable({ ensureNotionMcpRunning: async () => {} }).sync(
      syncTestContext(db, vault),
      null,
    );
    // The cursor is a base64url-encoded JSON payload (nimbus-json-cursor.ts),
    // not a literal string, so compare it against the real encoder rather
    // than substring-matching the raw ISO timestamp.
    expect(r.cursor).toBe(
      encodeWatermarkCursorV1("nimbus-ntn1:", { v: 1, watermark: "2026-04-01T12:00:00.000Z" }),
    );
    db.close();
  });
});
