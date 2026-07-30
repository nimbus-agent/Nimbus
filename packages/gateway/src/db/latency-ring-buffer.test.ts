import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  computeLatencyPercentilesMs,
  DEFAULT_SLOW_QUERY_THRESHOLD_MS,
  flushLatencyBuffer,
  LatencyRingBuffer,
  latencyRingBuffer,
  readLatencyPercentilesFromDb,
  recordSlowQuery,
  startLatencyFlushScheduler,
} from "./latency-ring-buffer.ts";
import { dbRun } from "./write.ts";

// Fixed epoch used so all clock-dependent branches are deterministic.
const FIXED_NOW = 1_000_000_000;

function fixedClock(): number {
  return FIXED_NOW;
}

// ─── Schema helpers ──────────────────────────────────────────────────────────

function createLatencyTable(db: Database): void {
  db.exec(`
    CREATE TABLE query_latency_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      latency_ms INTEGER NOT NULL,
      query_type TEXT NOT NULL,
      recorded_at INTEGER NOT NULL
    )
  `);
}

function createSlowQueryTable(db: Database): void {
  db.exec(`
    CREATE TABLE slow_query_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query_text TEXT,
      latency_ms INTEGER NOT NULL,
      query_type TEXT NOT NULL,
      recorded_at INTEGER NOT NULL
    )
  `);
}

// Fixed identifier mapping — no interpolated identifiers (DB-safety rule applies to tests too).
type CountableTable = "query_latency_log" | "slow_query_log";
const COUNT_SQL: Record<CountableTable, string> = {
  query_latency_log: "SELECT COUNT(*) AS c FROM query_latency_log",
  slow_query_log: "SELECT COUNT(*) AS c FROM slow_query_log",
};
function countRows(db: Database, table: CountableTable): number {
  return (db.query(COUNT_SQL[table]).get() as { c: number }).c;
}

// ─── LatencyRingBuffer ────────────────────────────────────────────────────────

describe("LatencyRingBuffer.push + drainOrdered", () => {
  test("empty buffer returns empty array and clears dirty flag", () => {
    const buf = new LatencyRingBuffer();
    expect(buf.isDirty()).toBe(false);
    const out = buf.drainOrdered();
    expect(out).toEqual([]);
    expect(buf.isDirty()).toBe(false);
  });

  test("push marks buffer dirty", () => {
    const buf = new LatencyRingBuffer();
    buf.push({ latencyMs: 10, queryType: "sql", recordedAt: 1 });
    expect(buf.isDirty()).toBe(true);
  });

  test("drainOrdered returns items in insertion order (FIFO)", () => {
    const buf = new LatencyRingBuffer();
    const s1 = { latencyMs: 10, queryType: "sql" as const, recordedAt: 1 };
    const s2 = { latencyMs: 20, queryType: "fts" as const, recordedAt: 2 };
    const s3 = { latencyMs: 30, queryType: "vector" as const, recordedAt: 3 };
    buf.push(s1, s2, s3);
    const out = buf.drainOrdered();
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual(s1);
    expect(out[1]).toEqual(s2);
    expect(out[2]).toEqual(s3);
  });

  test("drainOrdered clears the buffer so next drain is empty", () => {
    const buf = new LatencyRingBuffer();
    buf.push({ latencyMs: 5, queryType: "hybrid", recordedAt: 1 });
    buf.drainOrdered();
    expect(buf.isDirty()).toBe(false);
    expect(buf.drainOrdered()).toEqual([]);
  });

  test("drainOrdered resets dirty to false", () => {
    const buf = new LatencyRingBuffer();
    buf.push({ latencyMs: 1, queryType: "sql", recordedAt: 1 });
    buf.drainOrdered();
    expect(buf.isDirty()).toBe(false);
  });
});

