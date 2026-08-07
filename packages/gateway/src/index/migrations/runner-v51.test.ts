import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { runIndexedSchemaMigrations } from "./runner.ts";

function freshMigratedDb(): Database {
  const db = new Database(":memory:");
  // Hardcoded to 51 (not CURRENT_SCHEMA_VERSION) — this file tests the V51 step in isolation, so it
  // must stay valid as later steps (e.g. V52) land and bump the production ceiling.
  runIndexedSchemaMigrations(db, 51);
  return db;
}

describe("V51 ownership migration", () => {
  test("schema version reaches 51", () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(51);
    const db = freshMigratedDb();
    const row = db.query("PRAGMA user_version").get() as { user_version: number };
    expect(row.user_version).toBe(51);
    db.close();
  });

  test("seeds exactly the three ownership relation types", () => {
    const db = freshMigratedDb();
    const names = (
      db
        .query(
          "SELECT name FROM graph_relation_type WHERE name IN ('owns','contains','tracks_remote') ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toEqual(["contains", "owns", "tracks_remote"]);
    db.close();
  });

  test("creates ownership_pass_state with its full column set", () => {
    const db = freshMigratedDb();
    const cols = (
      db.query("PRAGMA table_info(ownership_pass_state)").all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).toEqual([
      "id",
      "last_pass_at",
      "last_duration_ms",
      "roots_total",
      "roots_covered",
      "roots_with_remote",
      "files_covered",
      "files_excluded",
      "services_bound",
      "owners_emitted",
      "entities_reaped",
    ]);
    db.close();
  });

  test("ownership_pass_state is single-row by construction", () => {
    const db = freshMigratedDb();
    db.run("INSERT INTO ownership_pass_state (id) VALUES (1)");
    expect(() => db.run("INSERT INTO ownership_pass_state (id) VALUES (2)")).toThrow();
    db.close();
  });

  test("re-running the migration on an already-migrated db is a no-op", () => {
    const db = freshMigratedDb();
    runIndexedSchemaMigrations(db, 51);
    const row = db.query("PRAGMA user_version").get() as { user_version: number };
    expect(row.user_version).toBe(51);
    db.close();
  });
});
