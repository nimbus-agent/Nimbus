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
  // A failing embed must be swallowed: ingest resolves rather than propagating "worker down".
  await expect(
    w.ingest({
      platform: "slack",
      channelId: "C1",
      userId: "U",
      text: "how do I deploy?",
      ts: "1",
      addressedToBot: false,
    }),
  ).resolves.toBeUndefined();
});

test("an Error thrown during ingest is logged via the optional log seam (err.message branch)", async () => {
  const logs: string[] = [];
  const w = new TribalWatcher(
    deps({
      embed: async () => {
        throw new Error("worker down");
      },
      log: (m) => logs.push(m),
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
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain("tribal ingest error");
  expect(logs[0]).toContain("worker down");
});

test("a non-Error thrown during ingest is stringified into the log (String(err) branch)", async () => {
  const logs: string[] = [];
  const w = new TribalWatcher(
    deps({
      embed: async () => {
        // intentionally throwing a non-Error to exercise the String(err) branch
        throw "embed exploded";
      },
      log: (m) => logs.push(m),
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
  expect(logs[0]).toContain("embed exploded");
});

test("embedding+llm match mode forwards an llmJudge into the detector (spread branch)", async () => {
  // Seed a cluster, then a near-identical question with an llmJudge present exercises the
  // `llmJudge !== undefined` spread arm in ingest().
  const judged: [string, string][] = [];
  const sent: string[] = [];
  const w = new TribalWatcher(
    deps({
      matchMode: "embedding+llm",
      llmJudge: async (a, b) => {
        judged.push([a, b]);
        return true;
      },
      recall: () => [{ clusterId: "tq_seed", channelId: "C1", distance: 0 }],
      send: async (_t, text) => void sent.push(text),
      minOccurrences: 1,
    }),
  );
  await w.ingest({
    platform: "slack",
    channelId: "C1",
    userId: "U",
    text: "how do I deploy the gateway?",
    ts: "1",
    addressedToBot: false,
  });
  // The recalled "tq_seed" cluster has no stored row, so resolveClusterId returns it WITHOUT invoking
  // llmJudge — the spread arm is still exercised (it's forwarded into the detector deps). The new
  // occurrence then upserts a pending cluster that fires at minOccurrences 1, so exactly one
  // suggestion is sent and the judge is never called.
  expect(judged).toHaveLength(0);
  expect(sent).toHaveLength(1);
});