describe("LatencyRingBuffer.snapshotOrdered", () => {
  test("empty buffer returns empty snapshot", () => {
    const buf = new LatencyRingBuffer();
    expect(buf.snapshotOrdered()).toEqual([]);
  });

  test("snapshot preserves items without draining", () => {
    const buf = new LatencyRingBuffer();
    const s1 = { latencyMs: 10, queryType: "sql" as const, recordedAt: 1 };
    const s2 = { latencyMs: 20, queryType: "fts" as const, recordedAt: 2 };
    buf.push(s1, s2);
    const snap = buf.snapshotOrdered();
    expect(snap).toHaveLength(2);
    expect(snap[0]).toEqual(s1);
    expect(snap[1]).toEqual(s2);
    // buffer is still intact
    expect(buf.snapshotOrdered()).toHaveLength(2);
    expect(buf.isDirty()).toBe(true);
  });

  test("snapshot after drain returns empty", () => {
    const buf = new LatencyRingBuffer();
    buf.push({ latencyMs: 5, queryType: "sql", recordedAt: 1 });
    buf.drainOrdered();
    expect(buf.snapshotOrdered()).toEqual([]);
  });

  test("push variadic multiple samples at once", () => {
    const buf = new LatencyRingBuffer();
    buf.push(
      { latencyMs: 1, queryType: "sql", recordedAt: 1 },
      { latencyMs: 2, queryType: "fts", recordedAt: 2 },
      { latencyMs: 3, queryType: "vector", recordedAt: 3 },
    );
    expect(buf.snapshotOrdered()).toHaveLength(3);
  });
});

// ─── computeLatencyPercentilesMs ─────────────────────────────────────────────

describe("computeLatencyPercentilesMs", () => {
  test("empty samples returns all zeros", () => {
    expect(computeLatencyPercentilesMs([])).toEqual({ p50Ms: 0, p95Ms: 0, p99Ms: 0 });
  });

  test("single sample returns that value for all percentiles", () => {
    const s = { latencyMs: 42, queryType: "sql" as const, recordedAt: 1 };
    const result = computeLatencyPercentilesMs([s]);
    expect(result.p50Ms).toBe(42);
    expect(result.p95Ms).toBe(42);
    expect(result.p99Ms).toBe(42);
  });

  test("two equal samples", () => {
    const s = { latencyMs: 100, queryType: "sql" as const, recordedAt: 1 };
    const result = computeLatencyPercentilesMs([s, s]);
    expect(result.p50Ms).toBe(100);
    expect(result.p95Ms).toBe(100);
    expect(result.p99Ms).toBe(100);
  });

  test("known distribution — exact p50/p95/p99", () => {
    // 100 samples: 1..100
    const samples = Array.from({ length: 100 }, (_, i) => ({
      latencyMs: i + 1,
      queryType: "sql" as const,
      recordedAt: i,
    }));
    const result = computeLatencyPercentilesMs(samples);
    // sorted[49] = 50, sorted[94] = 95, sorted[98] = 99 (0-indexed 0..99)
    expect(result.p50Ms).toBe(50.5); // interpolated midpoint
    expect(result.p95Ms).toBeCloseTo(95.05, 5);
    expect(result.p99Ms).toBeCloseTo(99.01, 5);
  });

  test("unsorted inputs are sorted before percentile calculation", () => {
    const samples = [
      { latencyMs: 300, queryType: "sql" as const, recordedAt: 1 },
      { latencyMs: 100, queryType: "sql" as const, recordedAt: 2 },
      { latencyMs: 200, queryType: "sql" as const, recordedAt: 3 },
    ];
    const result = computeLatencyPercentilesMs(samples);
    // p50 of [100,200,300] at 0.5 → idx=1.0, lo=hi=1 → 200
    expect(result.p50Ms).toBe(200);
  });
});

// ─── flushLatencyBuffer ───────────────────────────────────────────────────────

