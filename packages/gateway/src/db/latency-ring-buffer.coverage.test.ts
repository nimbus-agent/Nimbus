/**
 * The two flush triggers of `startLatencyFlushScheduler` that `latency-ring-buffer.test.ts` never
 * fires: the 30-second tick (driven on a fake clock) and the SIGTERM / SIGINT handlers (invoked
 * directly — the handler this scheduler registered, never a real signal and never another
 * module's listener). Both are best-effort: a flush that throws is swallowed and loses only its
 * own batch, and the scheduler keeps running.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import {
  type LatencyFlushScheduler,
  latencyRingBuffer,
  startLatencyFlushScheduler,
} from "./latency-ring-buffer.ts";

const TICK_MS = 30_000;

let db: Database;
let scheduler: LatencyFlushScheduler | undefined;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE query_latency_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      latency_ms INTEGER NOT NULL,
      query_type TEXT NOT NULL,
      recorded_at INTEGER NOT NULL
    )
  `);
  // The buffer is a process-wide singleton; start every test from an empty one.
  latencyRingBuffer.drainOrdered();
});

afterEach(() => {
  scheduler?.stop();
  scheduler = undefined;
  jest.useRealTimers();
  latencyRingBuffer.drainOrdered();
  db.close();
});

function logged(): { latency_ms: number; query_type: string }[] {
  return db.query("SELECT latency_ms, query_type FROM query_latency_log ORDER BY id").all() as {
    latency_ms: number;
    query_type: string;
  }[];
}

/** Makes every insert into the log fail, as a full or read-only disk would. */
function breakInserts(): void {
  db.exec(`CREATE TRIGGER fail_insert BEFORE INSERT ON query_latency_log
           BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END`);
}

function push(latencyMs: number, queryType: "fts" | "vector" | "hybrid" | "sql"): void {
  latencyRingBuffer.push({ latencyMs, queryType, recordedAt: Date.now() });
}

describe("the 30-second tick (fake clock)", () => {
  test("flushes the shared buffer on the tick, and not a millisecond before", () => {
    jest.useFakeTimers();
    scheduler = startLatencyFlushScheduler(db);
    push(17, "fts");
    push(230, "hybrid");

    jest.advanceTimersByTime(TICK_MS - 1);
    expect(logged()).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(logged()).toEqual([
      { latency_ms: 17, query_type: "fts" },
      { latency_ms: 230, query_type: "hybrid" },
    ]);
    expect(latencyRingBuffer.isDirty()).toBe(false);
  });

  test("a tick whose flush throws is swallowed; its batch is dropped and the next tick still runs", () => {
    jest.useFakeTimers();
    scheduler = startLatencyFlushScheduler(db);
    breakInserts();
    push(17, "fts");
    expect(() => jest.advanceTimersByTime(TICK_MS)).not.toThrow();
    expect(logged()).toEqual([]);

    db.exec("DROP TRIGGER fail_insert");
    push(40, "sql");
    jest.advanceTimersByTime(TICK_MS);
    // Only the sample pushed after the failure — the failed batch is not retried.
    expect(logged()).toEqual([{ latency_ms: 40, query_type: "sql" }]);
  });
});

describe("the shutdown signal handlers", () => {
  /** The ONE listener this scheduler added — found by difference, never by position. */
  function onlyAdded<L>(before: readonly L[], after: readonly L[]): L {
    const added = after.filter((l) => !before.includes(l));
    expect(added).toHaveLength(1);
    const [listener] = added;
    if (listener === undefined) throw new Error("the scheduler added no listener");
    return listener;
  }

  test("SIGTERM flushes what the buffer holds", () => {
    const before = process.listeners("SIGTERM");
    scheduler = startLatencyFlushScheduler(db);
    const onSignal = onlyAdded(before, process.listeners("SIGTERM"));

    push(55, "vector");
    onSignal("SIGTERM");
    expect(logged()).toEqual([{ latency_ms: 55, query_type: "vector" }]);
  });

  test("SIGINT flushes what the buffer holds", () => {
    const before = process.listeners("SIGINT");
    scheduler = startLatencyFlushScheduler(db);
    const onSignal = onlyAdded(before, process.listeners("SIGINT"));

    push(56, "fts");
    onSignal("SIGINT");
    expect(logged()).toEqual([{ latency_ms: 56, query_type: "fts" }]);
  });

  test("a flush that throws inside the signal handler is swallowed, not rethrown", () => {
    const before = process.listeners("SIGTERM");
    scheduler = startLatencyFlushScheduler(db);
    const onSignal = onlyAdded(before, process.listeners("SIGTERM"));
    breakInserts();
    push(55, "vector");
    expect(() => onSignal("SIGTERM")).not.toThrow();
    expect(logged()).toEqual([]);
  });
});
