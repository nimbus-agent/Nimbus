import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
  computeLatencyPercentilesMs,
  flushLatencyBuffer,
  type LatencyRingBuffer,
  LatencyRingBuffer as LatencyRingBufferClass,
  readLatencyPercentilesFromDb,
  recordSlowQuery,
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

describe("recordSlowQuery", () => {
  test("below threshold — no row inserted (line 164 true branch)", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    recordSlowQuery(db, {
      queryText: "SELECT 1",
      latencyMs: 100,
      queryType: "sql",
      recordedAt: Date.now(),
      thresholdMs: 500,
    });
    const row = db.query("SELECT COUNT(*) AS c FROM slow_query_log").get() as { c: number };
    expect(row.c).toBe(0);
    db.close();
  });

  test("at/above threshold with table present — row inserted (line 164 false branch)", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const now = Date.now();
    recordSlowQuery(db, {
      queryText: "SELECT heavy",
      latencyMs: 800,
      queryType: "fts",
      recordedAt: now,
      thresholdMs: 500,
    });
    const row = db
      .query("SELECT query_text, latency_ms, query_type, recorded_at FROM slow_query_log LIMIT 1")
      .get() as {
      query_text: string;
      latency_ms: number;
      query_type: string;
      recorded_at: number;
    } | null;
    expect(row).not.toBeNull();
    expect(row?.query_text).toBe("SELECT heavy");
    expect(row?.latency_ms).toBe(800);
    expect(row?.query_type).toBe("fts");
    expect(row?.recorded_at).toBe(now);
    db.close();
  });

  test("above threshold but slow_query_log table absent — returns without throwing (line 167 true branch)", () => {
    // bare db: no ensureSchema, so slow_query_log does not exist
    const db = new Database(":memory:");
    expect(() => {
      recordSlowQuery(db, {
        queryText: "SELECT heavy",
        latencyMs: 800,
        queryType: "vector",
        recordedAt: Date.now(),
        thresholdMs: 500,
      });
    }).not.toThrow();
    // confirm slow_query_log truly absent on a bare db
    const exists = db
      .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='slow_query_log'")
      .get();
    expect(exists).toBeNull();
    db.close();
  });
});

describe("readLatencyPercentilesFromDb", () => {
  test("query_latency_log table absent — returns zeros (line 182 true branch)", () => {
    const db = new Database(":memory:");
    const result = readLatencyPercentilesFromDb(db);
    expect(result).toEqual({ p50Ms: 0, p95Ms: 0, p99Ms: 0 });
    db.close();
  });

  test("table present with recent rows — returns ordered non-zero percentiles (line 182 false branch)", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const now = Date.now();
    // Insert 10 rows with distinct latencies so all three percentiles are non-zero
    for (let i = 1; i <= 10; i += 1) {
      db.run(
        "INSERT INTO query_latency_log (latency_ms, query_type, recorded_at) VALUES (?, ?, ?)",
        [i * 50, "sql", now],
      );
    }
    const result = readLatencyPercentilesFromDb(db);
    expect(result.p50Ms).toBeGreaterThan(0);
    expect(result.p95Ms).toBeGreaterThanOrEqual(result.p50Ms);
    expect(result.p99Ms).toBeGreaterThanOrEqual(result.p95Ms);
    db.close();
  });
});

describe("flushLatencyBuffer — table-absent guard", () => {
  test("query_latency_log absent — drains buffer without throwing (line 120 true branch)", () => {
    // bare db: no ensureSchema, so query_latency_log does not exist
    const db = new Database(":memory:");
    const buf: LatencyRingBuffer = new LatencyRingBufferClass();
    buf.push(
      { latencyMs: 10, queryType: "sql", recordedAt: Date.now() },
      { latencyMs: 20, queryType: "fts", recordedAt: Date.now() },
    );
    expect(() => {
      flushLatencyBuffer(db, buf);
    }).not.toThrow();
    // buffer must be drained even when the table is absent
    expect(buf.snapshotOrdered()).toHaveLength(0);
    db.close();
  });
});