describe("flushLatencyBuffer", () => {
  test("query_latency_log table absent: drains buffer and returns without inserting", () => {
    const db = new Database(":memory:");
    const buf = new LatencyRingBuffer();
    buf.push({ latencyMs: 10, queryType: "sql", recordedAt: FIXED_NOW - 100 });
    expect(buf.isDirty()).toBe(true);

    flushLatencyBuffer(db, buf, fixedClock);

    // buffer was drained
    expect(buf.drainOrdered()).toEqual([]);
    expect(buf.isDirty()).toBe(false);
    db.close();
  });

  test("empty buffer with table present: returns early without touching DB", () => {
    const db = new Database(":memory:");
    createLatencyTable(db);
    const buf = new LatencyRingBuffer();
    // push then drain to empty it
    buf.drainOrdered();

    flushLatencyBuffer(db, buf, fixedClock);

    expect(countRows(db, "query_latency_log")).toBe(0);
    db.close();
  });

  test("inserts samples into query_latency_log when table present", () => {
    const db = new Database(":memory:");
    createLatencyTable(db);
    const buf = new LatencyRingBuffer();
    buf.push(
      { latencyMs: 10, queryType: "sql", recordedAt: FIXED_NOW - 1000 },
      { latencyMs: 20, queryType: "fts", recordedAt: FIXED_NOW - 2000 },
    );

    flushLatencyBuffer(db, buf, fixedClock);

    expect(countRows(db, "query_latency_log")).toBe(2);
    db.close();
  });

  test("slow_query_log absent (line 148 FALSE arm): no error, only latency table cleaned", () => {
    const db = new Database(":memory:");
    // Only create query_latency_log — NOT slow_query_log
    createLatencyTable(db);
    const buf = new LatencyRingBuffer();
    buf.push({ latencyMs: 50, queryType: "sql", recordedAt: FIXED_NOW - 100 });

    // Should not throw even though slow_query_log is absent
    expect(() => flushLatencyBuffer(db, buf, fixedClock)).not.toThrow();
    expect(countRows(db, "query_latency_log")).toBe(1);
    db.close();
  });

  test("slow_query_log present (line 148 TRUE arm): DELETE runs on slow_query_log", () => {
    const db = new Database(":memory:");
    createLatencyTable(db);
    createSlowQueryTable(db);

    // Insert an old slow-query row that should be pruned
    const SLOW_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
    const oldRecordedAt = FIXED_NOW - SLOW_RETENTION_MS - 1;
    dbRun(
      db,
      "INSERT INTO slow_query_log (query_text, latency_ms, query_type, recorded_at) VALUES (?, ?, ?, ?)",
      ["q", 600, "sql", oldRecordedAt],
    );
    expect(countRows(db, "slow_query_log")).toBe(1);

    const buf = new LatencyRingBuffer();
    buf.push({ latencyMs: 100, queryType: "sql", recordedAt: FIXED_NOW - 100 });

    flushLatencyBuffer(db, buf, fixedClock);

    // Old slow query row must have been pruned
    expect(countRows(db, "slow_query_log")).toBe(0);
    db.close();
  });

  test("old latency rows are deleted by cutoff", () => {
    const db = new Database(":memory:");
    createLatencyTable(db);

    // Insert a row that is older than LATENCY_RETENTION_MS (24h)
    const LATENCY_RETENTION_MS = 24 * 60 * 60 * 1000;
    const oldRecordedAt = FIXED_NOW - LATENCY_RETENTION_MS - 1;
    dbRun(
      db,
      "INSERT INTO query_latency_log (latency_ms, query_type, recorded_at) VALUES (?, ?, ?)",
      [100, "sql", oldRecordedAt],
    );
    expect(countRows(db, "query_latency_log")).toBe(1);

    const buf = new LatencyRingBuffer();
    // Push a new sample to trigger the flush (non-empty batch)
    buf.push({ latencyMs: 50, queryType: "sql", recordedAt: FIXED_NOW });

    flushLatencyBuffer(db, buf, fixedClock);

    // The new sample was inserted (1) but old one deleted (1), net = 1
    const rows = db.query("SELECT recorded_at FROM query_latency_log").all() as Array<{
      recorded_at: number;
    }>;
    expect(rows.every((r) => r.recorded_at >= FIXED_NOW - LATENCY_RETENTION_MS)).toBe(true);
    db.close();
  });

  test("large batch (>200 samples) uses chunking", () => {
    const db = new Database(":memory:");
    createLatencyTable(db);
    const buf = new LatencyRingBuffer();
    for (let i = 0; i < 250; i += 1) {
      buf.push({ latencyMs: i, queryType: "sql", recordedAt: FIXED_NOW - i });
    }

    flushLatencyBuffer(db, buf, fixedClock);

    expect(countRows(db, "query_latency_log")).toBe(250);
    db.close();
  });
});

// ─── recordSlowQuery ──────────────────────────────────────────────────────────

