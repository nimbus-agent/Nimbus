import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { CO_OWNED_ENTITY_TYPES, readEntityMetadata } from "../graph/relationship-graph.ts";
import { ENTITY_METADATA_V54_SQL } from "./entity-metadata-v54-sql.ts";

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE graph_entity (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, external_id TEXT NOT NULL,
    label TEXT NOT NULL, service TEXT, metadata TEXT,
    UNIQUE(type, external_id))`);
  return db;
}

function insert(db: Database, type: string, externalId: string, metadata: string | null): void {
  db.run(
    "INSERT INTO graph_entity (id, type, external_id, label, metadata) VALUES (?, ?, ?, 'x', ?)",
    [`${type}:${externalId}`, type, externalId, metadata],
  );
}

function raw(db: Database, externalId: string): string | null {
  const row = db
    .query("SELECT metadata FROM graph_entity WHERE external_id = ?")
    .get(externalId) as { metadata: string | null } | null;
  return row?.metadata ?? null;
}

describe("V54 entity metadata namespacing migration", () => {
  test("wraps flat metadata on a co-owned type under `ownership`", () => {
    const db = makeDb();
    insert(db, "source_file", "f1", JSON.stringify({ ownerCount: 3, truncated: false }));
    db.run(ENTITY_METADATA_V54_SQL);
    expect(readEntityMetadata(raw(db, "f1"), "ownership")).toEqual({
      ownerCount: 3,
      truncated: false,
    });
  });

  // Spelled out rather than read from `CO_OWNED_ENTITY_TYPES` on purpose: this pins what V54
  // migrated on the day it shipped. A type added to that constant later needs its own
  // migration, and importing the constant here would turn that gap green instead of red.
  test("wraps every co-owned type in V54's filter", () => {
    const db = makeDb();
    const types = ["source_file", "directory", "person", "service", "workspace", "repo"];
    for (const t of types) {
      insert(db, t, `e-${t}`, JSON.stringify({ ownerCount: 1 }));
    }
    db.run(ENTITY_METADATA_V54_SQL);
    for (const t of types) {
      expect(readEntityMetadata(raw(db, `e-${t}`), "ownership")).toEqual({ ownerCount: 1 });
    }
  });

  // V54's filter and `CO_OWNED_ENTITY_TYPES` agree TODAY. Asserted rather than assumed,
  // because a co-owned type absent from the filter would silently keep flat metadata that
  // `readEntityMetadata` then reports as `null` — the exact symptom the no-flat-fallback
  // decision exists to surface. If a later commit widens the constant, fix it by adding a
  // migration and updating this expectation, not by importing the constant above.
  test("V54's type filter matches CO_OWNED_ENTITY_TYPES as of this commit", () => {
    expect([...CO_OWNED_ENTITY_TYPES].sort((a, b) => a.localeCompare(b))).toEqual([
      "directory",
      "person",
      "repo",
      "service",
      "source_file",
      "workspace",
    ]);
    for (const t of CO_OWNED_ENTITY_TYPES) {
      expect(ENTITY_METADATA_V54_SQL).toContain(`'${t}'`);
    }
  });

  test("leaves NON-co-owned types flat", () => {
    const db = makeDb();
    insert(db, "pr", "pr1", JSON.stringify({ repo: "acme/web" }));
    db.run(ENTITY_METADATA_V54_SQL);
    expect(raw(db, "pr1")).toBe(JSON.stringify({ repo: "acme/web" }));
  });

  test("is idempotent — running twice does not double-wrap", () => {
    const db = makeDb();
    insert(db, "source_file", "f2", JSON.stringify({ ownerCount: 2 }));
    db.run(ENTITY_METADATA_V54_SQL);
    const once = raw(db, "f2");
    db.run(ENTITY_METADATA_V54_SQL);
    expect(raw(db, "f2")).toBe(once);
    expect(readEntityMetadata(raw(db, "f2"), "ownership")).toEqual({ ownerCount: 2 });
  });

  // Spec § 5.3: the check is "no top-level key is a KNOWN WRITER", not merely
  // "$.ownership is absent" — otherwise a symbols-only row would be re-wrapped.
  test("does not re-wrap a row already namespaced under `symbols` only", () => {
    const db = makeDb();
    insert(db, "source_file", "f3", JSON.stringify({ symbols: { symbolCount: 4 } }));
    db.run(ENTITY_METADATA_V54_SQL);
    expect(readEntityMetadata(raw(db, "f3"), "symbols")).toEqual({ symbolCount: 4 });
    expect(readEntityMetadata(raw(db, "f3"), "ownership")).toBeNull();
  });

  test("leaves NULL metadata alone", () => {
    const db = makeDb();
    insert(db, "source_file", "f4", null);
    db.run(ENTITY_METADATA_V54_SQL);
    expect(raw(db, "f4")).toBeNull();
  });

  test("leaves malformed metadata alone and does not raise", () => {
    const db = makeDb();
    insert(db, "source_file", "f5", "{not json");
    expect(() => db.run(ENTITY_METADATA_V54_SQL)).not.toThrow();
    expect(raw(db, "f5")).toBe("{not json");
  });

  test("leaves a JSON scalar or array alone", () => {
    const db = makeDb();
    insert(db, "source_file", "f6", "42");
    insert(db, "source_file", "f7", "[1,2]");
    db.run(ENTITY_METADATA_V54_SQL);
    expect(raw(db, "f6")).toBe("42");
    expect(raw(db, "f7")).toBe("[1,2]");
  });
});
