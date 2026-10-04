/**
 * How long a guild-list 429 benches the Discord connector, and what a run reports when its call
 * budget runs out on the very listing that finishes the last guild. The other discord-sync tests
 * assert that the 429 throws; these pin the PENALTY it records first, including the fallback when
 * Discord sends a `retry_after` that is zero or negative.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { StubFetch } from "../../test/helpers/stub-fetch.ts";
import { type Provider, ProviderRateLimiter } from "../sync/rate-limiter.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";
import { createDiscordSyncable } from "./discord-sync.ts";
import { decodeNimbusJsonCursorPayload } from "./nimbus-json-cursor.ts";

const GUILDS_URL = "https://discord.com/api/v10/users/@me/guilds";
const CHANNELS_URL_RE = /^https:\/\/discord\.com\/api\/v10\/guilds\/[^/]+\/channels$/;

/** A real limiter that also records every penalty it is handed. */
class RecordingLimiter extends ProviderRateLimiter {
  readonly penalties: Array<[Provider, number]> = [];

  override penalise(provider: Provider, retryAfterMs: number): void {
    this.penalties.push([provider, retryAfterMs]);
    super.penalise(provider, retryAfterMs);
  }
}

let mock: StubFetch;

beforeEach(() => {
  mock = new StubFetch();
  mock.install();
});

afterEach(() => {
  mock.restore();
});

describe("guild-list 429 penalty", () => {
  test.each([
    ["a positive retry_after, rounded up to the millisecond", 2.5001, 2501],
    ["a zero retry_after, which falls back to a minute", 0, 60_000],
    ["a negative retry_after, which falls back to a minute", -3, 60_000],
  ])("%s", async (_label, retryAfter, expectedMs) => {
    mock.respond("GET", GUILDS_URL, { retry_after: retryAfter }, { status: 429 });
    const db = createMemoryIndexDb();
    const rateLimiter = new RecordingLimiter();
    const ctx = {
      ...syncTestContext(
        db,
        createStubVault({ "discord.enabled": "1", "discord.bot_token": "bot" }),
        "discord",
      ),
      rateLimiter,
    };

    await expect(
      createDiscordSyncable({ ensureDiscordMcpRunning: async () => {} }).sync(ctx, null),
    ).rejects.toThrow(/Discord guilds 429/);

    expect(rateLimiter.penalties).toEqual([["discord", expectedMs]]);
    db.close();
  });
});

describe("a call budget that runs out on the listing that finishes the last guild", () => {
  type CursorState = {
    guildIds: string[];
    guildIndex: number;
    channelIds: string[];
    channelIndex: number;
    lastMsgByChannel: Record<string, string>;
  };

  function cursorState(cursor: string | null): CursorState {
    return decodeNimbusJsonCursorPayload(cursor ?? "", "nimbus-dsc1:") as CursorState;
  }

  test("reports more work, and the next run closes the pass without another request", async () => {
    // Seven guilds whose only channel is a voice channel (type 2, not indexed): the guild list
    // plus seven channel listings is exactly the eight-call budget, and the last listing moves
    // the guild index past the final guild with no channel left to read.
    const guilds = Array.from({ length: 7 }, (_, i) => ({ id: `g${String(i + 1)}` }));
    mock.respond("GET", GUILDS_URL, guilds);
    mock.respond("GET", CHANNELS_URL_RE, [{ id: "voice-1", type: 2 }]);
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(
      db,
      createStubVault({ "discord.enabled": "1", "discord.bot_token": "bot" }),
      "discord",
    );
    const syncable = createDiscordSyncable({ ensureDiscordMcpRunning: async () => {} });

    const first = await syncable.sync(ctx, null);

    expect(mock.calls.map((c) => c.url)).toEqual([
      GUILDS_URL,
      ...guilds.map((g) => `https://discord.com/api/v10/guilds/${g.id}/channels`),
    ]);
    expect(first.itemsUpserted).toBe(0);
    expect(first.hasMore).toBe(true);
    expect(cursorState(first.cursor)).toEqual({
      guildIds: guilds.map((g) => g.id),
      guildIndex: 7,
      channelIds: [],
      channelIndex: 0,
      lastMsgByChannel: {},
    });

    const second = await syncable.sync(ctx, first.cursor);

    expect(mock.calls).toHaveLength(8);
    expect(second.hasMore).toBe(false);
    expect(cursorState(second.cursor)).toEqual({
      guildIds: [],
      guildIndex: 0,
      channelIds: [],
      channelIndex: 0,
      lastMsgByChannel: {},
    });
    db.close();
  });
});
