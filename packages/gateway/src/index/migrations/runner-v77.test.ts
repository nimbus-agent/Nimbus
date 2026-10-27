import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { runIndexedSchemaMigrations } from "./runner.ts";

function withDb(fn: (db: Database) => void): void {
  const db = new Database(":memory:");
  try {
    fn(db);
  } finally {
    db.close();
  }
}

function insertStatement(db: Database, id: string, kind: string, source: string): void {
  db.run(
    `INSERT INTO trust_statement (statement_id, kind, statement_json, signer_fingerprint, signer_role,
       source, publisher_id, key_fingerprint, first_seen_at)
     VALUES (?, ?, '{}', 'f', ?, ?, 'acme', 'k', 7)`,
    [id, kind, kind === "publisher.verified" ? "nimbus" : "publisher", source],
  );
}

describe("V77 migration — trust_statement_source", () => {
  test("CURRENT_SCHEMA_VERSION is at least 77", () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(77);
  });

  test("each existing statement's first source is backfilled; current verifications are not", () => {
    withDb((db) => {
      runIndexedSchemaMigrations(db, 76);
      insertStatement(db, "s1", "key.revoke", "registry:community");
      insertStatement(db, "s2", "key.rotate", "feed");
      insertStatement(db, "s3", "publisher.verified", "feed");
      runIndexedSchemaMigrations(db, 77);
      expect(
        db
          .query(
            "SELECT statement_id, source, first_seen_at FROM trust_statement_source ORDER BY statement_id",
          )
          .all(),
      ).toEqual([
        { statement_id: "s1", source: "registry:community", first_seen_at: 7 },
        { statement_id: "s2", source: "feed", first_seen_at: 7 },
      ]);
    });
  });

  test("one row per (statement, source), and only known source shapes", () => {
    withDb((db) => {
      runIndexedSchemaMigrations(db, 77);
      const add = (id: string, source: string) =>
        db.run(
          "INSERT INTO trust_statement_source (statement_id, source, first_seen_at) VALUES (?, ?, 1)",
          [id, source],
        );
      add("s1", "registry:a");
      add("s1", "registry:b");
      add("s1", "snapshot");
      expect(() => add("s1", "registry:a")).toThrow();
      expect(() => add("s2", "somewhere")).toThrow();
      expect(() => add("s2", "registry:")).toThrow();
    });
  });
});
