import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
  computeLatencyPercentilesMs,
  flushLatencyBuffer,
  type LatencyRingBuffer,
  LatencyRingBuffer as LatencyRingBufferClass,
} from "../../../src/db/latency-ring-buffer.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";

describe("LatencyRingBuffer", () => {
  test("retains only the last RING_SIZE samples when more are pushed", () => {
    const buf: LatencyRingBuffer = new LatencyRingBufferClass();
    for (let i = 0; i < 1500; i += 1) {
      buf.push({ latencyMs: i, queryType: "fts", recordedAt: i });
    }
    const snap = buf.snapshotOrdered();
    expect(snap.length).toBe(1440);
    expect(snap[0]?.recordedAt).toBe(60);
    expect(snap[1439]?.recordedAt).toBe(1499);
  });

  test("drain returns ordered samples and clears dirty flag", () => {
    const buf: LatencyRingBuffer = new LatencyRingBufferClass();
    buf.push(
      { latencyMs: 10, queryType: "sql", recordedAt: 1 },
      { latencyMs: 20, queryType: "hybrid", recordedAt: 2 },
    );
    expect(buf.isDirty()).toBe(true);
    const d = buf.drainOrdered();
    expect(d.map((s) => s.latencyMs)).toEqual([10, 20]);
    expect(buf.isDirty()).toBe(false);
    expect(buf.drainOrdered()).toHaveLength(0);
  });

  test("flushLatencyBuffer writes one multi-row INSERT per chunk and prunes", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const buf: LatencyRingBuffer = new LatencyRingBufferClass();
    let insertCount = 0;
    const origRun = db.run.bind(db);
    db.run = ((sql: string, params?: unknown) => {
      if (typeof sql === "string" && sql.includes("INSERT INTO query_latency_log")) {
        insertCount += 1;
      }
      return origRun(sql, params);
    }) as typeof db.run;

    for (let i = 0; i < 250; i += 1) {
      buf.push({ latencyMs: 1, queryType: "fts", recordedAt: Date.now() + i });
    }
    flushLatencyBuffer(db, buf);
    const row = db.query("SELECT COUNT(*) AS c FROM query_latency_log").get() as { c: number };
    expect(row.c).toBe(250);
    expect(insertCount).toBe(2);
    expect(buf.snapshotOrdered()).toHaveLength(0);
    db.close();
  });
});

describe("computeLatencyPercentilesMs", () => {
  test("computes p50 / p95 / p99", () => {
    const samples = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => ({
      latencyMs: i * 10,
      queryType: "fts" as const,
      recordedAt: 0,
    }));
    const p = computeLatencyPercentilesMs(samples);
    expect(p.p50Ms).toBeGreaterThan(0);
    expect(p.p95Ms).toBeGreaterThanOrEqual(p.p50Ms);
    expect(p.p99Ms).toBeGreaterThanOrEqual(p.p95Ms);
  });
});
