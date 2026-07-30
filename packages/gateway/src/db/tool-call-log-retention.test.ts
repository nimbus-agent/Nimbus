import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { GENESIS_HASH } from "./audit-chain.ts";
import { writeToolCallLog } from "./tool-call-log.ts";
import {
  effectiveRetentionDays,
  pruneToolCallLog,
  startToolCallLogRetention,
} from "./tool-call-log-retention.ts";

const DAY_MS = 86_400_000;

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE tool_call_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      tool_id TEXT NOT NULL,
      service TEXT NOT NULL,
      called_at INTEGER NOT NULL,
      duration_ms INTEGER,
      result_envelope TEXT,
      status TEXT,
      params_json TEXT
    );
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action_type TEXT NOT NULL,
      hitl_status TEXT NOT NULL,
      action_json TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      row_hash TEXT,
      prev_hash TEXT,
      session_id TEXT
    );
  `);
  return db;
}

function seedCall(db: Database, calledAt: number): void {
  writeToolCallLog(db, {
    sessionId: null,
    toolId: "t",
    service: "s",
    calledAt,
    durationMs: 1,
    resultEnvelope: "{}",
    status: "ok",
  });
}

function countCalls(db: Database): number {
  return (db.query("SELECT COUNT(*) AS c FROM tool_call_log").get() as { c: number }).c;
}

function countAudit(db: Database): number {
  return (db.query("SELECT COUNT(*) AS c FROM audit_log").get() as { c: number }).c;
}

describe("pruneToolCallLog", () => {
  let db: Database;
  const now = 1_000 * DAY_MS;

  beforeEach(() => {
    db = freshDb();
  });

  test("deletes rows older than the retention window, keeps newer", () => {
    seedCall(db, now - 91 * DAY_MS);
    seedCall(db, now - 89 * DAY_MS);
    seedCall(db, now);
    const deleted = pruneToolCallLog(db, { retentionDays: 90, nowMs: now });
    expect(deleted).toBe(1);
    expect(countCalls(db)).toBe(2);
  });

  test("retentionDays = 0 disables pruning (no delete, no audit row)", () => {
    seedCall(db, now - 10_000 * DAY_MS);
    const deleted = pruneToolCallLog(db, { retentionDays: 0, nowMs: now });
    expect(deleted).toBe(0);
    expect(countCalls(db)).toBe(1);
    expect(countAudit(db)).toBe(0);
  });

  test("writes exactly one chained tool_call_log.pruned audit entry with the count", () => {
    seedCall(db, now - 100 * DAY_MS);
    seedCall(db, now - 200 * DAY_MS);
    pruneToolCallLog(db, { retentionDays: 90, nowMs: now });
    const rows = db
      .query("SELECT action_type, hitl_status, action_json, prev_hash, row_hash FROM audit_log")
      .all() as Array<{
      action_type: string;
      hitl_status: string;
      action_json: string;
      prev_hash: string;
      row_hash: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action_type).toBe("tool_call_log.pruned");
    expect(rows[0]?.hitl_status).toBe("not_required");
    expect(JSON.parse(rows[0]?.action_json ?? "{}").deleted_count).toBe(2);
    expect(rows[0]?.prev_hash).toBe(GENESIS_HASH);
    expect(rows[0]?.row_hash).toHaveLength(64);
  });

  test("no rows to prune -> no audit entry", () => {
    seedCall(db, now);
    const deleted = pruneToolCallLog(db, { retentionDays: 90, nowMs: now });
    expect(deleted).toBe(0);
    expect(countAudit(db)).toBe(0);
  });

  test("missing tool_call_log table is a no-op (returns 0)", () => {
    const bare = new Database(":memory:");
    expect(pruneToolCallLog(bare, { retentionDays: 90, nowMs: now })).toBe(0);
  });

  test("policy floor lengthens retention: effective = max(local, floor)", () => {
    // local config says 7 days, policy floor says 30 -> a 20-day-old row must be KEPT
    seedCall(db, now - 20 * DAY_MS);
    pruneToolCallLog(db, { retentionDays: effectiveRetentionDays(7, 30), nowMs: now });
    expect(countCalls(db)).toBe(1); // kept, because effective retention is 30, not 7
  });
});

describe("effectiveRetentionDays", () => {
  test("policy floor lengthens retention when higher than local", () => {
    expect(effectiveRetentionDays(7, 30)).toBe(30);
  });

  test("local wins when already longer than the floor", () => {
    expect(effectiveRetentionDays(90, 30)).toBe(90);
  });

  test("a zero floor never shortens local retention", () => {
    expect(effectiveRetentionDays(7, 0)).toBe(7);
  });
});

describe("startToolCallLogRetention", () => {
  const now = 1_000 * DAY_MS;

  test("prunes once immediately on start", () => {
    const db = freshDb();
    seedCall(db, now - 200 * DAY_MS);
    const handle = startToolCallLogRetention(db, {
      retentionDays: 90,
      nowMs: () => now,
    });
    try {
      expect(countCalls(db)).toBe(0);
    } finally {
      handle.stop();
    }
  });

  test("falls back to Date.now when no clock is injected", () => {
    // `opts.nowMs ?? Date.now` — the DEFAULT arm. Every other case here injects a
    // clock, so production's actual clock source was never exercised. Seeded far
    // enough in the real past that the assertion cannot depend on the wall clock.
    const db = freshDb();
    seedCall(db, Date.now() - 200 * DAY_MS);
    seedCall(db, Date.now() - 1 * DAY_MS);
    const handle = startToolCallLogRetention(db, { retentionDays: 90 });
    try {
      // Only the 200-day-old row is past a 90-day cutoff measured from the real now.
      expect(countCalls(db)).toBe(1);
    } finally {
      handle.stop();
    }
  });

  test("a prune error does not throw out of the tick", () => {
    const db = freshDb();
    db.exec("DROP TABLE audit_log");
    seedCall(db, now - 200 * DAY_MS);
    const handle = startToolCallLogRetention(db, {
      retentionDays: 90,
      nowMs: () => now,
    });
    handle.stop();
    // The throwing tick was swallowed AND its transaction rolled back: the row survives.
    expect(countCalls(db)).toBe(1);
  });

  test("retentionDays = 0 starts no timer and prunes nothing", () => {
    const db = freshDb();
    seedCall(db, now - 10_000 * DAY_MS);
    const handle = startToolCallLogRetention(db, {
      retentionDays: 0,
      nowMs: () => now,
    });
    try {
      expect(countCalls(db)).toBe(1);
    } finally {
      handle.stop();
    }
  });
});
