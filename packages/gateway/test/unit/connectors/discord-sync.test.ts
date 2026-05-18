import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createDiscordSyncable } from "../../../src/connectors/discord-sync.ts";
import {
  type ConnectorSyncFixture,
  createConnectorSyncFixture,
} from "../../helpers/connector-sync-harness.ts";

const ENSURE_MCP = { ensureDiscordMcpRunning: async (): Promise<void> => {} };
const CURSOR_PREFIX = "nimbus-dsc1:";

// URL matchers. Discord paths are simple — `users/@me/guilds`, `guilds/{id}/channels`,
// and `channels/{id}/messages?limit=50[&after=...]`. We use anchored regexes so a
// mistyped URL fragment in production fails fast.
const GUILDS_URL = "https://discord.com/api/v10/users/@me/guilds";
const CHANNELS_RE = /^https:\/\/discord\.com\/api\/v10\/guilds\/[^/]+\/channels$/;
const MESSAGES_RE = /^https:\/\/discord\.com\/api\/v10\/channels\/[^/]+\/messages\?limit=50/;

const DISCORD_USER_AGENT = "NimbusGateway (https://github.com/nimbus-dev/nimbus)";

function encodeCursor(payload: unknown): string {
  return CURSOR_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor<T>(cursor: string): T {
  const body = cursor.slice(CURSOR_PREFIX.length);
  return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
}

/**
 * Run a callback against a fresh fixture that does NOT inherit the
 * default vault-seeded credentials from `beforeEach`. Mirrors the
 * bitbucket-sync.test.ts pattern. Used by the credential-short-circuit
 * tests so each can stage its own vault state (or none) without leakage.
 */
async function withIsolatedFixture(
  fn: (fixture: ConnectorSyncFixture) => Promise<void>,
): Promise<void> {
  const isolated = createConnectorSyncFixture();
  isolated.fetchMock.install();
  try {
    await fn(isolated);
  } finally {
    isolated.cleanup();
  }
}

let fixture: ConnectorSyncFixture;

beforeEach(async () => {
  fixture = createConnectorSyncFixture();
  fixture.fetchMock.install();
  // Seed credentials so default cases reach the fetch path. Discord requires
  // BOTH `discord.enabled === "1"` AND a non-empty `discord.bot_token`.
  // Avoid all-caps gitleaks-trigger patterns in fixture values.
  await fixture.vault.set("discord.enabled", "1");
  await fixture.vault.set("discord.bot_token", "discord-stub-bot-token");
});

afterEach(() => {
  fixture.cleanup();
});

describe("discord-sync — credential short-circuits", () => {
  test("returns noop when neither vault key is set", async () => {
    await withIsolatedFixture(async (iso) => {
      const syncable = createDiscordSyncable(ENSURE_MCP);
      const res = await syncable.sync(iso.createSyncContext(), null);
      expect(res.hasMore).toBe(false);
      expect(res.itemsUpserted).toBe(0);
      expect(res.itemsDeleted).toBe(0);
      expect(iso.fetchMock.calls).toHaveLength(0);
    });
  });

  test("returns noop when discord.enabled is set but bot_token is missing", async () => {
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("discord.enabled", "1");
      const syncable = createDiscordSyncable(ENSURE_MCP);
      const res = await syncable.sync(iso.createSyncContext(), null);
      expect(res.hasMore).toBe(false);
      expect(iso.fetchMock.calls).toHaveLength(0);
    });
  });

  test("returns noop when bot_token is the empty string", async () => {
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("discord.enabled", "1");
      await iso.vault.set("discord.bot_token", "");
      const syncable = createDiscordSyncable(ENSURE_MCP);
      const res = await syncable.sync(iso.createSyncContext(), null);
      expect(res.hasMore).toBe(false);
      expect(iso.fetchMock.calls).toHaveLength(0);
    });
  });

  test("returns noop when enabled is set to a value other than '1'", async () => {
    // Production gate is `enabled !== "1"`, so "true" / "yes" / "0" / "" all short-circuit.
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("discord.enabled", "true");
      await iso.vault.set("discord.bot_token", "discord-stub-bot-token");
      const syncable = createDiscordSyncable(ENSURE_MCP);
      const res = await syncable.sync(iso.createSyncContext(), null);
      expect(res.hasMore).toBe(false);
      expect(iso.fetchMock.calls).toHaveLength(0);
    });
  });

  test("syncNoopResult preserves the incoming cursor", async () => {
    await withIsolatedFixture(async (iso) => {
      const incomingCursor = "nimbus-dsc1:opaque-cursor-value";
      const syncable = createDiscordSyncable(ENSURE_MCP);
      const res = await syncable.sync(iso.createSyncContext(), incomingCursor);
      expect(res.cursor).toBe(incomingCursor);
    });
  });
});