describe("recordSlowQuery", () => {
  test("below threshold: returns without inserting", () => {
    const db = new Database(":memory:");
    createSlowQueryTable(db);

    recordSlowQuery(db, {
      queryText: "SELECT 1",
      latencyMs: 100,
      queryType: "sql",
      recordedAt: FIXED_NOW,
      thresholdMs: 500,
    });

    expect(countRows(db, "slow_query_log")).toBe(0);
    db.close();
  });

  test("table absent: returns without error", () => {
    const db = new Database(":memory:");
    // No slow_query_log table

    expect(() =>
      recordSlowQuery(db, {
        queryText: "SELECT 1",
        latencyMs: 1000,
        queryType: "sql",
        recordedAt: FIXED_NOW,
        thresholdMs: 500,
      }),
    ).not.toThrow();
    db.close();
  });

  test("above threshold with table present: inserts row", () => {
    const db = new Database(":memory:");
    createSlowQueryTable(db);

    recordSlowQuery(db, {
      queryText: "SELECT expensive",
      latencyMs: 1000,
      queryType: "fts",
      recordedAt: FIXED_NOW,
      thresholdMs: DEFAULT_SLOW_QUERY_THRESHOLD_MS,
    });

    expect(countRows(db, "slow_query_log")).toBe(1);
    const row = db.query("SELECT * FROM slow_query_log").get() as {
      query_text: string;
      latency_ms: number;
      query_type: string;
    };
    expect(row.query_text).toBe("SELECT expensive");
    expect(row.latency_ms).toBe(1000);
    expect(row.query_type).toBe("fts");
    db.close();
  });

  test("null queryText is stored as null", () => {
    const db = new Database(":memory:");
    createSlowQueryTable(db);

    recordSlowQuery(db, {
      queryText: null,
      latencyMs: 600,
      queryType: "sql",
      recordedAt: FIXED_NOW,
      thresholdMs: 500,
    });

    const row = db.query("SELECT query_text FROM slow_query_log").get() as {
      query_text: string | null;
    };
    expect(row.query_text).toBeNull();
    db.close();
  });

  test("exactly at threshold: inserts (latencyMs >= thresholdMs)", () => {
    const db = new Database(":memory:");
    createSlowQueryTable(db);

    recordSlowQuery(db, {
      queryText: "q",
      latencyMs: 500,
      queryType: "sql",
      recordedAt: FIXED_NOW,
      thresholdMs: 500,
    });

    expect(countRows(db, "slow_query_log")).toBe(1);
    db.close();
  });
});

// ─── readLatencyPercentilesFromDb ─────────────────────────────────────────────

describe("readLatencyPercentilesFromDb", () => {
  test("table absent: returns all zeros", () => {
    const db = new Database(":memory:");
    const result = readLatencyPercentilesFromDb(db, fixedClock);
    expect(result).toEqual({ p50Ms: 0, p95Ms: 0, p99Ms: 0 });
    db.close();
  });

  test("table present but empty: returns all zeros", () => {
    const db = new Database(":memory:");
    createLatencyTable(db);
    const result = readLatencyPercentilesFromDb(db, fixedClock);
    expect(result).toEqual({ p50Ms: 0, p95Ms: 0, p99Ms: 0 });
    db.close();
  });

  test("rows within retention window: returns correct percentiles", () => {
    const db = new Database(":memory:");
    createLatencyTable(db);

    // Insert rows within the retention window (FIXED_NOW - 1h)
    for (let i = 1; i <= 10; i += 1) {
      dbRun(
        db,
        "INSERT INTO query_latency_log (latency_ms, query_type, recorded_at) VALUES (?, ?, ?)",
        [i * 10, "sql", FIXED_NOW - 3600000],
      );
    }

    const result = readLatencyPercentilesFromDb(db, fixedClock);
    expect(result.p50Ms).toBeGreaterThan(0);
    expect(result.p95Ms).toBeGreaterThanOrEqual(result.p50Ms);
    expect(result.p99Ms).toBeGreaterThanOrEqual(result.p95Ms);
    db.close();
  });

  test("rows outside retention window are excluded", () => {
    const db = new Database(":memory:");
    createLatencyTable(db);
    const LATENCY_RETENTION_MS = 24 * 60 * 60 * 1000;

    // Insert rows older than retention window
    dbRun(
      db,
      "INSERT INTO query_latency_log (latency_ms, query_type, recorded_at) VALUES (?, ?, ?)",
      [999, "sql", FIXED_NOW - LATENCY_RETENTION_MS - 1],
    );

    const result = readLatencyPercentilesFromDb(db, fixedClock);
    expect(result).toEqual({ p50Ms: 0, p95Ms: 0, p99Ms: 0 });
    db.close();
  });
});

