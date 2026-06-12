import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { TribalClusterStore } from "./cluster-store.ts";
import { detectRepeat, type RepeatDetectorDeps } from "./repeat-detector.ts";

function freshDb(): Database {
  const d = new Database(":memory:");
  runIndexedSchemaMigrations(d, 39);
  return d;
}

function deps(over: Partial<RepeatDetectorDeps>): RepeatDetectorDeps {
  return {
    embed: async () => new Float32Array([1, 0, 0]),
    recall: () => [],
    store: new TribalClusterStore(freshDb()),
    watchChannels: new Set(["C1"]),
    minOccurrences: 2,
    windowDays: 14,
    matchMode: "embedding",
    similarityThreshold: 0.85,
    now: () => 1000,
    ...over,
  };
}

test("a message outside watch_channels never clusters", async () => {
  const d = deps({});
  const r = await detectRepeat(d, {
    text: "how to deploy?",
    channelId: "C_PRIVATE",
    platform: "slack",
  });
  expect(r.fired).toBe(false);
  expect(r.reason).toBe("channel_not_watched");
});

test("first occurrence does not fire; threshold fires", async () => {
  const store = new TribalClusterStore(freshDb());
  const base = deps({ store, minOccurrences: 2 });
  const a = await detectRepeat(base, {
    text: "how to deploy the gateway?",
    channelId: "C1",
    platform: "slack",
  });
  expect(a.fired).toBe(false);
  const b = await detectRepeat(
    { ...base, now: () => 2000 },
    { text: "how to deploy the gateway?", channelId: "C1", platform: "slack" },
  );
  expect(b.fired).toBe(true);
  expect(b.cluster?.occurrenceCount).toBe(2);
});

test("recall to an existing cluster's channel reuses its cluster_id (near-dup merge)", async () => {
  const store = new TribalClusterStore(freshDb());
  const base = deps({
    store,
    minOccurrences: 2,
    recall: () => [{ clusterId: "k-existing", channelId: "C1", distance: 0.05 }],
  });
  store.upsertOccurrence({
    clusterId: "k-existing",
    question: "how do I deploy?",
    vec: null,
    channelId: "C1",
    platform: "slack",
    now: 500,
  });
  const r = await detectRepeat(base, {
    text: "how do I deploy the service?",
    channelId: "C1",
    platform: "slack",
  });
  expect(r.fired).toBe(true);
  expect(r.cluster?.clusterId).toBe("k-existing");
});

test("recall hits in non-watched channels are ignored (new cluster derived)", async () => {
  const store = new TribalClusterStore(freshDb());
  const base = deps({
    store,
    minOccurrences: 1,
    recall: () => [{ clusterId: "k-other", channelId: "C_OTHER", distance: 0.01 }],
  });
  const r = await detectRepeat(base, {
    text: "how do I deploy the gateway today?",
    channelId: "C1",
    platform: "slack",
  });
  expect(r.cluster?.clusterId).not.toBe("k-other");
});

test("embed returning null does not fire", async () => {
  const r = await detectRepeat(deps({ embed: async () => null }), {
    text: "how do I deploy?",
    channelId: "C1",
    platform: "slack",
  });
  expect(r.fired).toBe(false);
});

test("embedding+llm mode: llmJudge rejecting keeps questions in separate clusters", async () => {
  const store = new TribalClusterStore(freshDb());
  store.upsertOccurrence({
    clusterId: "k-existing",
    question: "how do I deploy?",
    vec: null,
    channelId: "C1",
    platform: "slack",
    now: 500,
  });
  const base = deps({
    store,
    minOccurrences: 1,
    matchMode: "embedding+llm",
    llmJudge: async () => false,
    recall: () => [{ clusterId: "k-existing", channelId: "C1", distance: 0.05 }],
  });
  const r = await detectRepeat(base, {
    text: "what is the vault entropy file?",
    channelId: "C1",
    platform: "slack",
  });
  expect(r.cluster?.clusterId).not.toBe("k-existing");
});