describe("discord-sync — cursor decode failures", () => {
  function stageEmptyGuilds(): void {
    // Empty guild list ends the cycle immediately; if the cursor was decoded
    // successfully into a non-default state, no fetch would fire at all.
    fixture.fetchMock.respond("GET", GUILDS_URL, []);
  }

  test("null cursor falls back to default state and fetches guild list", async () => {
    stageEmptyGuilds();
    const res = await createDiscordSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.hasMore).toBe(false);
    expect(fixture.fetchMock.calls).toHaveLength(1);
    expect(fixture.fetchMock.calls[0].url).toBe(GUILDS_URL);
  });

  test("empty string cursor falls back to default", async () => {
    stageEmptyGuilds();
    const res = await createDiscordSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), "");
    expect(res.hasMore).toBe(false);
    expect(fixture.fetchMock.calls).toHaveLength(1);
  });

  test("wrong-prefix cursor falls back to default", async () => {
    stageEmptyGuilds();
    const res = await createDiscordSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      "nimbus-other:abc",
    );
    expect(res.hasMore).toBe(false);
    expect(fixture.fetchMock.calls).toHaveLength(1);
  });

  test("non-base64 / garbage cursor body falls back to default", async () => {
    stageEmptyGuilds();
    const res = await createDiscordSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      `${CURSOR_PREFIX}!!!not-base64!!!`,
    );
    expect(res.hasMore).toBe(false);
    expect(fixture.fetchMock.calls).toHaveLength(1);
  });

  test("cursor JSON parses to array → falls back", async () => {
    stageEmptyGuilds();
    const res = await createDiscordSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      encodeCursor([1, 2, 3]),
    );
    expect(res.hasMore).toBe(false);
    expect(fixture.fetchMock.calls).toHaveLength(1);
  });

  test("cursor JSON parses to null → falls back", async () => {
    stageEmptyGuilds();
    const res = await createDiscordSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      encodeCursor(null),
    );
    expect(res.hasMore).toBe(false);
  });

  test("cursor missing guildIds (object without it) → falls back", async () => {
    stageEmptyGuilds();
    const res = await createDiscordSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      encodeCursor({ guildIndex: 0, channelIds: [], channelIndex: 0 }),
    );
    expect(res.hasMore).toBe(false);
    expect(fixture.fetchMock.calls).toHaveLength(1);
  });

  test("cursor with non-string entry in guildIds → falls back", async () => {
    stageEmptyGuilds();
    const res = await createDiscordSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      encodeCursor({
        guildIds: ["g1", 42],
        guildIndex: 0,
        channelIds: [],
        channelIndex: 0,
      }),
    );
    expect(res.hasMore).toBe(false);
  });

  test("cursor with negative guildIndex → falls back", async () => {
    stageEmptyGuilds();
    const res = await createDiscordSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      encodeCursor({
        guildIds: ["g1"],
        guildIndex: -1,
        channelIds: [],
        channelIndex: 0,
      }),
    );
    expect(res.hasMore).toBe(false);
  });

  test("cursor with non-integer guildIndex → falls back", async () => {
    stageEmptyGuilds();
    const res = await createDiscordSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      encodeCursor({
        guildIds: ["g1"],
        guildIndex: 0.5,
        channelIds: [],
        channelIndex: 0,
      }),
    );
    expect(res.hasMore).toBe(false);
  });

  test("cursor with non-array channelIds → falls back", async () => {
    stageEmptyGuilds();
    const res = await createDiscordSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      encodeCursor({
        guildIds: ["g1"],
        guildIndex: 0,
        channelIds: "not-an-array",
        channelIndex: 0,
      }),
    );
    expect(res.hasMore).toBe(false);
  });

  test("cursor with negative channelIndex → falls back", async () => {
    stageEmptyGuilds();
    const res = await createDiscordSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      encodeCursor({
        guildIds: ["g1"],
        guildIndex: 0,
        channelIds: ["c1"],
        channelIndex: -1,
      }),
    );
    expect(res.hasMore).toBe(false);
  });

  test("cursor with lastMsgByChannel as array → silently defaults to empty map (decodes ok)", async () => {
    // The decoder accepts the cursor (array channelIds is rejected, but a non-record
    // lastMsgByChannel is silently treated as `{}`). With guildIds=["g1"] and
    // guildIndex=0, the run progresses; stage a channel-list fetch.
    fixture.fetchMock.respond("GET", CHANNELS_RE, []);
    const res = await createDiscordSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      encodeCursor({
        guildIds: ["g1"],
        guildIndex: 0,
        channelIds: [],
        channelIndex: 0,
        lastMsgByChannel: [42, "not-a-record"],
      }),
    );
    // No channels in g1 → guildIndex advanced past length → cycle ends.
    expect(res.hasMore).toBe(false);
    // One channel-list fetch fired; no guilds fetch because guildIds had length 1.
    const ch = fixture.fetchMock.calls.filter((c) => CHANNELS_RE.test(c.url));
    expect(ch).toHaveLength(1);
  });
});

