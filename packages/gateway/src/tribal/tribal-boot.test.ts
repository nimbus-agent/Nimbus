import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { ReplyTarget } from "../chatops/types.ts";
import type { NimbusTribalToml } from "../config/nimbus-toml.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { buildTribalBoot, type TribalBootDeps } from "./tribal-boot.ts";

function freshDb(): Database {
  const d = new Database(":memory:");
  runIndexedSchemaMigrations(d, 39);
  return d;
}

const baseCfg: NimbusTribalToml = {
  enabled: true,
  match: "embedding",
  minOccurrences: 2,
  windowDays: 14,
  cooldownDays: 30,
  watchChannels: ["C1"],
};

function deps(over: Partial<TribalBootDeps> = {}): TribalBootDeps {
  return {
    db: freshDb(),
    cfg: baseCfg,
    embedQuery: async () => new Float32Array([1, 0, 0]),
    botUserIds: new Set(["BOT"]),
    send: async () => {},
    now: () => 1000,
    ...over,
  };
}

test("enabled with empty watch_channels throws (fail-closed)", () => {
  expect(() => buildTribalBoot(deps({ cfg: { ...baseCfg, watchChannels: [] } }))).toThrow(
    /watch_channels/,
  );
});

test("rpcCtx.status reflects enabled + cluster count", () => {
  const boot = buildTribalBoot(deps());
  expect(boot.rpcCtx.status()).toEqual({ enabled: true, clusters: 0 });
});

test("onInboundMessage forwards to the watcher → repeated question posts a suggestion", async () => {
  const sent: { target: ReplyTarget; text: string }[] = [];
  const boot = buildTribalBoot(
    deps({ send: async (target, text) => void sent.push({ target, text }) }),
  );
  const msg = (ts: string) => ({
    platform: "slack" as const,
    channelId: "C1",
    userId: "U",
    text: "how do I deploy the gateway?",
    ts,
    addressedToBot: false,
  });
  await boot.onInboundMessage(msg("1"));
  expect(sent).toHaveLength(0);
  await boot.onInboundMessage(msg("2"));
  expect(sent).toHaveLength(1);
  expect(boot.rpcCtx.status().clusters).toBe(1);
});

test("stop() halts ingestion; start() resumes", async () => {
  let embeds = 0;
  const boot = buildTribalBoot(
    deps({
      embedQuery: async () => {
        embeds++;
        return new Float32Array([1, 0, 0]);
      },
    }),
  );
  await boot.rpcCtx.stop();
  await boot.onInboundMessage({
    platform: "slack",
    channelId: "C1",
    userId: "U",
    text: "how do I deploy the gateway?",
    ts: "1",
    addressedToBot: false,
  });
  expect(embeds).toBe(0);
  expect(boot.rpcCtx.status().enabled).toBe(false);
  await boot.rpcCtx.start();
  await boot.onInboundMessage({
    platform: "slack",
    channelId: "C1",
    userId: "U",
    text: "how do I deploy the gateway?",
    ts: "2",
    addressedToBot: false,
  });
  expect(embeds).toBe(1);
});

test("list rejects an unknown status", () => {
  const boot = buildTribalBoot(deps());
  expect(() => boot.rpcCtx.list("bogus")).toThrow(/unknown status/);
});

test("dismiss puts a cluster into cooldown so it stops re-suggesting", async () => {
  const db = freshDb();
  const sent: string[] = [];
  const boot = buildTribalBoot(
    deps({ db, send: async (_t, text) => void sent.push(text), now: () => 1000 }),
  );
  const msg = (ts: string) => ({
    platform: "slack" as const,
    channelId: "C1",
    userId: "U",
    text: "how do I deploy the gateway?",
    ts,
    addressedToBot: false,
  });
  await boot.onInboundMessage(msg("1"));
  await boot.onInboundMessage(msg("2"));
  expect(sent).toHaveLength(1);
  const id = (boot.rpcCtx.list("suggested") as { clusterId: string }[])[0]?.clusterId;
  expect(id).toBeDefined();
  await boot.rpcCtx.dismiss(id as string);
  // a further occurrence during cooldown must not re-suggest
  await boot.onInboundMessage(msg("3"));
  expect(sent).toHaveLength(1);
});

test("scan re-fires suggestions for qualifying pending clusters", async () => {
  // Seed a cluster directly at threshold but still pending (suggestion never posted).
  const db = freshDb();
  const sent: string[] = [];
  const boot = buildTribalBoot(
    deps({ db, send: async (_t, text) => void sent.push(text), now: () => 5000 }),
  );
  db.run(
    `INSERT INTO tribal_clusters (cluster_id, representative_question, occurrence_count, first_seen, last_seen, status, channel_id, platform)
     VALUES ('k1', 'how do I deploy?', 3, 1000, 2000, 'pending', 'C1', 'slack')`,
  );
  const r = await boot.rpcCtx.scan();
  expect(r).toEqual({ scanned: 1, fired: 1 });
  expect(sent).toHaveLength(1);
});
