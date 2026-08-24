import { afterEach, describe, expect, test } from "bun:test";
import { itemPrimaryKey } from "../index/item-store.ts";
import { UnauthenticatedError } from "../sync/types.ts";
import {
  createOAuthConnectorTestSetup,
  expectPrefixedCursorCodecRoundTrip,
  registerGlobalFetchRestore,
  requestUrlString,
} from "../testing/bun-test-support.ts";
import {
  createGooglePhotosSyncable,
  decodeGooglePhotosSyncCursor,
  encodeGooglePhotosSyncCursor,
  type GooglePhotosSyncCursorV1,
} from "./google-photos-sync.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";

describe("Google Photos sync cursor codec", () => {
  test("round-trip", () => {
    const samples: GooglePhotosSyncCursorV1[] = [
      { v: 1, pageToken: null },
      { v: 1, pageToken: "next" },
    ];
    expectPrefixedCursorCodecRoundTrip(
      samples,
      encodeGooglePhotosSyncCursor,
      decodeGooglePhotosSyncCursor,
      "nimbus-gph1:",
    );
  });

  // L40 branch: null / non-object / array payloads
  test("decode returns undefined for null payload", () => {
    // encode a payload that is null — decodeNimbusJsonCursorPayload returns null
    const raw = encodeNimbusJsonCursor("nimbus-gph1:", null);
    expect(decodeGooglePhotosSyncCursor(raw)).toBeUndefined();
  });

  test("decode returns undefined for array payload", () => {
    const raw = encodeNimbusJsonCursor("nimbus-gph1:", [1, 2, 3]);
    expect(decodeGooglePhotosSyncCursor(raw)).toBeUndefined();
  });

  test("decode returns undefined for non-object primitive payload", () => {
    const raw = encodeNimbusJsonCursor("nimbus-gph1:", 42);
    expect(decodeGooglePhotosSyncCursor(raw)).toBeUndefined();
  });

  // L44 branch: v !== 1
  test("decode returns undefined for wrong version", () => {
    const raw = encodeNimbusJsonCursor("nimbus-gph1:", { v: 2, pageToken: null });
    expect(decodeGooglePhotosSyncCursor(raw)).toBeUndefined();
  });

  // L48 branch: pageToken is not null and not string
  test("decode returns undefined for numeric pageToken", () => {
    const raw = encodeNimbusJsonCursor("nimbus-gph1:", { v: 1, pageToken: 99 });
    expect(decodeGooglePhotosSyncCursor(raw)).toBeUndefined();
  });

  test("decode returns undefined for boolean pageToken", () => {
    const raw = encodeNimbusJsonCursor("nimbus-gph1:", { v: 1, pageToken: true });
    expect(decodeGooglePhotosSyncCursor(raw)).toBeUndefined();
  });

  // prefix mismatch → still undefined (existing coverage via round-trip failure)
  test("decode returns undefined for wrong prefix", () => {
    const raw = encodeNimbusJsonCursor("nimbus-other:", { v: 1, pageToken: null });
    expect(decodeGooglePhotosSyncCursor(raw)).toBeUndefined();
  });
});

