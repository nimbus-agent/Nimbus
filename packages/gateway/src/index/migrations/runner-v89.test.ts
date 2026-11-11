import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { maxRegisteredIndexedSchemaVersion, runIndexedSchemaMigrations } from "./runner.ts";

function cols(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
}

describe("V89 migration — workflow schedules and blocked runs", () => {
  test("a V88 database gains the schedule and blocked-run columns, all NULL for existing rows", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 88);
      db.run(
        `INSERT INTO workflow (id, name, description, steps_json, created_at, updated_at)
         VALUES ('w1', 'old', NULL, '[]', 1, 1)`,
      );
      db.run(
        `INSERT INTO workflow_run (id, workflow_id, triggered_by, status, started_at)
         VALUES ('r1', 'w1', 'cli', 'done', 1)`,
      );
      runIndexedSchemaMigrations(db, 89);
      expect(cols(db, "workflow")).toEqual(
        expect.arrayContaining(["schedule", "schedule_tz", "schedule_next_at", "schedule_last_fire_at"]),
      );
      expect(cols(db, "workflow_run")).toEqual(
        expect.arrayContaining(["blocked_step", "blocked_at", "trigger", "workflow_sha256"]),
      );
      expect(
        db
          .query(
            "SELECT schedule, schedule_tz, schedule_next_at, schedule_last_fire_at FROM workflow WHERE id = 'w1'",
          )
          .get(),
      ).toEqual({
        schedule: null,
        schedule_tz: null,
        schedule_next_at: null,
        schedule_last_fire_at: null,
      });
      expect(
        db
          .query("SELECT blocked_step, blocked_at, trigger, workflow_sha256 FROM workflow_run")
          .get(),
      ).toEqual({ blocked_step: null, blocked_at: null, trigger: null, workflow_sha256: null });
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 89 });
    } finally {
      db.close();
    }
  });

  test("the run status column takes the two new values, and the schema constant agrees", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 89);
      db.run(
        `INSERT INTO workflow (id, name, steps_json, created_at, updated_at) VALUES ('w', 'n', '[]', 1, 1)`,
      );
      for (const status of ["blocked_on_approval", "abandoned"]) {
        db.run(
          `INSERT INTO workflow_run (id, workflow_id, triggered_by, status, started_at) VALUES (?, 'w', 'x', ?, 1)`,
          [`r-${status}`, status],
        );
      }
      expect(CURRENT_SCHEMA_VERSION).toBe(maxRegisteredIndexedSchemaVersion());
      expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(89);
    } finally {
      db.close();
    }
  });
});
