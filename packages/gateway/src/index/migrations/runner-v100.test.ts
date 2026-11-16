import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { INCIDENT_RECORD_V100_SQL } from "../incident-record-v100-sql.ts";
import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { maxRegisteredIndexedSchemaVersion, runIndexedSchemaMigrations } from "./runner.ts";

type ColRow = { name: string; type: string; notnull: number };

function migrated(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  return db;
}

function insertRecord(
  db: Database,
  over: { id?: string; trigger?: string; opened?: number | null; status?: string; json?: string },
): void {
  db.run(
    `INSERT INTO incident_record (id, trigger_item_id, trigger_service, trigger_type, service, title,
       severity, opened_at_ms, status, version, assembled_at_ms, checked_at_ms, record_sha256,
       cited_services, record_json, markdown)
     VALUES (?, ?, 'pagerduty', 'incident', NULL, 't', NULL, ?, ?, 1, 10, 10, 'h', '[]', ?, 'm')`,
    [
      over.id ?? "inc_a",
      over.trigger ?? "pagerduty:a",
      over.opened === undefined ? 100 : over.opened,
      over.status ?? "open",
      over.json ?? "{}",
    ],
  );
}

function plan(db: Database, sql: string, ...params: (number | string)[]): string {
  const stmt = db.prepare(`EXPLAIN QUERY PLAN ${sql}`);
  try {
    return (stmt.all(...params) as { detail: string }[]).map((r) => r.detail).join("\n");
  } finally {
    stmt.finalize();
  }
}

