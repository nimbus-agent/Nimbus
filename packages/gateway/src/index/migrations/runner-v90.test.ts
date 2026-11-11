import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { maxRegisteredIndexedSchemaVersion, runIndexedSchemaMigrations } from "./runner.ts";

describe("V90 migration — approval learning", () => {
  test("a V89 database gains the two tables, empty, and the schema constant agrees", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 89);
      runIndexedSchemaMigrations(db, 90);
      expect(db.query("SELECT count(*) AS n FROM standing_streak").get()).toEqual({ n: 0 });
      expect(db.query("SELECT count(*) AS n FROM standing_suggestion").get()).toEqual({ n: 0 });
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 90 });
      expect(CURRENT_SCHEMA_VERSION).toBe(maxRegisteredIndexedSchemaVersion());
    } finally {
      db.close();
    }
  });

  test("the status CHECK refuses an unknown value, and only one open suggestion per key", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 90);
      const ins = (id: string, status: string) =>
        db.run(
          `INSERT INTO standing_suggestion (id, created_at, workflow_id, workflow_sha256, step_index, streak, status)
           VALUES (?, 1, 'w', 'h', 0, 5, ?)`,
          [id, status],
        );
      expect(() => ins("a", "bogus")).toThrow();
      ins("b", "open");
      expect(() => ins("c", "open")).toThrow();
      ins("d", "dismissed");
      ins("e", "dismissed");
    } finally {
      db.close();
    }
  });
});