describe("discord-sync — HTTP request paths", () => {
  test("sends `Bot <token>` Authorization header on guild list", async () => {
    fixture.fetchMock.respond("GET", GUILDS_URL, []);
    await createDiscordSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);

    expect(fixture.fetchMock.calls).toHaveLength(1);
    expect(fixture.fetchMock.calls[0].headers["authorization"]).toBe("Bot discord-stub-bot-token");
  });

  test("sends the documented User-Agent header on every request", async () => {
    fixture.fetchMock.respond("GET", GUILDS_URL, [{ id: "g1" }]);
    fixture.fetchMock.respond("GET", CHANNELS_RE, [{ id: "c1", type: 0 }]);
    fixture.fetchMock.respond("GET", MESSAGES_RE, []);
    await createDiscordSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);

    // Production hard-codes `User-Agent: NimbusGateway (https://github.com/nimbus-dev/nimbus)`.
    // Lower-cased lookup is correct (MockFetch normalises header keys).
    expect(fixture.fetchMock.calls.length).toBeGreaterThan(0);
    for (const call of fixture.fetchMock.calls) {
      expect(call.headers["user-agent"]).toBe(DISCORD_USER_AGENT);
    }
  });

  test("429 with JSON body `{ retry_after }` → throws Discord guilds 429", async () => {
    fixture.fetchMock.respond("GET", GUILDS_URL, { retry_after: 0.5 }, { status: 429 });
    await expect(
      createDiscordSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null),
    ).rejects.toThrow(/Discord guilds 429/);
  });

  test("429 with non-numeric retry_after still throws", async () => {
    fixture.fetchMock.respond("GET", GUILDS_URL, { retry_after: "later" }, { status: 429 });
    await expect(
      createDiscordSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null),
    ).rejects.toThrow(/Discord guilds 429/);
  });

  test("non-200 non-429 on guild list throws", async () => {
    fixture.fetchMock.respond("GET", GUILDS_URL, { error: "server" }, { status: 500 });
    await expect(
      createDiscordSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null),
    ).rejects.toThrow(/Discord guilds 500/);
  });

  test("non-array body on guild list (200 OK but JSON object) throws", async () => {
    fixture.fetchMock.respond("GET", GUILDS_URL, { not: "an-array" });
    await expect(
      createDiscordSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null),
    ).rejects.toThrow(/Discord guilds/);
  });

  test("429 on channel list throws Discord channels 429", async () => {
    fixture.fetchMock.respond("GET", GUILDS_URL, [{ id: "g1" }]);
    fixture.fetchMock.respond("GET", CHANNELS_RE, { retry_after: 1 }, { status: 429 });
    await expect(
      createDiscordSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null),
    ).rejects.toThrow(/Discord channels 429/);
  });

  test("non-200 on channel list throws", async () => {
    fixture.fetchMock.respond("GET", GUILDS_URL, [{ id: "g1" }]);
    fixture.fetchMock.respond("GET", CHANNELS_RE, { error: "forbidden" }, { status: 403 });
    await expect(
      createDiscordSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null),
    ).rejects.toThrow(/Discord channels 403/);
  });

  test("429 on messages fetch throws Discord messages 429", async () => {
    fixture.fetchMock.respond("GET", GUILDS_URL, [{ id: "g1" }]);
    fixture.fetchMock.respond("GET", CHANNELS_RE, [{ id: "c1", type: 0 }]);
    fixture.fetchMock.respond("GET", MESSAGES_RE, { retry_after: 2 }, { status: 429 });
    await expect(
      createDiscordSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null),
    ).rejects.toThrow(/Discord messages 429/);
  });

  test("non-200 non-429 on messages silently advances the channel (no throw)", async () => {
    // Production code at discord-sync.ts:344–346 only throws on 429; any other
    // non-OK response is swallowed and `channelIndex` is incremented. That keeps
    // a single bad channel from blocking the rest of the cycle.
    fixture.fetchMock.respond("GET", GUILDS_URL, [{ id: "g1" }]);
    fixture.fetchMock.respond("GET", CHANNELS_RE, [{ id: "c1", type: 0 }]);
    fixture.fetchMock.respond("GET", MESSAGES_RE, { error: "forbidden" }, { status: 403 });
    const res = await createDiscordSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    // No items, but the cycle completes — c1 was the only channel in g1; after
    // advancing channelIndex, the next tick advances guildIndex, and the cycle ends.
    expect(res.hasMore).toBe(false);
    expect(res.itemsUpserted).toBe(0);
  });
});

