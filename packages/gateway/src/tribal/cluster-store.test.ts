import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { TribalClusterStore } from "./cluster-store.ts";

function db(): Database {
  const d = new Database(":memory:");
  runIndexedSchemaMigrations(d, 39);
  return d;
}

test("insert + bump occurrence; fires at threshold", () => {
  const s = new TribalClusterStore(db());
  const c = s.upsertOccurrence({
    clusterId: "k1",
    question: "how to deploy?",
    vec: null,
    channelId: "C1",
    platform: "slack",
    now: 1000,
  });
  expect(c.occurrenceCount).toBe(1);
  const c2 = s.upsertOccurrence({
    clusterId: "k1",
    question: "how to deploy?",
    vec: null,
    channelId: "C1",
    platform: "slack",
    now: 2000,
  });
  expect(c2.occurrenceCount).toBe(2);
});

test("dismiss enters cooldown; in-cooldown occurrences are ignored", () => {
  const s = new TribalClusterStore(db());
  s.upsertOccurrence({
    clusterId: "k1",
    question: "q",
    vec: null,
    channelId: "C1",
    platform: "slack",
    now: 1000,
  });
  s.markDismissed("k1", { now: 1000, cooldownUntil: 5000 });
  const c = s.upsertOccurrence({
    clusterId: "k1",
    question: "q",
    vec: null,
    channelId: "C1",
    platform: "slack",
    now: 2000,
  });
  expect(c.status).toBe("dismissed");
  expect(c.occurrenceCount).toBe(1); // unchanged during cooldown
});

test("after cooldown expiry, counting restarts fresh", () => {
  const s = new TribalClusterStore(db());
  s.upsertOccurrence({
    clusterId: "k1",
    question: "q",
    vec: null,
    channelId: "C1",
    platform: "slack",
    now: 1000,
  });
  s.markDismissed("k1", { now: 1000, cooldownUntil: 5000 });
  const c = s.upsertOccurrence({
    clusterId: "k1",
    question: "q",
    vec: null,
    channelId: "C1",
    platform: "slack",
    now: 6000,
  });
  expect(c.status).toBe("pending");
  expect(c.occurrenceCount).toBe(1);
});

test("listByStatus + markSuggested + markCaptured", () => {
  const s = new TribalClusterStore(db());
  s.upsertOccurrence({
    clusterId: "k1",
    question: "q",
    vec: null,
    channelId: "C1",
    platform: "slack",
    now: 1000,
  });
  s.markSuggested("k1", 1500);
  expect(s.listByStatus("suggested").map((c) => c.clusterId)).toEqual(["k1"]);
  s.markCaptured("k1", { now: 2000, pageRef: "notion:pg1", cooldownUntil: 9000 });
  expect(s.get("k1")?.capturedPageRef).toBe("notion:pg1");
});

test("a null-vec cluster backfills its representative vector on a later bump", () => {
  const s = new TribalClusterStore(db());
  s.upsertOccurrence({
    clusterId: "k1",
    question: "q",
    vec: null,
    channelId: "C1",
    platform: "slack",
    now: 1000,
  });
  expect(s.get("k1")?.representativeVec).toBeNull();
  s.upsertOccurrence({
    clusterId: "k1",
    question: "q",
    vec: new Float32Array([1, 2, 3]),
    channelId: "C1",
    platform: "slack",
    now: 2000,
  });
  expect(Array.from(s.get("k1")?.representativeVec ?? [])).toEqual([1, 2, 3]);
  // a subsequent non-null vec must NOT overwrite the now-present one (COALESCE keeps the first).
  s.upsertOccurrence({
    clusterId: "k1",
    question: "q",
    vec: new Float32Array([9, 9, 9]),
    channelId: "C1",
    platform: "slack",
    now: 3000,
  });
  expect(Array.from(s.get("k1")?.representativeVec ?? [])).toEqual([1, 2, 3]);
});

test("representativeVec round-trips through BLOB storage", () => {
  const s = new TribalClusterStore(db());
  const vec = new Float32Array([0.1, 0.2, 0.3]);
  s.upsertOccurrence({
    clusterId: "kv",
    question: "vector?",
    vec,
    channelId: "C1",
    platform: "slack",
    now: 1000,
  });
  const got = s.get("kv")?.representativeVec;
  expect(got).not.toBeNull();
  expect(Array.from(got ?? [])).toEqual([Math.fround(0.1), Math.fround(0.2), Math.fround(0.3)]);
});
