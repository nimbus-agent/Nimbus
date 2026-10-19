import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import {
  ACTIVITY_RETENTION_DAYS,
  pruneActivityHistory,
  startActivityRetention,
} from "./activity-retention.ts";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

function seeded(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  db.run(
    "INSERT INTO watcher (id, name, condition_type, condition_json, action_type, action_json, created_at) VALUES ('w1', 'w', 'c', '{}', 'a', '{}', 0)",
  );
  for (const ageDays of [1, 89, 91, 400]) {
    const at = NOW - ageDays * DAY;
    db.run(
      "INSERT INTO sync_telemetry (service, started_at, duration_ms) VALUES ('github', ?, 1)",
      [at],
    );
    db.run(
      "INSERT INTO watcher_event (watcher_id, fired_at, condition_snapshot) VALUES ('w1', ?, '{}')",
      [at],
    );
  }
  return db;
}

const count = (db: Database, table: string): number =>
  (db.query(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;

describe("activity history retention (audit P4)", () => {
  test("rows older than the window go; newer ones stay", () => {
    const db = seeded();
    const removed = pruneActivityHistory(db, {
      retentionDays: ACTIVITY_RETENTION_DAYS,
      nowMs: NOW,
    });
    expect(removed).toEqual({ sync_telemetry: 2, watcher_event: 2 });
    expect(count(db, "sync_telemetry")).toBe(2);
    expect(count(db, "watcher_event")).toBe(2);
    db.close();
  });

  test("a non-positive window keeps everything, and missing tables are skipped", () => {
    const db = seeded();
    expect(pruneActivityHistory(db, { retentionDays: 0, nowMs: NOW })).toEqual({});
    expect(count(db, "sync_telemetry")).toBe(4);
    db.close();
    const bare = new Database(":memory:");
    expect(pruneActivityHistory(bare, { retentionDays: 90, nowMs: NOW })).toEqual({});
    bare.close();
  });

  test("the scheduler prunes at start and never throws on a closed handle", () => {
    const db = seeded();
    const handle = startActivityRetention(db, { nowMs: () => NOW });
    expect(count(db, "watcher_event")).toBe(2);
    handle.stop();
    db.close();
    const closed = new Database(":memory:");
    closed.close();
    expect(() => startActivityRetention(closed).stop()).not.toThrow();
  });

  test("a watcher's history read uses the V72 (watcher_id, fired_at) index", () => {
    const db = seeded();
    const plan = (
      db
        .query(
          "EXPLAIN QUERY PLAN SELECT fired_at FROM watcher_event WHERE watcher_id = 'w1' ORDER BY fired_at DESC LIMIT 5",
        )
        .all() as { detail: string }[]
    )
      .map((r) => r.detail)
      .join(" | ");
    expect(plan).toContain("idx_watcher_event_watcher_fired");
    expect(plan).not.toContain("TEMP B-TREE");
    db.close();
  });
});