describe("discord-sync — indexing skip paths", () => {
  test("message with empty id is skipped", async () => {
    fixture.fetchMock.respond("GET", GUILDS_URL, [{ id: "g1" }]);
    fixture.fetchMock.respond("GET", CHANNELS_RE, [{ id: "c1", type: 0 }]);
    fixture.fetchMock.respond("GET", MESSAGES_RE, [
      { id: "", content: "no-id", author: { id: "u1", username: "alice" } },
      { id: "m1", content: "kept", author: { id: "u1", username: "alice" } },
    ]);
    await createDiscordSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    const rows = fixture.db
      .query<{ external_id: string }, []>("SELECT external_id FROM item WHERE service = 'discord'")
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].external_id).toBe("c1:m1");
  });

  test("message with missing author is skipped", async () => {
    fixture.fetchMock.respond("GET", GUILDS_URL, [{ id: "g1" }]);
    fixture.fetchMock.respond("GET", CHANNELS_RE, [{ id: "c1", type: 0 }]);
    fixture.fetchMock.respond("GET", MESSAGES_RE, [
      { id: "m2", content: "no-author" }, // missing author → skipped
      { id: "m3", content: "kept", author: { id: "u1", username: "alice" } },
    ]);
    await createDiscordSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    const rows = fixture.db
      .query<{ external_id: string }, []>(
        "SELECT external_id FROM item WHERE service = 'discord' ORDER BY external_id",
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].external_id).toBe("c1:m3");
  });

  test("non-record entry in messages array is skipped", async () => {
    fixture.fetchMock.respond("GET", GUILDS_URL, [{ id: "g1" }]);
    fixture.fetchMock.respond("GET", CHANNELS_RE, [{ id: "c1", type: 0 }]);
    fixture.fetchMock.respond("GET", MESSAGES_RE, [
      "string-entry",
      null,
      42,
      { id: "m4", content: "kept", author: { id: "u1", username: "alice" } },
    ]);
    await createDiscordSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    const rows = fixture.db
      .query<{ external_id: string }, []>("SELECT external_id FROM item WHERE service = 'discord'")
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].external_id).toBe("c1:m4");
  });

  test("non-text-channel types are filtered at channel-list parse", async () => {
    // Only types 0 (GUILD_TEXT) and 5 (GUILD_NEWS) are indexed.
    fixture.fetchMock.respond("GET", GUILDS_URL, [{ id: "g1" }]);
    fixture.fetchMock.respond("GET", CHANNELS_RE, [
      { id: "c1", type: 0 }, // text
      { id: "c2", type: 2 }, // voice → skipped
      { id: "c3", type: 5 }, // news → kept
    ]);
    fixture.fetchMock.respond("GET", MESSAGES_RE, []);
    await createDiscordSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    // Two channels visited (c1, c3); the voice channel was filtered before the
    // message-fetch loop ever saw it.
    const msgCalls = fixture.fetchMock.calls.filter((c) => MESSAGES_RE.test(c.url));
    expect(msgCalls).toHaveLength(2);
    expect(msgCalls.some((c) => c.url.includes("/channels/c2/"))).toBe(false);
  });
});

