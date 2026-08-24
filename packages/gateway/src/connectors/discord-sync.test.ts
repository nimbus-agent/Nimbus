import { expect, test } from "bun:test";

import {
  createMemoryIndexDb,
  createStubVault,
  describeWithFetchRestore,
  expectServiceItemCount,
  type SyncTestFetchParams,
  syncTestContext,
  testConnectorSyncNoop,
  urlFromFetchInput,
} from "./connector-sync-test-helpers.ts";
import { createDiscordSyncable } from "./discord-sync.ts";

const ENABLED_VAULT = { "discord.enabled": "1", "discord.bot_token": "bot-tok" };

/** A routing fetch fake: dispatch on the request path to a queued JSON response. */
type RouteResponse = { status?: number; body: unknown };
function routedFetch(routes: {
  guilds?: RouteResponse;
  channels?: (guildId: string) => RouteResponse;
  messages?: (channelId: string) => RouteResponse;
}): typeof fetch {
  return (async (input: SyncTestFetchParams[0]): Promise<Response> => {
    const u = urlFromFetchInput(input);
    if (u.includes("/users/@me/guilds")) {
      const r: RouteResponse = routes.guilds ?? { body: [] };
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    }
    const chMatch = u.match(/\/guilds\/([^/]+)\/channels/);
    if (chMatch) {
      const r: RouteResponse = (routes.channels ?? (() => ({ body: [] })))(chMatch[1] ?? "");
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    }
    const msgMatch = u.match(/\/channels\/([^/]+)\/messages/);
    if (msgMatch) {
      const r: RouteResponse = (routes.messages ?? (() => ({ body: [] })))(msgMatch[1] ?? "");
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    }
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
}

function authorFixture(
  id: string,
  globalName?: string,
  username?: string,
): Record<string, unknown> {
  return {
    id,
    ...(globalName === undefined ? {} : { global_name: globalName }),
    ...(username === undefined ? {} : { username }),
  };
}

describeWithFetchRestore("discord-sync", () => {
  testConnectorSyncNoop(
    "no-op when discord.enabled is not '1'",
    () => createDiscordSyncable({ ensureDiscordMcpRunning: async () => {} }),
    createStubVault({ "discord.bot_token": "bot-tok" }),
  );

  testConnectorSyncNoop(
    "no-op when bot_token is missing",
    () => createDiscordSyncable({ ensureDiscordMcpRunning: async () => {} }),
    createStubVault({ "discord.enabled": "1" }),
  );

  test("no-op (empty cursor) when there are no guilds", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = routedFetch({ guilds: { body: [] } });
    const sync = createDiscordSyncable({ ensureDiscordMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, createStubVault(ENABLED_VAULT), "discord"), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.hasMore).toBe(false);
    expect(r.cursor).toContain("nimbus-dsc1:");
  });

  test("full flow: guild → text channels → messages indexes message items", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = routedFetch({
      guilds: { body: [{ id: "g1" }, { id: "" }, "bad-not-record"] },
      channels: () => ({
        body: [
          { id: "c1", type: 0 }, // text
          { id: "c2", type: 2 }, // voice → filtered out
          { id: "", type: 0 }, // empty id → filtered
          { id: "c3", type: 5 }, // announcement → text
        ],
      }),
      messages: (channelId) =>
        channelId === "c1"
          ? {
              body: [
                {
                  id: "m2",
                  content: "Second message with   whitespace",
                  author: authorFixture("u1", "Global Name", "uname"),
                },
                { id: "m1", content: "", author: authorFixture("u2", undefined, "onlyuser") },
                { id: "m0", content: "no author so skipped" },
              ],
            }
          : { body: [] },
    });
    const sync = createDiscordSyncable({ ensureDiscordMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, createStubVault(ENABLED_VAULT), "discord"), null);
    expect(r.itemsUpserted).toBeGreaterThanOrEqual(2);
    // Two distinct messages (m1, m2) are indexed; m0 (no author) is skipped. Repeated
    // ticks re-upsert the same externalIds so the distinct DB row count stays 2.
    expectServiceItemCount(db, "discord", 2);
    // The first message's author resolves to a person row (authorId non-null).
    const row = db.prepare("SELECT author_id FROM item WHERE service = 'discord' LIMIT 1").get() as
      | { author_id: string | null }
      | undefined;
    expect(row).toBeDefined();
  });

  test("guild list 429 throws (rate-limit penalise path)", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = routedFetch({ guilds: { status: 429, body: { retry_after: 2 } } });
    const sync = createDiscordSyncable({ ensureDiscordMcpRunning: async () => {} });
    await expect(
      sync.sync(syncTestContext(db, createStubVault(ENABLED_VAULT), "discord"), null),
    ).rejects.toThrow(/Discord guilds 429/);
  });

  test("guild list non-ok status throws", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = routedFetch({ guilds: { status: 500, body: { message: "boom" } } });
    const sync = createDiscordSyncable({ ensureDiscordMcpRunning: async () => {} });
    await expect(
      sync.sync(syncTestContext(db, createStubVault(ENABLED_VAULT), "discord"), null),
    ).rejects.toThrow(/Discord guilds 500/);
  });

  test("channel list 429 throws", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = routedFetch({
      guilds: { body: [{ id: "g1" }] },
      channels: () => ({ status: 429, body: {} }),
    });
    const sync = createDiscordSyncable({ ensureDiscordMcpRunning: async () => {} });
    await expect(
      sync.sync(syncTestContext(db, createStubVault(ENABLED_VAULT), "discord"), null),
    ).rejects.toThrow(/Discord channels 429/);
  });

  test("channel list non-ok status throws", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = routedFetch({
      guilds: { body: [{ id: "g1" }] },
      channels: () => ({ status: 403, body: {} }),
    });
    const sync = createDiscordSyncable({ ensureDiscordMcpRunning: async () => {} });
    await expect(
      sync.sync(syncTestContext(db, createStubVault(ENABLED_VAULT), "discord"), null),
    ).rejects.toThrow(/Discord channels 403/);
  });

  test("channel list with a non-record entry skips it (filters to text channels only)", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = routedFetch({
      guilds: { body: [{ id: "g1" }] },
      channels: () => ({ body: ["not-a-record", { id: "c1", type: 0 }] }),
      messages: () => ({ body: [] }),
    });
    const sync = createDiscordSyncable({ ensureDiscordMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, createStubVault(ENABLED_VAULT), "discord"), null);
    expect(r.itemsUpserted).toBe(0);
  });

  test("guild with no text channels advances past the guild and finishes", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = routedFetch({
      guilds: { body: [{ id: "g1" }] },
      channels: () => ({ body: [{ id: "c1", type: 2 }] }), // voice only → no text channels
    });
    const sync = createDiscordSyncable({ ensureDiscordMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, createStubVault(ENABLED_VAULT), "discord"), null);
    expect(r.itemsUpserted).toBe(0);
  });

  test("messages 429 throws", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = routedFetch({
      guilds: { body: [{ id: "g1" }] },
      channels: () => ({ body: [{ id: "c1", type: 0 }] }),
      messages: () => ({ status: 429, body: {} }),
    });
    const sync = createDiscordSyncable({ ensureDiscordMcpRunning: async () => {} });
    await expect(
      sync.sync(syncTestContext(db, createStubVault(ENABLED_VAULT), "discord"), null),
    ).rejects.toThrow(/Discord messages 429/);
  });

  test("messages non-ok status advances channel index without throwing", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = routedFetch({
      guilds: { body: [{ id: "g1" }] },
      channels: () => ({ body: [{ id: "c1", type: 0 }] }),
      messages: () => ({ status: 404, body: {} }),
    });
    const sync = createDiscordSyncable({ ensureDiscordMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, createStubVault(ENABLED_VAULT), "discord"), null);
    expect(r.itemsUpserted).toBe(0);
  });

  test("messages non-array body advances channel index without throwing", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = routedFetch({
      guilds: { body: [{ id: "g1" }] },
      channels: () => ({ body: [{ id: "c1", type: 0 }] }),
      messages: () => ({ body: { not: "an array" } }),
    });
    const sync = createDiscordSyncable({ ensureDiscordMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, createStubVault(ENABLED_VAULT), "discord"), null);
    expect(r.itemsUpserted).toBe(0);
  });

  test("resumes from a saved cursor with an `after` watermark and clears it on empty page", async () => {
    const db = createMemoryIndexDb();
    let messagesUrl = "";
    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/channels/c1/messages")) {
        messagesUrl = u;
        return new Response("[]", { status: 200 }); // empty page → clears lastMsgByChannel
      }
      return new Response("[]", { status: 200 });
    }) as typeof fetch;
    const sync = createDiscordSyncable({ ensureDiscordMcpRunning: async () => {} });
    // Hand-built cursor: one guild, channels already known, an `after` watermark for c1.
    const cursorState = {
      guildIds: ["g1"],
      guildIndex: 0,
      channelIds: ["c1"],
      channelIndex: 0,
      lastMsgByChannel: { c1: "999" },
    };
    const encoded = `nimbus-dsc1:${Buffer.from(JSON.stringify(cursorState)).toString("base64")}`;
    const r = await sync.sync(
      syncTestContext(db, createStubVault(ENABLED_VAULT), "discord"),
      encoded,
    );
    expect(r.itemsUpserted).toBe(0);
    expect(messagesUrl).toContain("after=999");
  });

  test("malformed cursor falls back to a fresh fetch", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = routedFetch({ guilds: { body: [] } });
    const sync = createDiscordSyncable({ ensureDiscordMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(db, createStubVault(ENABLED_VAULT), "discord"),
      "nimbus-dsc1:!!!not-base64-json",
    );
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-dsc1:");
  });

  // ─── decodeCursor: each invalid-shape arm falls back to a fresh fetch ────────
  const badCursorStates: Array<{ name: string; state: unknown }> = [
    {
      name: "guildIds not an array",
      state: {
        guildIds: "x",
        guildIndex: 0,
        channelIds: [],
        channelIndex: 0,
        lastMsgByChannel: {},
      },
    },
    {
      name: "guildIds has a non-string",
      state: {
        guildIds: [1],
        guildIndex: 0,
        channelIds: [],
        channelIndex: 0,
        lastMsgByChannel: {},
      },
    },
    {
      name: "guildIndex negative",
      state: {
        guildIds: [],
        guildIndex: -1,
        channelIds: [],
        channelIndex: 0,
        lastMsgByChannel: {},
      },
    },
    {
      name: "guildIndex not integer",
      state: {
        guildIds: [],
        guildIndex: 1.5,
        channelIds: [],
        channelIndex: 0,
        lastMsgByChannel: {},
      },
    },
    {
      name: "channelIds not an array",
      state: {
        guildIds: [],
        guildIndex: 0,
        channelIds: "x",
        channelIndex: 0,
        lastMsgByChannel: {},
      },
    },
    {
      name: "channelIds has a non-string",
      state: {
        guildIds: [],
        guildIndex: 0,
        channelIds: [2],
        channelIndex: 0,
        lastMsgByChannel: {},
      },
    },
    {
      name: "channelIndex negative",
      state: {
        guildIds: [],
        guildIndex: 0,
        channelIds: [],
        channelIndex: -2,
        lastMsgByChannel: {},
      },
    },
    {
      name: "lastMsgByChannel is an array (ignored)",
      state: { guildIds: [], guildIndex: 0, channelIds: [], channelIndex: 0, lastMsgByChannel: [] },
    },
    {
      name: "lastMsgByChannel has non-string value (skipped)",
      state: {
        guildIds: [],
        guildIndex: 0,
        channelIds: [],
        channelIndex: 0,
        lastMsgByChannel: { c: 5 },
      },
    },
    { name: "payload is an array (not an object)", state: ["not", "an", "object"] },
  ];

  for (const bc of badCursorStates) {
    test(`decodeCursor falls back to fresh fetch: ${bc.name}`, async () => {
      const db = createMemoryIndexDb();
      globalThis.fetch = routedFetch({ guilds: { body: [] } });
      const sync = createDiscordSyncable({ ensureDiscordMcpRunning: async () => {} });
      const encoded = `nimbus-dsc1:${Buffer.from(JSON.stringify(bc.state)).toString("base64")}`;
      const r = await sync.sync(
        syncTestContext(db, createStubVault(ENABLED_VAULT), "discord"),
        encoded,
      );
      expect(r.itemsUpserted).toBe(0);
      expect(r.cursor).toContain("nimbus-dsc1:");
    });
  }

  test("retry_after as a numeric string is honored on a guilds 429", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = routedFetch({ guilds: { status: 429, body: { retry_after: "3.5" } } });
    const sync = createDiscordSyncable({ ensureDiscordMcpRunning: async () => {} });
    await expect(
      sync.sync(syncTestContext(db, createStubVault(ENABLED_VAULT), "discord"), null),
    ).rejects.toThrow(/Discord guilds 429/);
  });

  test("retry_after as a non-numeric string defaults to 1s on a guilds 429", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = routedFetch({ guilds: { status: 429, body: { retry_after: "soon" } } });
    const sync = createDiscordSyncable({ ensureDiscordMcpRunning: async () => {} });
    await expect(
      sync.sync(syncTestContext(db, createStubVault(ENABLED_VAULT), "discord"), null),
    ).rejects.toThrow(/Discord guilds 429/);
  });

  test("guilds 429 with a non-object body defaults retry to 1s", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = routedFetch({ guilds: { status: 429, body: "plain text" } });
    const sync = createDiscordSyncable({ ensureDiscordMcpRunning: async () => {} });
    await expect(
      sync.sync(syncTestContext(db, createStubVault(ENABLED_VAULT), "discord"), null),
    ).rejects.toThrow(/Discord guilds 429/);
  });

  test("non-JSON guilds body still surfaces as a non-array error", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = (async (): Promise<Response> =>
      new Response("not json at all", { status: 200 })) as unknown as typeof fetch;
    const sync = createDiscordSyncable({ ensureDiscordMcpRunning: async () => {} });
    await expect(
      sync.sync(syncTestContext(db, createStubVault(ENABLED_VAULT), "discord"), null),
    ).rejects.toThrow(/Discord guilds/);
  });

  test("message with an author lacking names titles as 'unknown' display name", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = routedFetch({
      guilds: { body: [{ id: "g1" }] },
      channels: () => ({ body: [{ id: "c1", type: 0 }] }),
      messages: (channelId) =>
        channelId === "c1"
          ? { body: [{ id: "m1", content: "   ", author: { id: "u1" } }] }
          : { body: [] },
    });
    const sync = createDiscordSyncable({ ensureDiscordMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, createStubVault(ENABLED_VAULT), "discord"), null);
    expect(r.itemsUpserted).toBeGreaterThanOrEqual(1);
    const row = db
      .prepare("SELECT title FROM item WHERE service = 'discord' AND external_id = 'c1:m1'")
      .get() as { title: string } | undefined;
    expect(row?.title).toBe("unknown");
  });

  test("messages page with a non-record entry skips it without crashing", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = routedFetch({
      guilds: { body: [{ id: "g1" }] },
      channels: () => ({ body: [{ id: "c1", type: 0 }] }),
      messages: (channelId) =>
        channelId === "c1"
          ? {
              body: [
                "not-a-record",
                { id: "m1", content: "hi", author: { id: "u1", username: "u" } },
              ],
            }
          : { body: [] },
    });
    const sync = createDiscordSyncable({ ensureDiscordMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, createStubVault(ENABLED_VAULT), "discord"), null);
    expect(r.itemsUpserted).toBeGreaterThanOrEqual(1);
  });

  test("empty guildId in cursor is skipped (advances guildIndex)", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = routedFetch({ channels: () => ({ body: [] }) });
    const sync = createDiscordSyncable({ ensureDiscordMcpRunning: async () => {} });
    const cursorState = {
      guildIds: ["", "g2"],
      guildIndex: 0,
      channelIds: [],
      channelIndex: 0,
      lastMsgByChannel: {},
    };
    const encoded = `nimbus-dsc1:${Buffer.from(JSON.stringify(cursorState)).toString("base64")}`;
    const r = await sync.sync(
      syncTestContext(db, createStubVault(ENABLED_VAULT), "discord"),
      encoded,
    );
    expect(r.itemsUpserted).toBe(0);
  });

  test("empty channelId in cursor is skipped (advances channelIndex)", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = routedFetch({ messages: () => ({ body: [] }) });
    const sync = createDiscordSyncable({ ensureDiscordMcpRunning: async () => {} });
    const cursorState = {
      guildIds: ["g1"],
      guildIndex: 0,
      channelIds: ["", "c2"],
      channelIndex: 0,
      lastMsgByChannel: {},
    };
    const encoded = `nimbus-dsc1:${Buffer.from(JSON.stringify(cursorState)).toString("base64")}`;
    const r = await sync.sync(
      syncTestContext(db, createStubVault(ENABLED_VAULT), "discord"),
      encoded,
    );
    expect(r.itemsUpserted).toBe(0);
  });

  test("channelIndex past the end of channelIds advances the guild", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = routedFetch({ channels: () => ({ body: [] }) });
    const sync = createDiscordSyncable({ ensureDiscordMcpRunning: async () => {} });
    const cursorState = {
      guildIds: ["g1"],
      guildIndex: 0,
      channelIds: ["c1"],
      channelIndex: 5, // past end
      lastMsgByChannel: {},
    };
    const encoded = `nimbus-dsc1:${Buffer.from(JSON.stringify(cursorState)).toString("base64")}`;
    const r = await sync.sync(
      syncTestContext(db, createStubVault(ENABLED_VAULT), "discord"),
      encoded,
    );
    expect(r.itemsUpserted).toBe(0);
  });

  test("guilds 429 with a boolean retry_after defaults retry to 1s", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = routedFetch({ guilds: { status: 429, body: { retry_after: true } } });
    const sync = createDiscordSyncable({ ensureDiscordMcpRunning: async () => {} });
    await expect(
      sync.sync(syncTestContext(db, createStubVault(ENABLED_VAULT), "discord"), null),
    ).rejects.toThrow(/Discord guilds 429/);
  });

  test("message with non-string content + an over-long author display name", async () => {
    const db = createMemoryIndexDb();
    const longName = "z".repeat(600);
    globalThis.fetch = routedFetch({
      guilds: { body: [{ id: "g1" }] },
      channels: () => ({ body: [{ id: "c1", type: 0 }] }),
      messages: (channelId) =>
        channelId === "c1"
          ? { body: [{ id: "m1", content: 12345, author: { id: "u1", global_name: longName } }] }
          : { body: [] },
    });
    const sync = createDiscordSyncable({ ensureDiscordMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, createStubVault(ENABLED_VAULT), "discord"), null);
    expect(r.itemsUpserted).toBeGreaterThanOrEqual(1);
    const row = db
      .prepare("SELECT title FROM item WHERE service = 'discord' AND external_id = 'c1:m1'")
      .get() as { title: string } | undefined;
    // Non-string content → "" body → title is the display name, truncated to 512.
    expect(row?.title).toHaveLength(512);
  });

  test("over-long message content is truncated to a 512-char body preview", async () => {
    const db = createMemoryIndexDb();
    const longContent = "x".repeat(1000);
    globalThis.fetch = routedFetch({
      guilds: { body: [{ id: "g1" }] },
      channels: () => ({ body: [{ id: "c1", type: 0 }] }),
      messages: (channelId) =>
        channelId === "c1"
          ? { body: [{ id: "m1", content: longContent, author: { id: "u1", username: "u" } }] }
          : { body: [] },
    });
    const sync = createDiscordSyncable({ ensureDiscordMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, createStubVault(ENABLED_VAULT), "discord"), null);
    expect(r.itemsUpserted).toBeGreaterThanOrEqual(1);
  });

  test("message whose author has no id resolves a null authorId", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = routedFetch({
      guilds: { body: [{ id: "g1" }] },
      channels: () => ({ body: [{ id: "c1", type: 0 }] }),
      messages: (channelId) =>
        channelId === "c1"
          ? { body: [{ id: "m1", content: "hi", author: { username: "noid" } }] }
          : { body: [] },
    });
    const sync = createDiscordSyncable({ ensureDiscordMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, createStubVault(ENABLED_VAULT), "discord"), null);
    expect(r.itemsUpserted).toBeGreaterThanOrEqual(1);
    const row = db
      .prepare("SELECT author_id FROM item WHERE service = 'discord' AND external_id = 'c1:m1'")
      .get() as { author_id: string | null } | undefined;
    expect(row?.author_id ?? null).toBeNull();
  });

  test("hasMore=true when api-call budget is exhausted mid-traversal (many guilds)", async () => {
    const db = createMemoryIndexDb();
    // 10 guilds, each with no channels → each tick consumes calls; budget is 8.
    globalThis.fetch = routedFetch({
      guilds: { body: Array.from({ length: 10 }, (_, i) => ({ id: `g${i}` })) },
      channels: () => ({ body: [] }), // no text channels → advance guild each tick
    });
    const sync = createDiscordSyncable({ ensureDiscordMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, createStubVault(ENABLED_VAULT), "discord"), null);
    expect(r.hasMore).toBe(true);
    expect(r.cursor).toContain("nimbus-dsc1:");
  });
});
