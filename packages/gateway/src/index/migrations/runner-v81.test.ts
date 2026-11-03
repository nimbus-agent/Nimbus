import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { maxRegisteredIndexedSchemaVersion, runIndexedSchemaMigrations } from "./runner.ts";

function cols(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
}

describe("V81 migration — extension network observation", () => {
  test("a V80 database migrates to 81 and has its three tables with the expected columns", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 80);
      expect(
        db.query("SELECT name FROM sqlite_master WHERE name LIKE 'extension_%observ%'").all(),
      ).toHaveLength(0);
      runIndexedSchemaMigrations(db, 81);
      expect(cols(db, "extension_network_observation")).toEqual([
        "extension_id",
        "version",
        "destination",
        "port",
        "outcome",
        "first_seen",
        "last_seen",
        "count",
      ]);
      expect(cols(db, "extension_observation_coverage")).toEqual([
        "extension_id",
        "version",
        "os",
        "runs",
        "observed_ms",
        "first_seen",
        "last_seen",
        "dropped",
        "network_observed",
        "stopped",
      ]);
      // Which (run, seq) window files have been applied, so a file applied once never counts twice.
      expect(cols(db, "extension_observation_applied")).toEqual([
        "run_key",
        "seq",
        "extension_id",
        "applied_at",
      ]);
    } finally {
      db.close();
    }
  });

  test("the registered maximum and the current schema are 81", () => {
    expect(maxRegisteredIndexedSchemaVersion()).toBe(81);
    expect(CURRENT_SCHEMA_VERSION).toBe(81);
  });
});