describe("discord-sync — phase machine transitions", () => {
  test("fresh start: fetches guilds → channels → messages → completes single-guild single-channel cycle", async () => {
    fixture.fetchMock.respond("GET", GUILDS_URL, [{ id: "g1" }]);
    fixture.fetchMock.respond("GET", CHANNELS_RE, [{ id: "c1", type: 0 }]);
    // The state machine fetches messages until an empty page comes back; only
    // then does it advance channelIndex. To make this single-call deterministic
    // we stage the `after=` follow-up as empty so the cycle terminates after
    // exactly one non-empty page + one empty follow-up. The empty-follow-up
    // matcher must be registered FIRST because MockFetch matches in
    // registration order — a more specific matcher wins by virtue of being
    // listed before the catch-all.
    const MESSAGES_AFTER_RE =
      /^https:\/\/discord\.com\/api\/v10\/channels\/[^/]+\/messages\?limit=50&after=/;
    fixture.fetchMock.respond("GET", MESSAGES_AFTER_RE, []);
    fixture.fetchMock.respond("GET", MESSAGES_RE, [
      { id: "m1", content: "hi", author: { id: "u1", username: "alice", global_name: "Alice" } },
    ]);
    const res = await createDiscordSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    // One unique message indexed; cycle completes.
    expect(res.itemsUpserted).toBe(1);
    expect(res.hasMore).toBe(false);
    expect(res.cursor.startsWith(CURSOR_PREFIX)).toBe(true);
    const rows = fixture.db
      .query<{ external_id: string }, []>("SELECT external_id FROM item WHERE service = 'discord'")
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].external_id).toBe("c1:m1");
  });

  test("channel advance: after a channel returns empty, next channel is visited", async () => {
    fixture.fetchMock.respond("GET", GUILDS_URL, [{ id: "g1" }]);
    fixture.fetchMock.respond("GET", CHANNELS_RE, [
      { id: "c1", type: 0 },
      { id: "c2", type: 0 },
    ]);
    fixture.fetchMock.respond("GET", MESSAGES_RE, []);
    const res = await createDiscordSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.hasMore).toBe(false);
    const msgCalls = fixture.fetchMock.calls.filter((c) => MESSAGES_RE.test(c.url));
    // Both channels visited exactly once each (empty page → channelIndex+1).
    expect(msgCalls).toHaveLength(2);
    expect(msgCalls.some((c) => c.url.includes("/channels/c1/"))).toBe(true);
    expect(msgCalls.some((c) => c.url.includes("/channels/c2/"))).toBe(true);
  });

  test("guild advance: empty channel list moves to next guild", async () => {
    fixture.fetchMock.respond("GET", GUILDS_URL, [{ id: "g1" }, { id: "g2" }]);
    // Both guilds return empty channel lists.
    fixture.fetchMock.respond("GET", CHANNELS_RE, []);
    const res = await createDiscordSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.hasMore).toBe(false);
    const chCalls = fixture.fetchMock.calls.filter((c) => CHANNELS_RE.test(c.url));
    expect(chCalls).toHaveLength(2);
    expect(chCalls.some((c) => c.url.includes("/guilds/g1/"))).toBe(true);
    expect(chCalls.some((c) => c.url.includes("/guilds/g2/"))).toBe(true);
  });

  test("API-call budget exhausted mid-cycle → hasMore=true with state preserved", async () => {
    // MAX_API_CALLS_PER_SYNC is 8. Stage enough work that a single sync() can't
    // finish: one guilds-list call + many guild/channel fetches.
    // Strategy: 1 guild with 8 channels, each channel returns empty messages.
    // Sequence per loop tick:
    //   tick 1: GUILDS_URL          (1 api call → guildIds=[g1])
    //   tick 2: CHANNELS_RE for g1   (1 api call → channelIds=[c1..c8])
    //   ticks 3..N: MESSAGES_RE for c1, c2, ...
    // With the budget of 8 we have 6 messages calls before the while loop exits.
    // Expectation: hasMore=true with channelIndex preserved at 6.
    fixture.fetchMock.respond("GET", GUILDS_URL, [{ id: "g1" }]);
    fixture.fetchMock.respond("GET", CHANNELS_RE, [
      { id: "c1", type: 0 },
      { id: "c2", type: 0 },
      { id: "c3", type: 0 },
      { id: "c4", type: 0 },
      { id: "c5", type: 0 },
      { id: "c6", type: 0 },
      { id: "c7", type: 0 },
      { id: "c8", type: 0 },
    ]);
    fixture.fetchMock.respond("GET", MESSAGES_RE, []);
    const res = await createDiscordSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.hasMore).toBe(true);
    const decoded = decodeCursor<{
      guildIds: string[];
      guildIndex: number;
      channelIds: string[];
      channelIndex: number;
    }>(res.cursor);
    expect(decoded.guildIds).toEqual(["g1"]);
    expect(decoded.guildIndex).toBe(0);
    expect(decoded.channelIds.length).toBe(8);
    // After the budget exhausts at the 8th API call (1 guilds + 1 channels + 6 messages),
    // channelIndex sits at 6 — the next call would have advanced to c7.
    expect(decoded.channelIndex).toBe(6);
    // Total fetches in this sync == MAX_API_CALLS_PER_SYNC (8).
    expect(fixture.fetchMock.calls).toHaveLength(8);
  });
});

