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
});
