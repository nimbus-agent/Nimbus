import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { maxRegisteredIndexedSchemaVersion, runIndexedSchemaMigrations } from "./runner.ts";

type ColRow = { name: string; type: string; notnull: number; pk: number };

function migrated(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  return db;
}

function insert(db: Database, fp: string, name: string, sha = "a".repeat(64)): void {
  db.run(
    `INSERT INTO workflow_import (signer_fingerprint, bundle_name, issued_at, bundle_sha256, steps_sha256,
       signer_pubkey, author_label, workflow_id, imported_at, approval_audit_id)
     VALUES (?, ?, 1, ?, ?, 'k', NULL, 'w', 1, 1)`,
    [fp, name, sha, sha],
  );
}

describe("V101 migration - signed workflow import provenance", () => {
  test("a V100 database gains one empty table and the constant agrees", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 100);
      expect(
        db.query("SELECT name FROM sqlite_master WHERE name = 'workflow_import'").get(),
      ).toBeNull();
      runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
      expect(db.query("SELECT count(*) AS n FROM workflow_import").get()).toEqual({ n: 0 });
      expect(CURRENT_SCHEMA_VERSION).toBe(maxRegisteredIndexedSchemaVersion());
      expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(101);
    } finally {
      db.close();
    }
  });

  test("columns, the composite primary key and the two indexes are exactly the design", () => {
    const db = migrated();
    try {
      const cols = db.query("PRAGMA table_info(workflow_import)").all() as ColRow[];
      expect(cols.map((c) => `${c.name}:${c.type}:${c.notnull}`)).toEqual([
        "signer_fingerprint:TEXT:1",
        "bundle_name:TEXT:1",
        "issued_at:INTEGER:1",
        "bundle_sha256:TEXT:1",
        "steps_sha256:TEXT:1",
        "signer_pubkey:TEXT:1",
        "author_label:TEXT:0",
        "workflow_id:TEXT:1",
        "imported_at:INTEGER:1",
        "import_count:INTEGER:1",
        "approval_audit_id:INTEGER:1",
      ]);
      expect(cols.filter((c) => c.pk > 0).map((c) => c.name)).toEqual([
        "signer_fingerprint",
        "bundle_name",
      ]);
      const idx = (db.query("PRAGMA index_list(workflow_import)").all() as { name: string }[]).map(
        (r) => r.name,
      );
      expect(idx).toContain("workflow_import_workflow");
      expect(idx).toContain("workflow_import_name");
      expect((db.query("PRAGMA foreign_key_list(workflow_import)").all() as unknown[]).length).toBe(
        0,
      );
    } finally {
      db.close();
    }
  });

  test("the CHECKs reject a short fingerprint or hash and the primary key rejects a duplicate", () => {
    const db = migrated();
    try {
      expect(() => insert(db, "short", "n")).toThrow();
      expect(() => insert(db, "f".repeat(32), "n", "short")).toThrow();
      insert(db, "f".repeat(32), "n");
      expect(() => insert(db, "f".repeat(32), "n")).toThrow();
      insert(db, "e".repeat(32), "n");
    } finally {
      db.close();
    }
  });

  test("re-running the step is harmless (IF NOT EXISTS only)", () => {
    const db = migrated();
    try {
      insert(db, "f".repeat(32), "n");
      db.run("PRAGMA user_version = 100");
      runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
      expect(db.query("SELECT count(*) AS n FROM workflow_import").get()).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });
});