describe("discord-sync — cycle-completion and integration", () => {
  test("indexed message persists with expected fields (author_id, url, metadata)", async () => {
    fixture.fetchMock.respond("GET", GUILDS_URL, [{ id: "g1" }]);
    fixture.fetchMock.respond("GET", CHANNELS_RE, [{ id: "c1", type: 0 }]);
    // Stage the `after=` follow-up as empty so the cycle terminates after
    // exactly one upsert of m100.
    const MESSAGES_AFTER_RE =
      /^https:\/\/discord\.com\/api\/v10\/channels\/[^/]+\/messages\?limit=50&after=/;
    fixture.fetchMock.respond("GET", MESSAGES_AFTER_RE, []);
    fixture.fetchMock.respond("GET", MESSAGES_RE, [
      {
        id: "m100",
        content: "hello world",
        author: { id: "u9001", username: "pat", global_name: "Pat" },
      },
    ]);
    const res = await createDiscordSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.itemsUpserted).toBe(1);
    const row = fixture.db
      .query<{ external_id: string; url: string; author_id: string | null; title: string }, []>(
        "SELECT external_id, url, author_id, title FROM item WHERE service = 'discord' AND external_id = 'c1:m100'",
      )
      .get();
    expect(row).not.toBeNull();
    expect(row?.external_id).toBe("c1:m100");
    expect(row?.url).toBe("https://discord.com/channels/g1/c1/m100");
    // Author resolved → row.author_id non-null.
    expect(row?.author_id).not.toBeNull();
  });

  test("notifications log records nothing — discord-sync emits no notifications", async () => {
    fixture.fetchMock.respond("GET", GUILDS_URL, []);
    await createDiscordSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(fixture.notifications.emitted).toHaveLength(0);
  });
});
