import type { Database } from "bun:sqlite";

import { dbRun } from "./write.ts";

export type QueryLatencyKind = "fts" | "vector" | "hybrid" | "sql";

export type LatencySample = {
  latencyMs: number;
  queryType: QueryLatencyKind;
  recordedAt: number;
};

const RING_SIZE = 1440;

const LATENCY_RETENTION_MS = 24 * 60 * 60 * 1000;
const SLOW_QUERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export const DEFAULT_SLOW_QUERY_THRESHOLD_MS = 500;

export class LatencyRingBuffer {
  private readonly buf: LatencySample[] = new Array(RING_SIZE);
  private head = 0;
  private count = 0;
  private dirty = false;

  push(...samples: LatencySample[]): void {
    for (const sample of samples) {
      this.buf[this.head] = sample;
      this.head = (this.head + 1) % RING_SIZE;
      this.count = Math.min(this.count + 1, RING_SIZE);
      this.dirty = true;
    }
  }

  drainOrdered(): LatencySample[] {
    if (this.count === 0) {
      this.dirty = false;
      return [];
    }
    const out: LatencySample[] = [];
    const start = (this.head - this.count + RING_SIZE) % RING_SIZE;
    for (let i = 0; i < this.count; i += 1) {
      const idx = (start + i) % RING_SIZE;
      const s = this.buf[idx];
      if (s !== undefined) {
        out.push(s);
      }
    }
    this.count = 0;
    this.head = 0;
    this.dirty = false;
    return out;
  }

  snapshotOrdered(): LatencySample[] {
    if (this.count === 0) {
      return [];
    }
    const out: LatencySample[] = [];
    const start = (this.head - this.count + RING_SIZE) % RING_SIZE;
    for (let i = 0; i < this.count; i += 1) {
      const idx = (start + i) % RING_SIZE;
      const s = this.buf[idx];
      if (s !== undefined) {
        out.push(s);
      }
    }
    return out;
  }

  isDirty(): boolean {
    return this.dirty;
  }
}

export const latencyRingBuffer = new LatencyRingBuffer();

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const loV = sorted[lo];
  const hiV = sorted[hi];
  if (loV === undefined || hiV === undefined) {
    return sorted.at(-1) ?? 0;
  }
  if (lo === hi) {
    return loV;
  }
  return loV * (hi - idx) + hiV * (idx - lo);
}

export function computeLatencyPercentilesMs(samples: readonly LatencySample[]): {
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
} {
  if (samples.length === 0) {
    return { p50Ms: 0, p95Ms: 0, p99Ms: 0 };
  }
  const ms = samples.map((s) => s.latencyMs).sort((a, b) => a - b);
  return {
    p50Ms: percentile(ms, 0.5),
    p95Ms: percentile(ms, 0.95),
    p99Ms: percentile(ms, 0.99),
  };
}

function tableExists(db: Database, name: string): boolean {
  const row = db
    .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { 1: number } | null;
  return row !== null;
}

export function flushLatencyBuffer(
  db: Database,
  buffer: LatencyRingBuffer,
  now: () => number = Date.now,
): void {
  if (!tableExists(db, "query_latency_log")) {
    buffer.drainOrdered();
    return;
  }
  const batch = buffer.drainOrdered();
  if (batch.length === 0) {
    return;
  }
  const nowMs = now();
  const cutoffLatency = nowMs - LATENCY_RETENTION_MS;
  const cutoffSlow = nowMs - SLOW_QUERY_RETENTION_MS;

  db.transaction(() => {
    const chunkSize = 200;
    for (let i = 0; i < batch.length; i += chunkSize) {
      const chunk = batch.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => "(?, ?, ?)").join(", ");
      const flat: unknown[] = [];
      for (const s of chunk) {
        flat.push(s.latencyMs, s.queryType, s.recordedAt);
      }
      dbRun(
        db,
        `INSERT INTO query_latency_log (latency_ms, query_type, recorded_at) VALUES ${placeholders}`,
        flat,
      );
    }
    dbRun(db, "DELETE FROM query_latency_log WHERE recorded_at < ?", [cutoffLatency]);
    if (tableExists(db, "slow_query_log")) {
      dbRun(db, "DELETE FROM slow_query_log WHERE recorded_at < ?", [cutoffSlow]);
    }
  })();
}

export function recordSlowQuery(
  db: Database,
  opts: {
    queryText: string | null;
    latencyMs: number;
    queryType: QueryLatencyKind;
    recordedAt: number;
    thresholdMs: number;
  },
): void {
  if (opts.latencyMs < opts.thresholdMs) {
    return;
  }
  if (!tableExists(db, "slow_query_log")) {
    return;
  }
  dbRun(
    db,
    "INSERT INTO slow_query_log (query_text, latency_ms, query_type, recorded_at) VALUES (?, ?, ?, ?)",
    [opts.queryText, opts.latencyMs, opts.queryType, opts.recordedAt],
  );
}

export function readLatencyPercentilesFromDb(
  db: Database,
  now: () => number = Date.now,
): {
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
} {
  if (!tableExists(db, "query_latency_log")) {
    return { p50Ms: 0, p95Ms: 0, p99Ms: 0 };
  }
  const since = now() - LATENCY_RETENTION_MS;
  const rows = db
    .query(
      "SELECT latency_ms FROM query_latency_log WHERE recorded_at >= ? ORDER BY latency_ms ASC",
    )
    .all(since) as Array<{ latency_ms: number }>;
  const samples: LatencySample[] = rows.map((r) => ({
    latencyMs: r.latency_ms,
    queryType: "sql",
    recordedAt: 0,
  }));
  return computeLatencyPercentilesMs(samples);
}

export type LatencyFlushScheduler = {
  readonly stop: () => void;
};

export interface StartLatencyFlushSchedulerOptions {
  /** Flush cadence; defaults to 30 seconds. Inject a shorter interval in tests. */
  intervalMs?: number;
  /** Flush target; defaults to the process-wide latency buffer. Injected in tests. */
  buffer?: LatencyRingBuffer;
}

export function startLatencyFlushScheduler(
  db: Database,
  opts: StartLatencyFlushSchedulerOptions = {},
): LatencyFlushScheduler {
  const buffer = opts.buffer ?? latencyRingBuffer;
  const timer = setInterval(() => {
    try {
      flushLatencyBuffer(db, buffer);
    } catch {
      /* telemetry loss acceptable */
    }
  }, opts.intervalMs ?? 30_000);

  const onSig = (): void => {
    try {
      flushLatencyBuffer(db, buffer);
    } catch {
      /* best-effort */
    }
  };
  process.on("SIGTERM", onSig);
  process.on("SIGINT", onSig);

  return {
    stop: (): void => {
      clearInterval(timer);
      process.off("SIGTERM", onSig);
      process.off("SIGINT", onSig);
      try {
        flushLatencyBuffer(db, buffer);
      } catch {
        /* ignore */
      }
    },
  };
}