describe("createGooglePhotosSyncable", () => {
  registerGlobalFetchRestore(afterEach);

  test("indexes media items from search response", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("google", "google_photos");
    const syncable = createGooglePhotosSyncable({ ensureGoogleMcpRunning: async () => {} });

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = requestUrlString(input);
      if (url.includes("mediaItems:search")) {
        return new Response(
          JSON.stringify({
            mediaItems: [
              {
                id: "p1",
                filename: "a.jpg",
                productUrl: "https://photos.google.com/p1",
                mediaMetadata: { creationTime: "2024-01-02T00:00:00Z" },
              },
            ],
            nextPageToken: "n1",
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const r = await syncable.sync(ctx, null);
    expect(r.itemsUpserted).toBe(1);
    expect(r.hasMore).toBe(true);
    expect(r.cursor).not.toBeNull();

    const row = db
      .query("SELECT id, service, external_id FROM item WHERE id = ?")
      .get(itemPrimaryKey("google_photos", "p1")) as
      | { id: string; service: string; external_id: string }
      | undefined;
    expect(row?.service).toBe("google_photos");
    expect(row?.external_id).toBe("p1");
  });

  test("search request uses ALL_MEDIA filter for library-wide listing", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("google", "google_photos");
    const syncable = createGooglePhotosSyncable({ ensureGoogleMcpRunning: async () => {} });

    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const raw = init?.body;
      expect(typeof raw).toBe("string");
      const body = JSON.parse(raw as string) as Record<string, unknown>;
      expect(body["pageSize"]).toBe(50);
      expect(body["filters"]).toEqual({
        mediaTypeFilter: { mediaTypes: ["ALL_MEDIA"] },
      });
      return new Response(JSON.stringify({ mediaItems: [], nextPageToken: undefined }), {
        status: 200,
      });
    }) as typeof fetch;

    await syncable.sync(ctx, null);
  });

  test("401 throws UnauthenticatedError with API message", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("google", "google_photos");
    const syncable = createGooglePhotosSyncable({ ensureGoogleMcpRunning: async () => {} });

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "Invalid Credentials" } }), {
        status: 401,
      })) as unknown as typeof fetch;

    let caught: unknown;
    try {
      await syncable.sync(ctx, null);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnauthenticatedError);
    expect((caught as Error).message).toMatch(/Invalid Credentials/);
  });

  // L149: mediaItems absent → items defaults to []
  test("response with no mediaItems field yields 0 upserted and no hasMore", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("google", "google_photos");
    const syncable = createGooglePhotosSyncable({ ensureGoogleMcpRunning: async () => {} });

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = requestUrlString(input);
      if (url.includes("mediaItems:search")) {
        // No mediaItems key at all
        return new Response(JSON.stringify({}), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const r = await syncable.sync(ctx, null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.hasMore).toBe(false);
    expect(r.cursor).toBeNull();
  });

  // L140: empty-string cursor behaves like null cursor (no pageToken in body)
  test("empty-string cursor is treated as fresh sync (no pageToken in request)", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("google", "google_photos");
    const syncable = createGooglePhotosSyncable({ ensureGoogleMcpRunning: async () => {} });

    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const raw = init?.body;
      capturedBody = JSON.parse(typeof raw === "string" ? raw : "{}") as Record<string, unknown>;
      return new Response(JSON.stringify({ mediaItems: [] }), { status: 200 });
    }) as typeof fetch;

    await syncable.sync(ctx, "");
    expect(capturedBody["pageToken"]).toBeUndefined();
  });

  // L109: non-null, non-empty pageToken is forwarded in the POST body
  // L144: cursor with a real pageToken is decoded and forwarded
  test("valid cursor with pageToken forwards it in the search request body", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("google", "google_photos");
    const syncable = createGooglePhotosSyncable({ ensureGoogleMcpRunning: async () => {} });
    const cursor = encodeGooglePhotosSyncCursor({ v: 1, pageToken: "tok-abc" });

    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const raw = init?.body;
      capturedBody = JSON.parse(typeof raw === "string" ? raw : "{}") as Record<string, unknown>;
      return new Response(JSON.stringify({ mediaItems: [] }), { status: 200 });
    }) as typeof fetch;

    await syncable.sync(ctx, cursor);
    expect(capturedBody["pageToken"]).toBe("tok-abc");
  });

  // L144: cursor with pageToken: null still starts fresh (no pageToken in body)
  test("cursor with null pageToken does not include pageToken in search body", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("google", "google_photos");
    const syncable = createGooglePhotosSyncable({ ensureGoogleMcpRunning: async () => {} });
    const cursor = encodeGooglePhotosSyncCursor({ v: 1, pageToken: null });

    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const raw = init?.body;
      capturedBody = JSON.parse(typeof raw === "string" ? raw : "{}") as Record<string, unknown>;
      return new Response(JSON.stringify({ mediaItems: [] }), { status: 200 });
    }) as typeof fetch;

    await syncable.sync(ctx, cursor);
    expect(capturedBody["pageToken"]).toBeUndefined();
  });

  // L69: item with undefined id is silently skipped (no DB row written)
  test("media item with no id is skipped — no DB row written", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("google", "google_photos");
    const syncable = createGooglePhotosSyncable({ ensureGoogleMcpRunning: async () => {} });

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = requestUrlString(input);
      if (url.includes("mediaItems:search")) {
        return new Response(
          JSON.stringify({
            mediaItems: [
              { filename: "no-id.jpg" }, // id is absent
              { id: "", filename: "empty-id.jpg" }, // id is empty string
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await syncable.sync(ctx, null);
    // Neither item should produce a DB row since both have missing/empty ids
    const rows = db.query("SELECT id FROM item WHERE service = 'google_photos'").all();
    expect(rows).toHaveLength(0);
  });

  // L73: item with no filename falls back to "photo_<id>"
  // L74: item with no productUrl → url is null
  // L60: item with no mediaMetadata creationTime → fallback timestamp used
  test("media item without filename or productUrl or creationTime uses sensible defaults", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("google", "google_photos");
    const syncable = createGooglePhotosSyncable({ ensureGoogleMcpRunning: async () => {} });

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = requestUrlString(input);
      if (url.includes("mediaItems:search")) {
        return new Response(
          JSON.stringify({
            mediaItems: [
              {
                id: "p-no-meta",
                // no filename, no productUrl, no mediaMetadata
              },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const r = await syncable.sync(ctx, null);
    expect(r.itemsUpserted).toBe(1);

    const row = db
      .query("SELECT title, url, service FROM item WHERE id = ?")
      .get(itemPrimaryKey("google_photos", "p-no-meta")) as
      | { title: string; url: string | null; service: string }
      | undefined;
    expect(row?.service).toBe("google_photos");
    expect(row?.title).toBe("photo_p-no-meta");
    expect(row?.url).toBeNull();
  });

  // L73 branch: filename is empty string → fallback to "photo_<id>"
  test("media item with empty filename falls back to photo_<id>", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("google", "google_photos");
    const syncable = createGooglePhotosSyncable({ ensureGoogleMcpRunning: async () => {} });

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = requestUrlString(input);
      if (url.includes("mediaItems:search")) {
        return new Response(
          JSON.stringify({
            mediaItems: [{ id: "p-empty-fn", filename: "" }],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await syncable.sync(ctx, null);
    const row = db
      .query("SELECT title FROM item WHERE id = ?")
      .get(itemPrimaryKey("google_photos", "p-empty-fn")) as { title: string } | undefined;
    expect(row?.title).toBe("photo_p-empty-fn");
  });

  // L60 branch: creationTime is empty string → fallback timestamp
  test("media item with empty creationTime uses fallback timestamp", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("google", "google_photos");
    const syncable = createGooglePhotosSyncable({ ensureGoogleMcpRunning: async () => {} });

    const before = Date.now();
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = requestUrlString(input);
      if (url.includes("mediaItems:search")) {
        return new Response(
          JSON.stringify({
            mediaItems: [
              {
                id: "p-empty-ts",
                mediaMetadata: { creationTime: "" },
              },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await syncable.sync(ctx, null);
    const after = Date.now();

    const row = db
      .query("SELECT modified_at FROM item WHERE id = ?")
      .get(itemPrimaryKey("google_photos", "p-empty-ts")) as { modified_at: number } | undefined;
    // Should be in the range of now (the fallback), not some fixed old date
    expect(row?.modified_at).toBeGreaterThanOrEqual(before);
    expect(row?.modified_at).toBeLessThanOrEqual(after);
  });

  // L64 branch: creationTime is an un-parseable string → fallback
  test("media item with invalid creationTime string uses fallback timestamp", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("google", "google_photos");
    const syncable = createGooglePhotosSyncable({ ensureGoogleMcpRunning: async () => {} });

    const before = Date.now();
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = requestUrlString(input);
      if (url.includes("mediaItems:search")) {
        return new Response(
          JSON.stringify({
            mediaItems: [
              {
                id: "p-bad-ts",
                mediaMetadata: { creationTime: "not-a-date" },
              },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await syncable.sync(ctx, null);
    const after = Date.now();

    const row = db
      .query("SELECT modified_at FROM item WHERE id = ?")
      .get(itemPrimaryKey("google_photos", "p-bad-ts")) as { modified_at: number } | undefined;
    expect(row?.modified_at).toBeGreaterThanOrEqual(before);
    expect(row?.modified_at).toBeLessThanOrEqual(after);
  });

  // L88: title longer than 512 chars is truncated
  test("media item with filename > 512 chars is truncated to 512", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("google", "google_photos");
    const syncable = createGooglePhotosSyncable({ ensureGoogleMcpRunning: async () => {} });

    const longFilename = `${"x".repeat(600)}.jpg`;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = requestUrlString(input);
      if (url.includes("mediaItems:search")) {
        return new Response(
          JSON.stringify({
            mediaItems: [{ id: "p-long", filename: longFilename }],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await syncable.sync(ctx, null);
    const row = db
      .query("SELECT title FROM item WHERE id = ?")
      .get(itemPrimaryKey("google_photos", "p-long")) as { title: string } | undefined;
    expect(row?.title).toHaveLength(512);
    expect(row?.title).toBe(longFilename.slice(0, 512));
  });

  // nextPageToken absent / empty → hasMore false, cursor null
  test("response with no nextPageToken yields hasMore false and null cursor", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("google", "google_photos");
    const syncable = createGooglePhotosSyncable({ ensureGoogleMcpRunning: async () => {} });

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = requestUrlString(input);
      if (url.includes("mediaItems:search")) {
        return new Response(JSON.stringify({ mediaItems: [{ id: "p2", filename: "b.jpg" }] }), {
          status: 200,
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const r = await syncable.sync(ctx, null);
    expect(r.hasMore).toBe(false);
    expect(r.cursor).toBeNull();
  });

  // Non-decodable cursor string → treated as null pageToken (fresh start)
  test("malformed cursor string falls back to null pageToken", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("google", "google_photos");
    const syncable = createGooglePhotosSyncable({ ensureGoogleMcpRunning: async () => {} });

    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const raw = init?.body;
      capturedBody = JSON.parse(typeof raw === "string" ? raw : "{}") as Record<string, unknown>;
      return new Response(JSON.stringify({ mediaItems: [] }), { status: 200 });
    }) as typeof fetch;

    // A non-empty string with a valid prefix but invalid content decodes to undefined cursor
    const badCursor = encodeNimbusJsonCursor("nimbus-gph1:", { v: 99, pageToken: "x" });
    await syncable.sync(ctx, badCursor);
    expect(capturedBody["pageToken"]).toBeUndefined();
  });
});
