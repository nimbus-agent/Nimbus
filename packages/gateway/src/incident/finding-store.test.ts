import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import {
  clearFinding,
  listFindings,
  newestBucketMs,
  openFinding,
  openFindingKeys,
  pruneBaselineBuckets,
  pruneClearedFindings,
  readBaselineBuckets,
  writeBaselineBuckets,
} from "./finding-store.ts";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
});
afterEach(() => db.close());

const base = { kind: "radar" as const, key: "deploy:checkout", service: "checkout" };

describe("findings", () => {
  test("open is new once, then refreshes the same row", () => {
    expect(openFinding(db, { ...base, detail: { gapMs: 1 }, nowMs: 10 })).toBe(true);
    expect(openFinding(db, { ...base, detail: { gapMs: 2 }, nowMs: 20 })).toBe(false);
    const rows = listFindings(db, { all: true, limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.opened_at_ms).toBe(10);
    expect(rows[0]?.last_seen_at_ms).toBe(20);
    expect(JSON.parse(rows[0]?.detail_json ?? "")).toEqual({ gapMs: 2 });
  });

  test("clear closes the open row; a re-open is a new row", () => {
    openFinding(db, { ...base, detail: {}, nowMs: 10 });
    expect(clearFinding(db, "radar", base.key, 30)).toBe(true);
    expect(clearFinding(db, "radar", base.key, 31)).toBe(false);
    expect(openFindingKeys(db, "radar").size).toBe(0);
    expect(openFinding(db, { ...base, detail: {}, nowMs: 40 })).toBe(true);
    expect(listFindings(db, { all: false, limit: 10 })).toHaveLength(1);
    expect(listFindings(db, { all: true, limit: 10 })).toHaveLength(2);
  });

  test("the kind is part of the key", () => {
    openFinding(db, { ...base, detail: {}, nowMs: 1 });
    expect(openFinding(db, { ...base, kind: "anomaly", detail: {}, nowMs: 1 })).toBe(true);
    expect(openFindingKeys(db, "anomaly")).toEqual(new Set([base.key]));
  });

  test("an oversized detail is refused before any write", () => {
    expect(() => openFinding(db, { ...base, detail: { x: "y".repeat(5000) }, nowMs: 1 })).toThrow(
      "4 KiB",
    );
    expect(listFindings(db, { all: true, limit: 10 })).toHaveLength(0);
  });

  test("open rows list first; prune deletes only old cleared ones", () => {
    openFinding(db, { ...base, key: "a", detail: {}, nowMs: 1 });
    clearFinding(db, "radar", "a", 2);
    openFinding(db, { ...base, key: "b", detail: {}, nowMs: 3 });
    expect(listFindings(db, { all: true, limit: 10 }).map((r) => r.finding_key)).toEqual(["b", "a"]);
    expect(pruneClearedFindings(db, 2)).toBe(0);
    expect(pruneClearedFindings(db, 3)).toBe(1);
    expect(listFindings(db, { all: true, limit: 10 }).map((r) => r.finding_key)).toEqual(["b"]);
  });
});

describe("baseline buckets", () => {
  test("write, replace, read in range, newest by prefix, prune", () => {
    writeBaselineBuckets(db, [
      { seriesId: "index:errors:a", bucketStartMs: 0, value: 1 },
      { seriesId: "index:errors:a", bucketStartMs: 3_600_000, value: 2 },
      { seriesId: "index:alerts:a", bucketStartMs: 7_200_000, value: 0 },
    ]);
    writeBaselineBuckets(db, [{ seriesId: "index:errors:a", bucketStartMs: 0, value: 5 }]);
    expect(readBaselineBuckets(db, "index:errors:a", 0, 3_600_000)).toEqual([
      { bucketStartMs: 0, value: 5 },
      { bucketStartMs: 3_600_000, value: 2 },
    ]);
    expect(newestBucketMs(db, "index:")).toBe(7_200_000);
    expect(newestBucketMs(db, "sync:")).toBeNull();
    expect(pruneBaselineBuckets(db, 3_600_000)).toBe(1);
    writeBaselineBuckets(db, []);
    expect(readBaselineBuckets(db, "index:errors:a", 0, 10)).toEqual([]);
  });
});