// ─── startLatencyFlushScheduler ──────────────────────────────────────────────

describe("startLatencyFlushScheduler", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    createLatencyTable(db);
    // Drain the module singleton before each test to avoid cross-test bleed
    latencyRingBuffer.drainOrdered();
  });

  afterEach(() => {
    db.close();
  });

  test("stop() calls flushLatencyBuffer and cleans up signal handlers", () => {
    const sigTermListenersBefore = process.listenerCount("SIGTERM");
    const sigIntListenersBefore = process.listenerCount("SIGINT");

    // Use a real recent timestamp so the DELETE cutoff (real Date.now()) does not prune it.
    latencyRingBuffer.push({ latencyMs: 42, queryType: "sql", recordedAt: Date.now() - 100 });

    const scheduler = startLatencyFlushScheduler(db);

    // Listeners should have been added
    expect(process.listenerCount("SIGTERM")).toBe(sigTermListenersBefore + 1);
    expect(process.listenerCount("SIGINT")).toBe(sigIntListenersBefore + 1);

    scheduler.stop();

    // Listeners should have been removed
    expect(process.listenerCount("SIGTERM")).toBe(sigTermListenersBefore);
    expect(process.listenerCount("SIGINT")).toBe(sigIntListenersBefore);

    // The flush on stop should have inserted the sample
    expect(countRows(db, "query_latency_log")).toBe(1);
  });

  test("stop() is idempotent: second stop does not throw", () => {
    const scheduler = startLatencyFlushScheduler(db);
    scheduler.stop();
    expect(() => scheduler.stop()).not.toThrow();
  });

  test("an interval flush error is isolated and later ticks keep running", async () => {
    db.exec(`
      DROP TABLE query_latency_log;
      CREATE TABLE query_latency_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        latency_ms INTEGER NOT NULL CHECK (latency_ms < 0),
        query_type TEXT NOT NULL,
        recorded_at INTEGER NOT NULL
      )
    `);
    const buffer = new LatencyRingBuffer();
    buffer.push({ latencyMs: 42, queryType: "sql", recordedAt: Date.now() });

    const scheduler = startLatencyFlushScheduler(db, { intervalMs: 5, buffer });
    try {
      // The first tick drains the sample, then fails the table constraint.
      await Bun.sleep(20);

      db.exec("DROP TABLE query_latency_log");
      createLatencyTable(db);
      buffer.push({ latencyMs: 7, queryType: "sql", recordedAt: Date.now() });

      // A later tick must still run after the isolated failure.
      for (
        let attempt = 0;
        attempt < 20 && countRows(db, "query_latency_log") === 0;
        attempt += 1
      ) {
        await Bun.sleep(5);
      }
      expect(countRows(db, "query_latency_log")).toBe(1);
    } finally {
      scheduler.stop();
    }
  });

  test("the SIGTERM handler isolates a flush error", () => {
    db.exec(`
      DROP TABLE query_latency_log;
      CREATE TABLE query_latency_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        latency_ms INTEGER NOT NULL CHECK (latency_ms < 0),
        query_type TEXT NOT NULL,
        recorded_at INTEGER NOT NULL
      )
    `);
    const buffer = new LatencyRingBuffer();
    buffer.push({ latencyMs: 42, queryType: "sql", recordedAt: Date.now() });
    const listenersBefore = new Set(process.listeners("SIGTERM"));

    const scheduler = startLatencyFlushScheduler(db, { buffer });
    try {
      const signalHandler = process
        .listeners("SIGTERM")
        .find((listener) => !listenersBefore.has(listener));
      expect(signalHandler).toBeDefined();
      expect(() => signalHandler?.("SIGTERM")).not.toThrow();
    } finally {
      scheduler.stop();
    }

    expect(process.listenerCount("SIGTERM")).toBe(listenersBefore.size);
  });
});
