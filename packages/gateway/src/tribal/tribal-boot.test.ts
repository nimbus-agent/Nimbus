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

const okSubmit = async () => ({ status: "approved" as const, result: { pageRef: "notion:p" } });

test("capture is unavailable when synthesize is not wired", async () => {
  const boot = buildTribalBoot(deps());
  expect(await boot.rpcCtx.capture("k1", undefined, okSubmit)).toEqual({
    ok: false,
    error: "capture_unavailable",
  });
});

test("capture on a missing cluster → not_found", async () => {
  const boot = buildTribalBoot(
    deps({ synthesize: async () => ({ title: "T", bodyMarkdown: "B", citations: [] }) }),
  );
  expect(await boot.rpcCtx.capture("nope", undefined, okSubmit)).toEqual({
    ok: false,
    error: "not_found",
  });
});

test("capture wires the write-gate: synthesize → owner HITL → markCaptured", async () => {
  const db = freshDb();
  db.run(
    `INSERT INTO tribal_clusters (cluster_id, representative_question, occurrence_count, first_seen, last_seen, status, channel_id, platform)
     VALUES ('k1', 'how do I deploy?', 3, 1000, 2000, 'suggested', 'C1', 'slack')`,
  );
  const submitted: { type: string; payload: Record<string, unknown> }[] = [];
  const boot = buildTribalBoot(
    deps({
      db,
      cfg: { ...baseCfg, notion: { databaseId: "db_cfg" } },
      synthesize: async () => ({ title: "Deploying", bodyMarkdown: "Run deploy", citations: [] }),
    }),
  );
  const r = await boot.rpcCtx.capture("k1", "notion", async (action) => {
    submitted.push(action);
    return { status: "approved", result: { pageRef: "notion:pg1" } };
  });
  expect(r).toEqual({ ok: true, pageRef: "notion:pg1" });
  expect(submitted[0]?.type).toBe("notion.knowledge.write");
  expect(submitted[0]?.payload["databaseId"]).toBe("db_cfg");
  const row = boot.rpcCtx.list("captured") as { clusterId: string }[];
  expect(row.map((c) => c.clusterId)).toEqual(["k1"]);
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

// A 384-ish-dim helper to drive the internal cosineDistance via the recall closure.
function vec(values: number[]): Float32Array {
  return new Float32Array(values);
}

test("defaults now() to Date.now and accepts a log seam when omitted/provided", async () => {
  // No `now` injected → exercises the `deps.now ?? (() => Date.now())` fallback arm.
  // A `log` provided → exercises the `deps.log !== undefined ? { log } : {}` spread arm.
  const logs: string[] = [];
  const boot = buildTribalBoot({
    db: freshDb(),
    cfg: baseCfg,
    embedQuery: async () => vec([1, 0, 0]),
    botUserIds: new Set(["BOT"]),
    send: async () => {},
    log: (m) => logs.push(m),
  });
  expect(boot.rpcCtx.status()).toEqual({ enabled: true, clusters: 0 });
});

test("list with an empty-string status returns all clusters (=== '' arm)", () => {
  const boot = buildTribalBoot(deps());
  expect(boot.rpcCtx.list("")).toEqual([]);
});

test("the recall closure filters clusters by watched channel and cosine-distances stored vecs", async () => {
  // Seed two vec-bearing clusters: one in a watched channel, one outside it. The recall closure
  // (inside buildTribalBoot) must drop the unwatched one and cosine-distance the watched one — this
  // also drives cosineDistance with a same-length non-zero vector.
  const db = freshDb();
  const sent: string[] = [];
  const v = new Float32Array([1, 0, 0]);
  const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  for (const [id, ch] of [
    ["watched", "C1"],
    ["unwatched", "C_OTHER"],
  ] as const) {
    const stmt = db.prepare(
      `INSERT INTO tribal_clusters (cluster_id, representative_question, representative_vec, occurrence_count, first_seen, last_seen, status, channel_id, platform)
       VALUES (?, ?, ?, 1, 1000, 1000, 'pending', ?, 'slack')`,
    );
    stmt.run(id, `q ${id}`, bytes, ch);
  }
  const boot = buildTribalBoot(
    deps({
      db,
      cfg: { ...baseCfg, minOccurrences: 1 },
      embedQuery: async () => vec([1, 0, 0]),
      send: async (_t, text) => void sent.push(text),
    }),
  );
  // Drives ingest → detectRepeat → recall(vec) → cosineDistance over the watched cluster only.
  await boot.onInboundMessage({
    platform: "slack",
    channelId: "C1",
    userId: "U",
    text: "how do I deploy the gateway?",
    ts: "1",
    addressedToBot: false,
  });
  expect(sent.length).toBeGreaterThanOrEqual(1);
});

test("cosineDistance fallbacks: mismatched-length and zero-norm vectors both read as distance 1", async () => {
  // Seed a cluster whose stored vec is a DIFFERENT length than the query vec (→ a.length !== b.length
  // arm) and another whose vec is all-zeros (→ na === 0 || nb === 0 arm). Recall still returns them,
  // so a brand-new distinct question spawns its own cluster rather than merging.
  const db = freshDb();
  const mism = new Float32Array([1, 0]); // length 2 vs query length 3
  const zero = new Float32Array([0, 0, 0]); // zero-norm
  for (const [id, fv] of [
    ["mism", mism],
    ["zero", zero],
  ] as const) {
    const bytes = new Uint8Array(fv.buffer, fv.byteOffset, fv.byteLength);
    const stmt = db.prepare(
      `INSERT INTO tribal_clusters (cluster_id, representative_question, representative_vec, occurrence_count, first_seen, last_seen, status, channel_id, platform)
       VALUES (?, ?, ?, 1, 1000, 1000, 'pending', 'C1', 'slack')`,
    );
    stmt.run(id, `q ${id}`, bytes);
  }
  const boot = buildTribalBoot(deps({ db, embedQuery: async () => vec([1, 0, 0]) }));
  await boot.onInboundMessage({
    platform: "slack",
    channelId: "C1",
    userId: "U",
    text: "what is the on-call rotation policy?",
    ts: "1",
    addressedToBot: false,
  });
  // The mismatched/zero-norm clusters are too distant to merge → a third cluster now exists.
  expect(boot.rpcCtx.status().clusters).toBe(3);
});

test("scan skips a below-threshold pending cluster (the && occurrence/window guard)", async () => {
  const db = freshDb();
  const sent: string[] = [];
  const boot = buildTribalBoot(
    deps({
      db,
      cfg: { ...baseCfg, minOccurrences: 5 },
      send: async (_t, text) => void sent.push(text),
      now: () => 5000,
    }),
  );
  // occurrence_count 2 < minOccurrences 5 → does not qualify, fired stays 0.
  db.run(
    `INSERT INTO tribal_clusters (cluster_id, representative_question, occurrence_count, first_seen, last_seen, status, channel_id, platform)
     VALUES ('low', 'q?', 2, 1000, 2000, 'pending', 'C1', 'slack')`,
  );
  const r = await boot.rpcCtx.scan();
  expect(r).toEqual({ scanned: 1, fired: 0 });
  expect(sent).toHaveLength(0);
});

test("scan logs and continues when a suggestion post throws (catch arm)", async () => {
  const db = freshDb();
  const logs: string[] = [];
  const boot = buildTribalBoot(
    deps({
      db,
      send: async () => {
        throw new Error("post blew up");
      },
      log: (m) => logs.push(m),
      now: () => 5000,
    }),
  );
  db.run(
    `INSERT INTO tribal_clusters (cluster_id, representative_question, occurrence_count, first_seen, last_seen, status, channel_id, platform)
     VALUES ('k1', 'q?', 3, 1000, 2000, 'pending', 'C1', 'slack')`,
  );
  const r = await boot.rpcCtx.scan();
  expect(r).toEqual({ scanned: 1, fired: 0 });
  expect(logs.some((l) => l.includes("scan suggestion error"))).toBe(true);
  expect(logs.some((l) => l.includes("post blew up"))).toBe(true);
});

function seedCluster(db: Database, id = "k1"): void {
  db.run(
    `INSERT INTO tribal_clusters (cluster_id, representative_question, occurrence_count, first_seen, last_seen, status, channel_id, platform)
     VALUES ('${id}', 'how do I deploy?', 3, 1000, 2000, 'suggested', 'C1', 'slack')`,
  );
}

test("capture with a single configured KB ignores an out-of-range target selector", async () => {
  // target "jira" is neither "notion" nor "confluence" → normalized to undefined; with only notion
  // configured the write-gate uses notion. Exercises the `target === notion || target === confluence`
  // resolution arm plus the notion-only cfg spread.
  const db = freshDb();
  seedCluster(db);
  const boot = buildTribalBoot(
    deps({
      db,
      cfg: { ...baseCfg, notion: { databaseId: "db_cfg" } },
      synthesize: async () => ({ title: "T", bodyMarkdown: "B", citations: [] }),
    }),
  );
  const r = await boot.rpcCtx.capture("k1", "jira", okSubmit);
  expect(r).toEqual({ ok: true, pageRef: "notion:p" });
});

test("capture against a confluence-only config spreads the confluence destination", async () => {
  const db = freshDb();
  seedCluster(db);
  const submitted: { type: string }[] = [];
  const boot = buildTribalBoot(
    deps({
      db,
      cfg: { ...baseCfg, confluence: { spaceKey: "ENG", parentPageId: "9" } },
      synthesize: async () => ({ title: "T", bodyMarkdown: "B", citations: [] }),
    }),
  );
  const r = await boot.rpcCtx.capture("k1", "confluence", async (action) => {
    submitted.push(action);
    return { status: "approved", result: { pageRef: "conf:1" } };
  });
  expect(r).toEqual({ ok: true, pageRef: "conf:1" });
  expect(submitted[0]?.type).toBe("confluence.knowledge.write");
});

test("capture surfaces a write-gate failure (HITL rejected → r.ok false passthrough)", async () => {
  const db = freshDb();
  seedCluster(db);
  const boot = buildTribalBoot(
    deps({
      db,
      cfg: { ...baseCfg, notion: { databaseId: "db_cfg" } },
      synthesize: async () => ({ title: "T", bodyMarkdown: "B", citations: [] }),
    }),
  );
  const r = await boot.rpcCtx.capture("k1", "notion", async () => ({ status: "rejected" }));
  expect(r).toEqual({ ok: false, error: "rejected" });
});
