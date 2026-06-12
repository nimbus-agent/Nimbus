import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { TribalWatcher, type TribalWatcherDeps } from "./tribal-watcher.ts";

function deps(over: Partial<TribalWatcherDeps>): TribalWatcherDeps {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 39);
  return {
    db,
    embed: async () => new Float32Array([1, 0, 0]),
    recall: () => [],
    send: async () => {},
    watchChannels: new Set(["C1"]),
    botUserIds: new Set(["BOT"]),
    minOccurrences: 2,
    windowDays: 14,
    matchMode: "embedding",
    now: () => 1000,
    ...over,
  };
}

test("the bot's own message is never ingested (no embed, no post)", async () => {
  let embeds = 0;
  const w = new TribalWatcher(
    deps({
      embed: async () => {
        embeds++;
        return new Float32Array([1]);
      },
    }),
  );
  await w.ingest({
    platform: "slack",
    channelId: "C1",
    userId: "BOT",
    text: "how do I deploy the gateway?",
    ts: "1",
    addressedToBot: false,
  });
  expect(embeds).toBe(0);
});

test("non-question is ignored (no embed, no post)", async () => {
  let embeds = 0;
  const sent: string[] = [];
  const w = new TribalWatcher(
    deps({
      embed: async () => {
        embeds++;
        return new Float32Array([1]);
      },
      send: async (_t, text) => void sent.push(text),
    }),
  );
  await w.ingest({
    platform: "slack",
    channelId: "C1",
    userId: "U",
    text: "lgtm 🚀",
    ts: "1",
    addressedToBot: false,
  });
  expect(embeds).toBe(0);
  expect(sent).toHaveLength(0);
});

test("message outside watch_channels is ignored (no embed)", async () => {
  let embeds = 0;
  const w = new TribalWatcher(
    deps({
      embed: async () => {
        embeds++;
        return new Float32Array([1]);
      },
    }),
  );
  await w.ingest({
    platform: "slack",
    channelId: "C_OTHER",
    userId: "U",
    text: "how do I deploy the gateway?",
    ts: "1",
    addressedToBot: false,
  });
  expect(embeds).toBe(0);
});

test("repeated question fires a suggestion exactly once at threshold", async () => {
  const sent: string[] = [];
  const w = new TribalWatcher(
    deps({ send: async (_t, text) => void sent.push(text), minOccurrences: 2, now: () => 1000 }),
  );
  await w.ingest({
    platform: "slack",
    channelId: "C1",
    userId: "U",
    text: "how do I deploy the gateway?",
    ts: "1",
    addressedToBot: false,
  });
  expect(sent).toHaveLength(0);
  await w.ingest({
    platform: "slack",
    channelId: "C1",
    userId: "U",
    text: "how do I deploy the gateway?",
    ts: "2",
    addressedToBot: false,
  });
  expect(sent).toHaveLength(1);
});

test("ingest never throws even if embed fails", async () => {
  const w = new TribalWatcher(
    deps({
      embed: async () => {
        throw new Error("worker down");
      },
    }),
  );
  await w.ingest({
    platform: "slack",
    channelId: "C1",
    userId: "U",
    text: "how do I deploy?",
    ts: "1",
    addressedToBot: false,
  });
  // no throw = pass
});
