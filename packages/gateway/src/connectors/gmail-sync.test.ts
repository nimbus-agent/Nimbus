import { afterEach, describe, expect, test } from "bun:test";
import type { Logger } from "pino";
import { itemPrimaryKey } from "../index/item-store.ts";
import {
  createOAuthConnectorTestSetup,
  expectPrefixedCursorCodecRoundTrip,
  registerGlobalFetchRestore,
  requestUrlString,
} from "../testing/bun-test-support.ts";
import {
  createGmailSyncable,
  decodeGmailSyncCursor,
  encodeGmailSyncCursor,
  type GmailSyncCursorV1,
} from "./gmail-sync.ts";

type FetchInput = string | URL | Request;

interface CapturedLog {
  obj: unknown;
  msg: string | undefined;
}

function capturingLogger(base: Logger): { logger: Logger; warns: CapturedLog[] } {
  const warns: CapturedLog[] = [];
  const logger = {
    ...base,
    warn: (o: unknown, msg?: string) => {
      warns.push({ obj: o, msg });
    },
  } as unknown as Logger;
  return { logger, warns };
}

describe("Gmail sync cursor codec", () => {
  test("round-trip v1 cursors", () => {
    const samples: GmailSyncCursorV1[] = [
      { v: 1, phase: "list", q: "newer_than:30d", pageToken: "pt2" },
      { v: 1, phase: "list", q: "newer_than:30d", pageToken: null },
      { v: 1, phase: "delta", startHistoryId: "100", pageToken: "hp1" },
      { v: 1, phase: "delta", startHistoryId: "100", pageToken: null },
    ];
    expectPrefixedCursorCodecRoundTrip(
      samples,
      encodeGmailSyncCursor,
      decodeGmailSyncCursor,
      "nimbus-gml1:",
    );
  });

  test("rejects invalid prefixed payload", () => {
    expect(decodeGmailSyncCursor("nimbus-gml1:not-base64!!!")).toBeUndefined();
  });
});