describe("V100 migration - incident records", () => {
  test("a V99 database gains two empty tables and the constant agrees", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION - 1);
      runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
      expect(db.query("SELECT count(*) AS n FROM incident_record").get()).toEqual({ n: 0 });
      expect(db.query("SELECT count(*) AS n FROM incident_record_version").get()).toEqual({ n: 0 });
      expect(db.query("PRAGMA user_version").get()).toEqual({
        user_version: CURRENT_SCHEMA_VERSION,
      });
      expect(CURRENT_SCHEMA_VERSION).toBe(maxRegisteredIndexedSchemaVersion());
      expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(100);
    } finally {
      db.close();
    }
  });

  test("columns, types, nullability and the five indexes are exactly the design", () => {
    const db = migrated();
    try {
      const cols = db.query("PRAGMA table_info(incident_record)").all() as ColRow[];
      expect(cols.map((c) => `${c.name}:${c.type}:${c.notnull}`)).toEqual([
        "id:TEXT:0",
        "trigger_item_id:TEXT:1",
        "trigger_service:TEXT:1",
        "trigger_type:TEXT:1",
        "service:TEXT:0",
        "title:TEXT:1",
        "severity:TEXT:0",
        "opened_at_ms:INTEGER:0",
        "status:TEXT:1",
        "version:INTEGER:1",
        "assembled_at_ms:INTEGER:1",
        "checked_at_ms:INTEGER:1",
        "record_sha256:TEXT:1",
        "cited_services:TEXT:1",
        "record_json:TEXT:1",
        "markdown:TEXT:1",
      ]);
      const vcols = db.query("PRAGMA table_info(incident_record_version)").all() as ColRow[];
      expect(vcols.map((c) => c.name)).toEqual([
        "record_id",
        "version",
        "assembled_at_ms",
        "record_sha256",
        "cited_services",
        "record_json",
      ]);
      const idx = (db.query("PRAGMA index_list(incident_record)").all() as { name: string }[]).map(
        (r) => r.name,
      );
      for (const n of [
        "incident_record_open",
        "incident_record_service",
        "incident_record_opened",
        "incident_record_retention",
        "incident_record_checked",
      ]) {
        expect(idx).toContain(n);
      }
    } finally {
      db.close();
    }
  });

  test("the CHECKs and UNIQUE constraints reject bad rows", () => {
    const db = migrated();
    try {
      expect(() => insertRecord(db, { status: "x" })).toThrow();
      insertRecord(db, { json: "a".repeat(131072) });
      db.run("DELETE FROM incident_record");
      expect(() => insertRecord(db, { json: "a".repeat(131073) })).toThrow();
      insertRecord(db, {});
      expect(() => insertRecord(db, { id: "inc_b" })).toThrow(); // trigger_item_id UNIQUE
      expect(() => db.run("UPDATE incident_record SET version = 0 WHERE id = 'inc_a'")).toThrow();
      const v = (n: number) =>
        db.run(
          `INSERT INTO incident_record_version (record_id, version, assembled_at_ms, record_sha256, cited_services, record_json)
           VALUES ('inc_a', ?, 1, 'h', '[]', '{}')`,
          [n],
        );
      expect(() => v(0)).toThrow();
      v(1);
      expect(() => v(1)).toThrow();
    } finally {
      db.close();
    }
  });

  test("deleting a record cascades to its versions with foreign keys on", () => {
    const db = migrated();
    try {
      db.run("PRAGMA foreign_keys = ON");
      insertRecord(db, {});
      db.run("INSERT INTO incident_record_version VALUES ('inc_a', 1, 1, 'h', '[]', '{}')");
      db.run("DELETE FROM incident_record");
      expect(db.query("SELECT count(*) AS n FROM incident_record_version").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  test("the list and engine queries are served by their indexes with no temp B-tree", () => {
    const cases: [string, string, string[]][] = [
      [
        "SELECT id FROM incident_record WHERE status = 'open' ORDER BY opened_at_ms DESC, id",
        "incident_record_open",
        [],
      ],
      [
        "SELECT id FROM incident_record WHERE service = ? ORDER BY opened_at_ms DESC, id",
        "incident_record_service",
        ["s"],
      ],
      [
        "SELECT id FROM incident_record ORDER BY opened_at_ms DESC, id LIMIT 50",
        "incident_record_opened",
        [],
      ],
      [
        "SELECT id FROM incident_record WHERE status = 'open' ORDER BY checked_at_ms ASC, id ASC LIMIT 20",
        "incident_record_checked",
        [],
      ],
    ];
    for (const [sql, name, p] of cases) {
      const db = migrated();
      try {
        const text = plan(db, sql, ...p);
        expect(text).toContain(name);
        expect(text).not.toContain("USE TEMP B-TREE FOR ORDER BY");
        // Red-prove: without the index the plan cannot mention it.
        db.run(`DROP INDEX ${name}`);
        expect(plan(db, sql, ...p)).not.toContain(name);
      } finally {
        db.close();
      }
    }
  });

  test("the two-arm retention predicate uses incident_record_retention; COALESCE does not", () => {
    const db = migrated();
    try {
      const two =
        "DELETE FROM incident_record WHERE id IN (SELECT id FROM incident_record WHERE (opened_at_ms IS NOT NULL AND opened_at_ms < ?1) OR (opened_at_ms IS NULL AND assembled_at_ms < ?1) LIMIT 500)";
      const coalesce =
        "DELETE FROM incident_record WHERE id IN (SELECT id FROM incident_record WHERE COALESCE(opened_at_ms, assembled_at_ms) < ?1 LIMIT 500)";
      expect(plan(db, two, 5)).toContain("incident_record_retention");
      expect(plan(db, coalesce, 5)).not.toContain("incident_record_retention");
      db.run("DROP INDEX incident_record_retention");
      expect(plan(db, two, 5)).not.toContain("incident_record_retention");
    } finally {
      db.close();
    }
  });

  test("NULL sorts last under ORDER BY opened_at_ms DESC, id", () => {
    const db = migrated();
    try {
      insertRecord(db, { id: "inc_n", trigger: "t:n", opened: null });
      insertRecord(db, { id: "inc_1", trigger: "t:1", opened: 5 });
      insertRecord(db, { id: "inc_2", trigger: "t:2", opened: 9 });
      const rows = db
        .query("SELECT id FROM incident_record ORDER BY opened_at_ms DESC, id")
        .all() as { id: string }[];
      expect(rows.map((r) => r.id)).toEqual(["inc_2", "inc_1", "inc_n"]);
    } finally {
      db.close();
    }
  });

  test("re-running the DDL is idempotent", () => {
    const db = migrated();
    try {
      for (const stmt of INCIDENT_RECORD_V100_SQL) db.run(stmt);
      expect(db.query("SELECT count(*) AS n FROM incident_record").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });
});
