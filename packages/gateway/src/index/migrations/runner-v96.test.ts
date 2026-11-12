import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { maxRegisteredIndexedSchemaVersion, runIndexedSchemaMigrations } from "./runner.ts";

function relationTypes(db: Database): string[] {
  return (db.query("SELECT name FROM graph_relation_type").all() as { name: string }[]).map(
    (r) => r.name,
  );
}

describe("V96 migration - alert sources, deploy edge types, regraph marker (Phase 10 IC2)", () => {
  test("a V95 database gains the relation types, the sha index and the marker", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION - 1);
      expect(relationTypes(db)).not.toContain("deployed");
      expect(relationTypes(db)).not.toContain("built_by");
      runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
      expect(relationTypes(db)).toContain("deployed");
      expect(relationTypes(db)).toContain("built_by");
      const idx = db.query("PRAGMA index_list(deployment_items)").all() as { name: string }[];
      expect(idx.map((i) => i.name)).toContain("idx_deployment_items_sha");
      expect(db.query("SELECT value FROM _meta WHERE key = 'regraph_pending_ic2'").get()).toEqual({
        value: "1",
      });
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: CURRENT_SCHEMA_VERSION });
      expect(CURRENT_SCHEMA_VERSION).toBe(maxRegisteredIndexedSchemaVersion());
      expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(96);
    } finally {
      db.close();
    }
  });

  test("the marker is INSERT OR IGNORE: an existing value is not overwritten and a rerun is idempotent", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
      db.run("UPDATE _meta SET value = 'kept' WHERE key = 'regraph_pending_ic2'");
      db.run("PRAGMA user_version = 95");
      runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
      expect(db.query("SELECT value FROM _meta WHERE key = 'regraph_pending_ic2'").get()).toEqual({
        value: "kept",
      });
      expect(relationTypes(db).filter((n) => n === "deployed")).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("a graph relation of the new type is accepted only after the step (the foreign key)", () => {
    const db = new Database(":memory:");
    try {
      db.run("PRAGMA foreign_keys = ON");
      runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION - 1);
      db.run(
        "INSERT INTO graph_entity (id, type, external_id, label, metadata) VALUES ('a','deployment','a','a','{}'), ('b','commit','b','b','{}')",
      );
      const insert = (): void => {
        db.run(
          "INSERT INTO graph_relation (from_id, to_id, type, metadata, created_at) VALUES ('a','b','deployed','{}',1)",
        );
      };
      expect(insert).toThrow();
      runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
      expect(insert).not.toThrow();
    } finally {
      db.close();
    }
  });

  test("a bare-sha probe uses idx_deployment_items_sha", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
      const plan = db
        .query("EXPLAIN QUERY PLAN SELECT id FROM deployment_items WHERE sha IN (?, ?)")
        .all("abc1234", "abc12345") as { detail: string }[];
      expect(plan.map((p) => p.detail).join("\n")).toContain("idx_deployment_items_sha");
    } finally {
      db.close();
    }
  });
});