describe("createGmailSyncable", () => {
  registerGlobalFetchRestore(afterEach);

  test("null cursor: messages.list page + profile historyId → delta cursor", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("google");
    const syncable = createGmailSyncable({ ensureGoogleMcpRunning: async () => {} });

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/gmail/v1/users/me/messages?")) {
        return new Response(
          JSON.stringify({
            messages: [{ id: "m1", threadId: "th1" }],
            nextPageToken: "",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/gmail/v1/users/me/messages/m1")) {
        return new Response(
          JSON.stringify({
            id: "m1",
            threadId: "th1",
            snippet: "hello",
            internalDate: "1700000000000",
            labelIds: ["INBOX"],
            payload: {
              headers: [
                { name: "Subject", value: "Hi" },
                { name: "From", value: "a@b.com" },
                { name: "To", value: "c@d.com" },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/gmail/v1/users/me/profile")) {
        return new Response(JSON.stringify({ historyId: "999" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const result = await syncable.sync(ctx, null);
    expect(result.hasMore).toBe(false);
    expect(result.itemsUpserted).toBe(1);
    const dec = decodeGmailSyncCursor(result.cursor ?? "");
    expect(dec?.phase).toBe("delta");
    if (dec?.phase === "delta") {
      expect(dec.startHistoryId).toBe("999");
    }

    const row = db
      .query("SELECT title, service, author_id FROM item WHERE id = ?")
      .get(itemPrimaryKey("gmail", "m1")) as {
      title: string;
      service: string;
      author_id: string | null;
    } | null;
    expect(row?.service).toBe("gmail");
    expect(row?.title).toBe("Hi");
    expect(row?.author_id).not.toBeNull();
  });

  test("list phase: messages.get 404 is skipped, sync continues, warn logged", async () => {
    const setup = await createOAuthConnectorTestSetup("google");
    const { logger, warns } = capturingLogger(setup.ctx.logger);
    const ctx = { ...setup.ctx, logger };
    const syncable = createGmailSyncable({ ensureGoogleMcpRunning: async () => {} });

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/gmail/v1/users/me/messages?")) {
        return new Response(
          JSON.stringify({
            messages: [
              { id: "ok1", threadId: "t1" },
              { id: "gone", threadId: "t2" },
              { id: "ok2", threadId: "t3" },
            ],
            nextPageToken: "",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/gmail/v1/users/me/messages/gone")) {
        return new Response(
          JSON.stringify({
            error: { code: 404, message: "Requested entity was not found." },
          }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }
      const okMatch = /\/gmail\/v1\/users\/me\/messages\/(ok\d)/.exec(url);
      if (okMatch !== null) {
        const id = okMatch[1];
        return new Response(
          JSON.stringify({
            id,
            threadId: `thread-${id}`,
            snippet: "snip",
            internalDate: "1700000000000",
            labelIds: ["INBOX"],
            payload: {
              headers: [
                { name: "Subject", value: `Subject ${id}` },
                { name: "From", value: "a@b.com" },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/gmail/v1/users/me/profile")) {
        return new Response(JSON.stringify({ historyId: "777" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const result = await syncable.sync(ctx, null);
    expect(result.itemsUpserted).toBe(2);
    expect(result.hasMore).toBe(false);

    const skipWarn = warns.find((w) => {
      const o = w.obj as Record<string, unknown> | null;
      return (
        o !== null && o["service"] === "gmail" && o["messageId"] === "gone" && o["stage"] === "list"
      );
    });
    expect(skipWarn).toBeDefined();
  });

  test("delta phase: messages.get 404 in messagesAdded is skipped, sync continues", async () => {
    const setup = await createOAuthConnectorTestSetup("google");
    const { logger, warns } = capturingLogger(setup.ctx.logger);
    const ctx = { ...setup.ctx, logger };
    const syncable = createGmailSyncable({ ensureGoogleMcpRunning: async () => {} });
    const cursor = encodeGmailSyncCursor({
      v: 1,
      phase: "delta",
      startHistoryId: "100",
      pageToken: null,
    });

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/gmail/v1/users/me/history")) {
        return new Response(
          JSON.stringify({
            history: [
              {
                id: "101",
                messagesAdded: [
                  { message: { id: "ok-a", threadId: "ta" } },
                  { message: { id: "gone-d", threadId: "td" } },
                  { message: { id: "ok-b", threadId: "tb" } },
                ],
              },
            ],
            historyId: "101",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/gmail/v1/users/me/messages/gone-d")) {
        return new Response(
          JSON.stringify({
            error: { code: 404, message: "Requested entity was not found." },
          }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }
      const okMatch = /\/gmail\/v1\/users\/me\/messages\/(ok-[ab])/.exec(url);
      if (okMatch !== null) {
        const id = okMatch[1];
        return new Response(
          JSON.stringify({
            id,
            threadId: `thread-${id}`,
            snippet: "snip",
            internalDate: "1700000000000",
            labelIds: ["INBOX"],
            payload: { headers: [{ name: "Subject", value: `S ${id}` }] },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const result = await syncable.sync(ctx, cursor);
    expect(result.itemsUpserted).toBe(2);

    const skipWarn = warns.find((w) => {
      const o = w.obj as Record<string, unknown> | null;
      return (
        o !== null &&
        o["service"] === "gmail" &&
        o["messageId"] === "gone-d" &&
        o["stage"] === "delta"
      );
    });
    expect(skipWarn).toBeDefined();
  });

  // ── New tests for uncovered branches ────────────────────────────────────────

  test("null cursor: empty messages list returns delta cursor with 0 upserts", async () => {
    // Covers L64 fallback: data.messages is undefined → entries = []
    const { ctx } = await createOAuthConnectorTestSetup("google");
    const syncable = createGmailSyncable({ ensureGoogleMcpRunning: async () => {} });

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/gmail/v1/users/me/messages?")) {
        // no "messages" key → parseMessagesList returns {} → entries = []
        return new Response(JSON.stringify({ nextPageToken: "" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/gmail/v1/users/me/profile")) {
        return new Response(JSON.stringify({ historyId: "500" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const result = await syncable.sync(ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.hasMore).toBe(false);
    const dec = decodeGmailSyncCursor(result.cursor ?? "");
    expect(dec?.phase).toBe("delta");
  });

  test("list phase: message with undefined id is skipped", async () => {
    // Covers L67 TRUE branch: mid === undefined → continue
    const { ctx } = await createOAuthConnectorTestSetup("google");
    const syncable = createGmailSyncable({ ensureGoogleMcpRunning: async () => {} });

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/gmail/v1/users/me/messages?")) {
        return new Response(
          JSON.stringify({
            // entry with no id and one with empty id
            messages: [{ threadId: "t1" }, { id: "", threadId: "t2" }],
            nextPageToken: "",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/gmail/v1/users/me/profile")) {
        return new Response(JSON.stringify({ historyId: "501" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const result = await syncable.sync(ctx, null);
    // Both entries skipped (no id / empty id)
    expect(result.itemsUpserted).toBe(0);
    expect(result.hasMore).toBe(false);
  });

  test("list phase: meta.id missing is filled from list entry id; threadId fallback applied", async () => {
    // Covers L82 (meta.id ?? mid fallback) and L83-L84 (threadId fallback when meta.threadId empty)
    const { db, ctx } = await createOAuthConnectorTestSetup("google");
    const syncable = createGmailSyncable({ ensureGoogleMcpRunning: async () => {} });

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/gmail/v1/users/me/messages?")) {
        return new Response(
          JSON.stringify({
            messages: [{ id: "mX", threadId: "thX" }],
            nextPageToken: "",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/gmail/v1/users/me/messages/mX")) {
        // Return a resource WITHOUT id and WITHOUT threadId so both fallbacks fire
        return new Response(
          JSON.stringify({
            // id intentionally omitted → meta.id will be undefined → fallback to "mX"
            // threadId intentionally omitted → fallback to e.threadId "thX"
            snippet: "meta-fallback",
            internalDate: "1700000000000",
            labelIds: ["INBOX"],
            payload: {
              headers: [
                { name: "Subject", value: "Fallback Test" },
                { name: "From", value: "x@y.com" },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/gmail/v1/users/me/profile")) {
        return new Response(JSON.stringify({ historyId: "502" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const result = await syncable.sync(ctx, null);
    expect(result.itemsUpserted).toBe(1);
    // Verify the item was upserted using the filled-in id "mX"
    const row = db
      .query("SELECT title FROM item WHERE id = ?")
      .get(itemPrimaryKey("gmail", "mX")) as { title: string } | null;
    expect(row?.title).toBe("Fallback Test");
  });

  test("list phase: nextPageToken present → hasMore=true with list-phase cursor", async () => {
    // Covers L94 TRUE branch: next token triggers hasMore=true
    const { ctx } = await createOAuthConnectorTestSetup("google");
    const syncable = createGmailSyncable({ ensureGoogleMcpRunning: async () => {} });

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/gmail/v1/users/me/messages?")) {
        return new Response(
          JSON.stringify({
            messages: [],
            nextPageToken: "page2token",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const result = await syncable.sync(ctx, null);
    expect(result.hasMore).toBe(true);
    const dec = decodeGmailSyncCursor(result.cursor ?? "");
    expect(dec?.phase).toBe("list");
    if (dec?.phase === "list") {
      expect(dec.pageToken).toBe("page2token");
    }
  });

  test("list phase: profile returns empty historyId → throws", async () => {
    // Covers L106 TRUE branch: historyId missing → throws Error
    const { ctx } = await createOAuthConnectorTestSetup("google");
    const syncable = createGmailSyncable({ ensureGoogleMcpRunning: async () => {} });

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/gmail/v1/users/me/messages?")) {
        return new Response(JSON.stringify({ nextPageToken: "" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/gmail/v1/users/me/profile")) {
        // historyId missing entirely
        return new Response(JSON.stringify({ emailAddress: "test@example.com" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    await expect(syncable.sync(ctx, null)).rejects.toThrow(
      "Gmail sync failed: profile missing historyId",
    );
  });

  test("non-prefix cursor → reset to initial list sync", async () => {
    // Covers L129 TRUE branch: cursor doesn't start with GMAIL_CURSOR_PREFIX
    const { ctx } = await createOAuthConnectorTestSetup("google");
    const syncable = createGmailSyncable({ ensureGoogleMcpRunning: async () => {} });
    let listCalled = false;

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/gmail/v1/users/me/messages?")) {
        listCalled = true;
        return new Response(JSON.stringify({ nextPageToken: "" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/gmail/v1/users/me/profile")) {
        return new Response(JSON.stringify({ historyId: "503" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const result = await syncable.sync(ctx, "some-other-prefix:xyz");
    expect(listCalled).toBe(true);
    expect(result.hasMore).toBe(false);
    const dec = decodeGmailSyncCursor(result.cursor ?? "");
    expect(dec?.phase).toBe("delta");
  });

  test("corrupt cursor (valid prefix, invalid payload) → throws", async () => {
    // Covers L135 TRUE branch: decodeGmailSyncCursor returns undefined → throw
    const { ctx } = await createOAuthConnectorTestSetup("google");
    const syncable = createGmailSyncable({ ensureGoogleMcpRunning: async () => {} });

    // Build a string with the right prefix but garbage base64 body
    const badCursor = "nimbus-gml1:!!!notbase64!!!";

    globalThis.fetch = (async (_input: FetchInput) => {
      return new Response("should not be called", { status: 500 });
    }) as typeof fetch;

    await expect(syncable.sync(ctx, badCursor)).rejects.toThrow("Gmail sync: corrupt cursor");
  });

  test("list-phase cursor with pageToken resumes from that pageToken", async () => {
    // Covers L139 TRUE branch (decoded.phase === "list") and L140 (pageToken passed)
    // Also covers L58 TRUE branch (pageToken is set → searchParams.set called)
    const { ctx } = await createOAuthConnectorTestSetup("google");
    const syncable = createGmailSyncable({ ensureGoogleMcpRunning: async () => {} });
    let capturedListUrl = "";

    const cursor = encodeGmailSyncCursor({
      v: 1,
      phase: "list",
      q: "newer_than:30d",
      pageToken: "resumeToken",
    });

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/gmail/v1/users/me/messages?")) {
        capturedListUrl = url;
        return new Response(JSON.stringify({ messages: [], nextPageToken: "" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/gmail/v1/users/me/profile")) {
        return new Response(JSON.stringify({ historyId: "504" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const result = await syncable.sync(ctx, cursor);
    expect(result.hasMore).toBe(false);
    // Verify the pageToken was forwarded in the messages list URL
    expect(capturedListUrl).toContain("pageToken=resumeToken");
    const dec = decodeGmailSyncCursor(result.cursor ?? "");
    expect(dec?.phase).toBe("delta");
  });

  test("delta phase: history 404 (reset) → falls back to initial list sync", async () => {
    // Covers L144 TRUE branch: fetched.kind === "reset"
    const { ctx } = await createOAuthConnectorTestSetup("google");
    const syncable = createGmailSyncable({ ensureGoogleMcpRunning: async () => {} });
    let listCalled = false;

    const cursor = encodeGmailSyncCursor({
      v: 1,
      phase: "delta",
      startHistoryId: "200",
      pageToken: null,
    });

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/gmail/v1/users/me/history")) {
        // Return 404 → fetchGmailHistoryOrReset will return { kind: "reset" }
        return new Response(
          JSON.stringify({ error: { code: 404, message: "History not found" } }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/gmail/v1/users/me/messages?")) {
        listCalled = true;
        return new Response(JSON.stringify({ nextPageToken: "" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/gmail/v1/users/me/profile")) {
        return new Response(JSON.stringify({ historyId: "505" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const result = await syncable.sync(ctx, cursor);
    expect(listCalled).toBe(true);
    expect(result.hasMore).toBe(false);
    const dec = decodeGmailSyncCursor(result.cursor ?? "");
    expect(dec?.phase).toBe("delta");
    if (dec?.phase === "delta") {
      expect(dec.startHistoryId).toBe("505");
    }
  });

  test("indexes a real Gmail body with the quoted tail stripped", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("google");
    const syncable = createGmailSyncable({ ensureGoogleMcpRunning: async () => {} });

    const rawBody = "Agreed, ship Tuesday.\n\n> On Mon, Ana wrote:\n> the whole thread";
    const encodedBody = Buffer.from(rawBody, "utf8").toString("base64url");

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/gmail/v1/users/me/messages?")) {
        return new Response(
          JSON.stringify({
            messages: [{ id: "m1", threadId: "th1" }],
            nextPageToken: "",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/gmail/v1/users/me/messages/m1")) {
        return new Response(
          JSON.stringify({
            id: "m1",
            threadId: "th1",
            snippet: "Agreed, ship Tuesday...",
            internalDate: "1700000000000",
            labelIds: ["INBOX"],
            payload: {
              mimeType: "text/plain",
              headers: [
                { name: "Subject", value: "Ship plan" },
                { name: "From", value: "a@b.com" },
                { name: "To", value: "c@d.com" },
              ],
              body: { data: encodedBody },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/gmail/v1/users/me/profile")) {
        return new Response(JSON.stringify({ historyId: "999" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const result = await syncable.sync(ctx, null);
    expect(result.itemsUpserted).toBe(1);

    const row = db
      .query<{ body: string; body_complete: number }, []>(
        "SELECT body, body_complete FROM item WHERE service = 'gmail'",
      )
      .get();
    expect(row?.body).toBe("Agreed, ship Tuesday.");
    expect(row?.body_complete).toBe(1);
  });

  test("indexes an HTML-only Gmail body with the quoted tail stripped", async () => {
    // The html fallback in `gmailMessageBodyText` used to flatten everything
    // through `plainTextFromHtml`, which collapses all newlines into a single
    // space — `stripQuotedTail`'s line-anchored markers can never match a
    // single-line body. It now routes through the line-preserving
    // `plainTextFromHtmlLines` instead.
    const { db, ctx } = await createOAuthConnectorTestSetup("google");
    const syncable = createGmailSyncable({ ensureGoogleMcpRunning: async () => {} });

    const htmlBody =
      "<p>Agreed, ship Tuesday.</p><p>> On Mon, Ana wrote:</p><p>> the whole thread</p>";
    const encodedBody = Buffer.from(htmlBody, "utf8").toString("base64url");

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/gmail/v1/users/me/messages?")) {
        return new Response(
          JSON.stringify({
            messages: [{ id: "m2", threadId: "th2" }],
            nextPageToken: "",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/gmail/v1/users/me/messages/m2")) {
        return new Response(
          JSON.stringify({
            id: "m2",
            threadId: "th2",
            snippet: "Agreed, ship Tuesday...",
            internalDate: "1700000000000",
            labelIds: ["INBOX"],
            payload: {
              mimeType: "text/html",
              headers: [
                { name: "Subject", value: "Ship plan" },
                { name: "From", value: "a@b.com" },
                { name: "To", value: "c@d.com" },
              ],
              body: { data: encodedBody },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/gmail/v1/users/me/profile")) {
        return new Response(JSON.stringify({ historyId: "999" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const result = await syncable.sync(ctx, null);
    expect(result.itemsUpserted).toBe(1);

    const row = db.query("SELECT body FROM item WHERE id = ?").get(itemPrimaryKey("gmail", "m2")) as
      | { body: string }
      | undefined;
    expect(row?.body).toBe("Agreed, ship Tuesday.");
  });

  test("requests format=full, not format=metadata", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("google");
    const syncable = createGmailSyncable({ ensureGoogleMcpRunning: async () => {} });
    let seenUrl = "";

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/gmail/v1/users/me/messages?")) {
        return new Response(
          JSON.stringify({
            messages: [{ id: "m1", threadId: "th1" }],
            nextPageToken: "",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/gmail/v1/users/me/messages/m1")) {
        seenUrl = url;
        return new Response(
          JSON.stringify({
            id: "m1",
            threadId: "th1",
            internalDate: "1700000000000",
            labelIds: ["INBOX"],
            payload: { headers: [{ name: "Subject", value: "Hi" }] },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/gmail/v1/users/me/profile")) {
        return new Response(JSON.stringify({ historyId: "999" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    await syncable.sync(ctx, null);

    expect(seenUrl).toContain("format=full");
    expect(seenUrl).not.toContain("format=metadata");
  });

  test("delta phase: nextPageToken in history response → hasMore=true with delta cursor", async () => {
    // Covers L155 TRUE branch: nextPage present → returns hasMore=true delta cursor
    const { ctx } = await createOAuthConnectorTestSetup("google");
    const syncable = createGmailSyncable({ ensureGoogleMcpRunning: async () => {} });

    const cursor = encodeGmailSyncCursor({
      v: 1,
      phase: "delta",
      startHistoryId: "300",
      pageToken: null,
    });

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/gmail/v1/users/me/history")) {
        return new Response(
          JSON.stringify({
            history: [],
            historyId: "301",
            nextPageToken: "deltaPage2",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const result = await syncable.sync(ctx, cursor);
    expect(result.hasMore).toBe(true);
    const dec = decodeGmailSyncCursor(result.cursor ?? "");
    expect(dec?.phase).toBe("delta");
    if (dec?.phase === "delta") {
      expect(dec.pageToken).toBe("deltaPage2");
      expect(dec.startHistoryId).toBe("300");
    }
  });
});
