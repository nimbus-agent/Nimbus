import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { listFindings } from "./finding-store.ts";
import { readSyncTelemetrySeed, recordSyncScore } from "./sync-anomaly-findings.ts";

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
});
afterEach(() => db.close());

function tele(service: string, at: number, dur: number, up: number, err: string | null = null): void {
  db.run(
    "INSERT INTO sync_telemetry (service, started_at, duration_ms, items_upserted, error_msg) VALUES (?, ?, ?, ?, ?)",
    [service, at, dur, up, err],
  );
}

describe("readSyncTelemetrySeed", () => {
  test("newest N error-free rows per connector, oldest first, both series", () => {
    tele("github", 1, 10, 1);
    tele("github", 2, 20, 2);
    tele("github", 3, 30, 3);
    tele("github", 4, 99, 9, "boom");
    tele("slack", 5, 7, 0);
    const seed = readSyncTelemetrySeed(db, 2);
    expect(seed.get("sync:duration_ms:github")).toEqual([20, 30]);
    expect(seed.get("sync:items_upserted:github")).toEqual([2, 3]);
    expect(seed.get("sync:duration_ms:slack")).toEqual([7]);
    expect(seed.size).toBe(4);
  });
});

describe("recordSyncScore", () => {
  const ev = (score: number, samples: number, at = 10) => ({
    seriesId: "sync:duration_ms:github",
    value: 500,
    score,
    atMs: at,
    samples,
  });

  test("under 3 samples records nothing", () => {
    recordSyncScore(db, ev(9, 2), 3);
    expect(listFindings(db, { all: true, limit: 5 })).toHaveLength(0);
  });

  test("at or above the threshold opens; below clears", () => {
    recordSyncScore(db, ev(4.26, 10), 3);
    const open = listFindings(db, { all: false, limit: 5 });
    expect(open.map((f) => [f.kind, f.finding_key, f.service])).toEqual([
      ["anomaly", "sync:duration_ms:github", "github"],
    ]);
    expect(JSON.parse(open[0]?.detail_json ?? "")).toEqual({ value: 500, z: 4.3, samples: 10, atMs: 10 });
    recordSyncScore(db, ev(1, 11, 20), 3);
    expect(listFindings(db, { all: false, limit: 5 })).toHaveLength(0);
    expect(listFindings(db, { all: true, limit: 5 })[0]?.cleared_at_ms).toBe(20);
  });

  test("an infinite score is stored as a null z", () => {
    recordSyncScore(db, ev(Number.POSITIVE_INFINITY, 5), 3);
    expect(JSON.parse(listFindings(db, { all: false, limit: 5 })[0]?.detail_json ?? "").z).toBeNull();
  });
});
