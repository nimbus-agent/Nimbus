import { afterEach, describe, expect, test } from "bun:test";
import type { Logger } from "pino";
import {
  createOAuthConnectorTestSetup,
  registerGlobalFetchRestore,
  requestUrlString,
} from "../../../testing/bun-test-support.ts";
import {
  applyGmailHistoryRecords,
  fetchGmailHistoryOrReset,
  resolveDeltaHistoryId,
} from "./history.ts";

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

describe("applyGmailHistoryRecords", () => {
  registerGlobalFetchRestore(afterEach);

  // L79: hist.history is undefined → empty records loop, returns zero counts
  test("no history property → returns zeros and empty hist", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("google", "gmail");
    const histJson: unknown = { historyId: "500" };
    const result = await applyGmailHistoryRecords(ctx, "tok", Date.now(), histJson);
    expect(result.itemsUpserted).toBe(0);
    expect(result.itemsDeleted).toBe(0);
    expect(result.hist.historyId).toBe("500");
  });

  // L83: messagesAdded undefined → treated as []
  test("history record with no messagesAdded/messagesDeleted → zeros", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("google", "gmail");
    const histJson: unknown = {
      history: [{ id: "1" }],
      historyId: "501",
    };
    const result = await applyGmailHistoryRecords(ctx, "tok", Date.now(), histJson);
    expect(result.itemsUpserted).toBe(0);
    expect(result.itemsDeleted).toBe(0);
  });

  // L26: message entry where message is undefined → skipped (continue branch)
  test("messagesAdded entry with undefined message → skipped", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("google", "gmail");
    const histJson: unknown = {
      history: [
        {
          id: "1",
          messagesAdded: [
            {}, // no message property → message === undefined
          ],
        },
      ],
      historyId: "502",
    };
    const result = await applyGmailHistoryRecords(ctx, "tok", Date.now(), histJson);
    expect(result.itemsUpserted).toBe(0);
  });

  // L30: message.id is undefined → skipped
  test("messagesAdded entry with message but no id → skipped", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("google", "gmail");
    const histJson: unknown = {
      history: [
        {
          id: "1",
          messagesAdded: [
            { message: { threadId: "t1" } }, // id missing
          ],
        },
      ],
      historyId: "503",
    };
    const result = await applyGmailHistoryRecords(ctx, "tok", Date.now(), histJson);
    expect(result.itemsUpserted).toBe(0);
  });

  // L30: message.id is "" → skipped
  test("messagesAdded entry with empty string id → skipped", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("google", "gmail");
    const histJson: unknown = {
      history: [
        {
          id: "1",
          messagesAdded: [{ message: { id: "", threadId: "t1" } }],
        },
      ],
      historyId: "504",
    };
    const result = await applyGmailHistoryRecords(ctx, "tok", Date.now(), histJson);
    expect(result.itemsUpserted).toBe(0);
  });

  // L33/L35: message has payload with Subject → hasSubject=true → use m directly (no fetch)
  test("messagesAdded entry with payload+Subject → upserted without fetch", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("google", "gmail");
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("should not be called", { status: 500 });
    }) as unknown as typeof fetch;

    const histJson: unknown = {
      history: [
        {
          id: "1",
          messagesAdded: [
            {
              message: {
                id: "msg1",
                threadId: "th1",
                snippet: "hello",
                internalDate: "1700000000000",
                labelIds: ["INBOX"],
                payload: {
                  headers: [
                    { name: "Subject", value: "Test Subject" },
                    { name: "From", value: "sender@example.com" },
                  ],
                },
              },
            },
          ],
        },
      ],
      historyId: "505",
    };
    const result = await applyGmailHistoryRecords(ctx, "tok", Date.now(), histJson);
    expect(result.itemsUpserted).toBe(1);
    expect(fetchCalled).toBe(false);
  });

  // L35 false branch: message has no payload → hasSubject=false → fetch is called
  // Also covers L33's false path for hasSubject
  test("messagesAdded entry without payload → fetches metadata", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("google", "gmail");

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/gmail/v1/users/me/messages/msg2")) {
        return new Response(
          JSON.stringify({
            id: "msg2",
            threadId: "th2",
            snippet: "fetched snippet",
            internalDate: "1700000000000",
            labelIds: ["INBOX"],
            payload: {
              headers: [
                { name: "Subject", value: "Fetched Subject" },
                { name: "From", value: "other@example.com" },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch;

    const histJson: unknown = {
      history: [
        {
          id: "1",
          messagesAdded: [
            {
              message: {
                id: "msg2",
                threadId: "th2",
                // no payload → hasSubject = false → fetch path
              },
            },
          ],
        },
      ],
      historyId: "506",
    };
    const result = await applyGmailHistoryRecords(ctx, "tok", Date.now(), histJson);
    expect(result.itemsUpserted).toBe(1);
  });

  // L35 false branch + 404 fetch → warn + continue
  test("messagesAdded fetch returns 404 → warns and skips", async () => {
    const setup = await createOAuthConnectorTestSetup("google", "gmail");
    const { logger, warns } = capturingLogger(setup.ctx.logger);
    const ctx = { ...setup.ctx, logger };

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/gmail/v1/users/me/messages/gone1")) {
        return new Response(JSON.stringify({ error: { code: 404, message: "Not Found" } }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch;

    const histJson: unknown = {
      history: [
        {
          id: "1",
          messagesAdded: [{ message: { id: "gone1", threadId: "th1" } }],
        },
      ],
      historyId: "507",
    };
    const result = await applyGmailHistoryRecords(ctx, "tok", Date.now(), histJson);
    expect(result.itemsUpserted).toBe(0);
    const w = warns.find((entry) => {
      const o = entry.obj as Record<string, unknown> | null;
      return o !== null && o["messageId"] === "gone1" && o["stage"] === "delta";
    });
    expect(w).toBeDefined();
  });

  // L60: deleted entry where message.id is undefined → not counted (false branch of typeof check)
  test("messagesDeleted entry with no message id → not counted", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("google", "gmail");
    const histJson: unknown = {
      history: [
        {
          id: "1",
          messagesDeleted: [
            {}, // no message at all → mid is undefined
            { message: {} }, // message exists but no id
            { message: { id: "" } }, // empty string id
          ],
        },
      ],
      historyId: "508",
    };
    const result = await applyGmailHistoryRecords(ctx, "tok", Date.now(), histJson);
    expect(result.itemsDeleted).toBe(0);
  });

  // L60 true branch: deleted entry with valid message.id → counted
  test("messagesDeleted entry with valid id → counted", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("google", "gmail");
    const histJson: unknown = {
      history: [
        {
          id: "1",
          messagesDeleted: [{ message: { id: "del1" } }],
        },
      ],
      historyId: "509",
    };
    const result = await applyGmailHistoryRecords(ctx, "tok", Date.now(), histJson);
    expect(result.itemsDeleted).toBe(1);
  });
});

describe("fetchGmailHistoryOrReset", () => {
  registerGlobalFetchRestore(afterEach);

  // L97 true branch: pageToken is non-null non-empty → included in URL
  test("pageToken provided → included in history URL", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (input: FetchInput) => {
      capturedUrl = requestUrlString(input);
      return new Response(JSON.stringify({ history: [], historyId: "200" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const { ctx } = await createOAuthConnectorTestSetup("google", "gmail");
    const result = await fetchGmailHistoryOrReset(ctx, "tok", {
      startHistoryId: "100",
      pageToken: "myPageToken",
    });
    expect(result.kind).toBe("ok");
    expect(capturedUrl).toContain("pageToken=myPageToken");
  });

  // L97 false branch (null): pageToken null → not included
  test("pageToken null → not included in history URL", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (input: FetchInput) => {
      capturedUrl = requestUrlString(input);
      return new Response(JSON.stringify({ history: [], historyId: "201" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const { ctx } = await createOAuthConnectorTestSetup("google", "gmail");
    const result = await fetchGmailHistoryOrReset(ctx, "tok", {
      startHistoryId: "100",
      pageToken: null,
    });
    expect(result.kind).toBe("ok");
    expect(capturedUrl).not.toContain("pageToken=");
  });

  // L97 false branch (empty string): pageToken "" → not included
  test("pageToken empty string → not included in history URL", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (input: FetchInput) => {
      capturedUrl = requestUrlString(input);
      return new Response(JSON.stringify({ history: [], historyId: "202" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const { ctx } = await createOAuthConnectorTestSetup("google", "gmail");
    const result = await fetchGmailHistoryOrReset(ctx, "tok", {
      startHistoryId: "100",
      pageToken: "",
    });
    expect(result.kind).toBe("ok");
    expect(capturedUrl).not.toContain("pageToken=");
  });

  // L107 true branch: fetch throws with "404" in message → returns { kind: "reset" }
  test("gmailFetchJson throws 404 error → returns reset", async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ error: { code: 404, message: "Not Found" } }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const { ctx } = await createOAuthConnectorTestSetup("google", "gmail");
    const result = await fetchGmailHistoryOrReset(ctx, "tok", {
      startHistoryId: "100",
      pageToken: null,
    });
    expect(result.kind).toBe("reset");
  });

  // L107 false branch: fetch throws non-404 error → rethrows
  test("gmailFetchJson throws non-404 error → rethrows", async () => {
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({ error: { code: 500, message: "Internal Server Error" } }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const { ctx } = await createOAuthConnectorTestSetup("google", "gmail");
    await expect(
      fetchGmailHistoryOrReset(ctx, "tok", {
        startHistoryId: "100",
        pageToken: null,
      }),
    ).rejects.toThrow();
  });

  // L107 catch: non-Error thrown value with "404" in its string → reset
  // (covers extractErrorMessage typeof e === "string" branch + includes("404"))
  test("string error containing 404 → returns reset", async () => {
    globalThis.fetch = (async () => {
      throw "Gmail sync failed: 404 history expired" as unknown;
    }) as unknown as typeof fetch;

    const { ctx } = await createOAuthConnectorTestSetup("google", "gmail");
    const result = await fetchGmailHistoryOrReset(ctx, "tok", {
      startHistoryId: "100",
      pageToken: null,
    });
    expect(result.kind).toBe("reset");
  });

  // L107 catch: non-Error thrown value NOT containing "404" → rethrows
  test("string error without 404 → rethrows", async () => {
    globalThis.fetch = (async () => {
      throw "some transient failure" as unknown;
    }) as unknown as typeof fetch;

    const { ctx } = await createOAuthConnectorTestSetup("google", "gmail");
    await expect(
      fetchGmailHistoryOrReset(ctx, "tok", {
        startHistoryId: "100",
        pageToken: null,
      }),
    ).rejects.toBe("some transient failure");
  });
});

describe("resolveDeltaHistoryId", () => {
  registerGlobalFetchRestore(afterEach);

  // L123 true branch: candidate is a non-empty string → returned directly
  test("valid candidate → returned without fetching profile", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const { ctx } = await createOAuthConnectorTestSetup("google", "gmail");
    const result = await resolveDeltaHistoryId(ctx, "tok", "12345");
    expect(result).toBe("12345");
    expect(fetchCalled).toBe(false);
  });

  // L123 false branch: candidate undefined → fetches profile
  test("candidate undefined → fetches profile historyId", async () => {
    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/gmail/v1/users/me/profile")) {
        return new Response(
          JSON.stringify({ historyId: "99999", emailAddress: "user@example.com" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch;

    const { ctx } = await createOAuthConnectorTestSetup("google", "gmail");
    const result = await resolveDeltaHistoryId(ctx, "tok", undefined);
    expect(result).toBe("99999");
  });

  // L123 false branch: candidate "" → fetches profile
  test("candidate empty string → fetches profile historyId", async () => {
    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/gmail/v1/users/me/profile")) {
        return new Response(JSON.stringify({ historyId: "88888" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch;

    const { ctx } = await createOAuthConnectorTestSetup("google", "gmail");
    const result = await resolveDeltaHistoryId(ctx, "tok", "");
    expect(result).toBe("88888");
  });

  // L128 true branch: profile has no historyId → throws
  test("profile missing historyId → throws", async () => {
    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/gmail/v1/users/me/profile")) {
        return new Response(JSON.stringify({ emailAddress: "user@example.com" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch;

    const { ctx } = await createOAuthConnectorTestSetup("google", "gmail");
    await expect(resolveDeltaHistoryId(ctx, "tok", undefined)).rejects.toThrow(
      "Gmail sync failed: history response missing historyId",
    );
  });

  // L128 true branch: profile historyId is empty string → throws
  test("profile historyId empty string → throws", async () => {
    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/gmail/v1/users/me/profile")) {
        return new Response(JSON.stringify({ historyId: "" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch;

    const { ctx } = await createOAuthConnectorTestSetup("google", "gmail");
    await expect(resolveDeltaHistoryId(ctx, "tok", undefined)).rejects.toThrow(
      "Gmail sync failed: history response missing historyId",
    );
  });
});
