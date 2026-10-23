import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { runIndexedSchemaMigrations } from "./runner.ts";

type Col = { name: string; type: string; notnull: number; dflt_value: string | null; pk: number };

function columns(db: Database, table: string): Col[] {
  return db.query(`PRAGMA table_info(${table})`).all() as Col[];
}

describe("V73 migration — connector migration, built-in registry state, dropped sync items", () => {
  test("CURRENT_SCHEMA_VERSION is at least 73", () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(73);
  });

  test("V73 creates connector_migration and builtin_registry_state and records the step", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 73);
      expect(columns(db, "connector_migration").map((c) => c.name)).toEqual([
        "id",
        "legacy_service_id",
        "extension_id",
        "version",
        "tree_digest",
        "stage_path",
        "state",
        "error",
        "created_at",
        "updated_at",
      ]);
      expect(columns(db, "builtin_registry_state")).toEqual([
        { cid: 0, name: "name", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
        { cid: 1, name: "root_key", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
        { cid: 2, name: "last_sequence", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
        { cid: 3, name: "last_generated_at", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
        { cid: 4, name: "last_fetched_at", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      ] as unknown as Col[]);
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 73 });
      expect(
        db.query("SELECT version, description FROM _schema_migrations WHERE version = 73").get(),
      ).toEqual({
        version: 73,
        description: "connector migration + built-in registry state + sync_telemetry.items_dropped",
      });
    } finally {
      db.close();
    }
  });

  test("connector_migration refuses an unknown state and a second row for one legacy service", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 73);
      const insert = (id: string, legacy: string, state: string) =>
        db.run(
          `INSERT INTO connector_migration (id, legacy_service_id, extension_id, state, created_at, updated_at)
           VALUES (?, ?, 'com.nimbus.readwise', ?, 1, 1)`,
          [id, legacy, state],
        );
      insert("m1", "readwise", "awaiting_approval");
      for (const s of ["approved", "declined", "failed"]) insert(`m-${s}`, `svc-${s}`, s);
      expect(() => insert("m2", "other", "running")).toThrow(/CHECK/);
      expect(() => insert("m3", "readwise", "approved")).toThrow(/UNIQUE/);
    } finally {
      db.close();
    }
  });

  test("an existing sync_telemetry row reads items_dropped = 0, and the old insert shape still works", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 72);
      db.run(
        "INSERT INTO sync_telemetry (service, started_at, duration_ms) VALUES ('github', 1, 2)",
      );
      runIndexedSchemaMigrations(db, 73);
      const col = columns(db, "sync_telemetry").find((c) => c.name === "items_dropped");
      expect(col?.notnull).toBe(1);
      expect(col?.dflt_value).toBe("0");
      db.run(
        `INSERT INTO sync_telemetry (
           service, started_at, duration_ms, items_upserted, items_deleted, bytes_transferred, had_more, error_msg
         ) VALUES ('slack', 3, 4, 0, 0, NULL, 0, NULL)`,
      );
      expect(
        db.query("SELECT service, items_dropped FROM sync_telemetry ORDER BY started_at").all(),
      ).toEqual([
        { service: "github", items_dropped: 0 },
        { service: "slack", items_dropped: 0 },
      ]);
    } finally {
      db.close();
    }
  });
});
