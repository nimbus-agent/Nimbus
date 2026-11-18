import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { maxRegisteredIndexedSchemaVersion, runIndexedSchemaMigrations } from "./runner.ts";

type ColRow = { name: string };

function migrated(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  return db;
}

function insertFinding(db: Database, id: string, cleared: number | null, detail = "{}"): void {
  db.run(
    `INSERT INTO incident_finding (id, kind, finding_key, service, detail_json, opened_at_ms, last_seen_at_ms, cleared_at_ms)
     VALUES (?, 'radar', 'deploy:checkout', 'checkout', ?, 1, 1, ?)`,
    [id, detail, cleared],
  );
}

describe("V103 incident_finding and anomaly_baseline (Phase 10 IC8)", () => {
  test("the schema constant and the registered chain reach 103", () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(103);
    expect(maxRegisteredIndexedSchemaVersion()).toBeGreaterThanOrEqual(103);
  });

  test("a fresh database has both tables with the declared columns", () => {
    const db = migrated();
    const f = db.query("PRAGMA table_info(incident_finding)").all() as ColRow[];
    expect(f.map((c) => c.name)).toEqual([
      "id",
      "kind",
      "finding_key",
      "service",
      "detail_json",
      "opened_at_ms",
      "last_seen_at_ms",
      "cleared_at_ms",
    ]);
    const b = db.query("PRAGMA table_info(anomaly_baseline)").all() as ColRow[];
    expect(b.map((c) => c.name)).toEqual(["series_id", "bucket_start_ms", "value"]);
    db.close();
  });

  test("an upgrade from V102 reaches 103 and keeps the V102 tables", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 102);
    runIndexedSchemaMigrations(db, 103);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 103 });
    const names = (
      db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toContain("incident_proposal");
    expect(names).toContain("incident_finding");
    expect(names).toContain("anomaly_baseline");
    db.close();
  });

  test("at most one OPEN finding per (kind, key); cleared ones may repeat", () => {
    const db = migrated();
    insertFinding(db, "fnd_1", 5);
    insertFinding(db, "fnd_2", 6);
    insertFinding(db, "fnd_3", null);
    expect(() => insertFinding(db, "fnd_4", null)).toThrow();
    db.close();
  });

  test("CHECKs refuse an unknown kind and an oversized detail", () => {
    const db = migrated();
    expect(() =>
      db.run(
        `INSERT INTO incident_finding (id, kind, finding_key, detail_json, opened_at_ms, last_seen_at_ms)
         VALUES ('x', 'guess', 'k', '{}', 1, 1)`,
      ),
    ).toThrow();
    expect(() => insertFinding(db, "fnd_big", 1, "x".repeat(4097))).toThrow();
    db.close();
  });

  test("a baseline bucket is unique per series and hour", () => {
    const db = migrated();
    db.run("INSERT INTO anomaly_baseline VALUES ('index:errors:a', 0, 1)");
    expect(() => db.run("INSERT INTO anomaly_baseline VALUES ('index:errors:a', 0, 2)")).toThrow();
    db.close();
  });
});
