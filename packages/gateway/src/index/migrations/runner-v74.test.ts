import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { builtinSourceEntries } from "../../sources/source-kinds.ts";
import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { SOURCE_CATCHUP_V74_SQL } from "../source-catchup-v74-sql.ts";
import { runIndexedSchemaMigrations } from "./runner.ts";

function addItem(db: Database, id: string, service: string, type: string): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
     VALUES (?, ?, ?, ?, 't', 1, 1)`,
    [id, service, type, `ext-${id}`],
  );
}

function addDecision(db: Database, id: string, sourceItemId: string): void {
  db.run(
    `INSERT INTO decision_record (id, source_item_id, status, cue_tier, cue_text, decided_at, updated_at)
     VALUES (?, ?, 'pending', 'weak', 'c', 1, 1)`,
    [id, sourceItemId],
  );
}

describe("V74 migration — source catch-up cursors and decision scored_kind", () => {
  test("CURRENT_SCHEMA_VERSION is at least 74", () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(74);
  });

  test("backfills scored_kind from the item's built-in kind; orphans and nimbus:* stay NULL", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 73);
      addItem(db, "i-jira", "jira", "issue");
      addItem(db, "i-notion", "notion", "page");
      addItem(db, "i-cap", "nimbus", "capture");
      addDecision(db, "d-jira", "i-jira");
      addDecision(db, "d-notion", "i-notion");
      addDecision(db, "d-orphan", "gone");
      addDecision(db, "d-cap", "i-cap");
      runIndexedSchemaMigrations(db, 74);
      const rows = db.query("SELECT id, scored_kind FROM decision_record ORDER BY id").all();
      expect(rows).toEqual([
        { id: "d-cap", scored_kind: null },
        { id: "d-jira", scored_kind: "ticket" },
        { id: "d-notion", scored_kind: "doc" },
        { id: "d-orphan", scored_kind: null },
      ]);
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 74 });
    } finally {
      db.close();
    }
  });

  test("source_catchup_state exists, is empty, and the CHECKs reject bad values", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 74);
      expect(db.query("SELECT COUNT(*) AS n FROM source_catchup_state").get()).toEqual({ n: 0 });
      expect(() =>
        db.run("INSERT INTO source_catchup_state (pass, service_type) VALUES ('x', 'a:b')"),
      ).toThrow(/CHECK/);
      db.run("INSERT INTO source_catchup_state (pass, service_type) VALUES ('decisions', 'a:b')");
      expect(() =>
        db.run("INSERT INTO source_catchup_state (pass, service_type) VALUES ('decisions', 'a:b')"),
      ).toThrow(/UNIQUE|PRIMARY/);
      addItem(db, "i1", "jira", "issue");
      addDecision(db, "d1", "i1");
      expect(() =>
        db.run("UPDATE decision_record SET scored_kind = 'wiki' WHERE id = 'd1'"),
      ).toThrow(/CHECK/);
    } finally {
      db.close();
    }
  });

  test("the frozen CASE keys equal builtinSourceEntries() today", () => {
    const pairs = [...SOURCE_CATCHUP_V74_SQL.matchAll(/WHEN '([^']+)' THEN '([^']+)'/g)].map(
      (m) => [m[1], m[2]],
    );
    expect(pairs).toEqual(builtinSourceEntries().map(([k, v]) => [k, v]));
  });
});
