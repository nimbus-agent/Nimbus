/**
 * Migration-runner branches `runner.test.ts` only reaches on the happy path. Its sqlite-vec tests
 * assert "runs regardless of availability" on a machine where the extension DOES load, so the
 * no-vec variants of V6, V10 and V30 never ran; and its V3→V4 test starts from the current V3
 * schema, which already has `person.linked`, so the conditional ALTER never fired. These drive
 * both for real: a connection that cannot load sqlite-vec, and a legacy V3 `person` table.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { resetVecLoadFailureForTest, tryLoadSqliteVec } from "../sqlite-vec-load.ts";
import {
  maxRegisteredIndexedSchemaVersion,
  readIndexedUserVersion,
  runIndexedSchemaMigrations,
} from "./runner.ts";

const VEC_AVAILABLE = ((): boolean => {
  const probe = new Database(":memory:");
  const ok = tryLoadSqliteVec(probe);
  probe.close();
  resetVecLoadFailureForTest();
  return ok;
})();

afterEach(() => {
  // tryLoadSqliteVec records the failure (and its warn de-dup) in module state.
  resetVecLoadFailureForTest();
});

function tableNames(db: Database): string[] {
  return (
    db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((r) => r.name);
}

function ledgerDescription(db: Database, version: number): string | null {
  const row = db
    .query("SELECT description FROM _schema_migrations WHERE version = ?")
    .get(version) as { description: string } | null;
  return row?.description ?? null;
}

describe("a connection that cannot load sqlite-vec", () => {
  test("migrates to the newest schema on the no-vec variants, and the ledger says so", () => {
    const db = new Database(":memory:");
    db.loadExtension = (): void => {
      throw new Error("extension loading is disabled for this connection");
    };
    try {
      const newest = maxRegisteredIndexedSchemaVersion();
      runIndexedSchemaMigrations(db, newest);
      expect(readIndexedUserVersion(db)).toBe(newest);

      expect(ledgerDescription(db, 6)).toBe("embedding_chunk (sqlite-vec unavailable)");
      expect(ledgerDescription(db, 30)).toBe("vec_items_1536 (sqlite-vec unavailable, T6 PR 3)");
      const tables = tableNames(db);
      // The plain tables the vector layer hangs off still exist...
      expect(tables).toContain("embedding_chunk");
      expect(tables).toContain("extension");
      expect(tables).toContain("session_memory");
      // ...and no vec0 virtual table was created, at either dimension.
      expect(tables.filter((t) => t.startsWith("vec_items"))).toEqual([]);
    } finally {
      db.close();
    }
  });

  test.skipIf(!VEC_AVAILABLE)(
    "control: a connection that CAN load it records the vec variants",
    () => {
      const db = new Database(":memory:");
      try {
        runIndexedSchemaMigrations(db, 30);
        expect(ledgerDescription(db, 6)).toBe("embedding_chunk + vec_items_384");
        expect(ledgerDescription(db, 30)).toBe(
          "vec_items_1536 + dim-aware delete triggers (T6 PR 3)",
        );
        expect(tableNames(db)).toContain("vec_items_384");
        expect(tableNames(db)).toContain("vec_items_1536");
      } finally {
        db.close();
      }
    },
  );
});

describe("V3 → V4 on a legacy person table", () => {
  test("adds person.linked when it is missing, and unlinks only people with no usable email", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 3);
      // The shape a V3 database had before `linked` was folded into the V3 schema itself.
      db.exec("DROP TABLE person");
      db.exec(`CREATE TABLE person (
        id TEXT PRIMARY KEY, display_name TEXT, canonical_email TEXT UNIQUE,
        github_login TEXT, gitlab_login TEXT, slack_handle TEXT, linear_member_id TEXT,
        jira_account_id TEXT, notion_user_id TEXT, metadata TEXT
      )`);
      db.exec(`INSERT INTO person (id, canonical_email) VALUES
        ('p-mail', 'dev@acme.example'), ('p-none', NULL), ('p-blank', '   ')`);
      const columnsBefore = (db.query("PRAGMA table_info(person)").all() as { name: string }[]).map(
        (c) => c.name,
      );
      expect(columnsBefore).not.toContain("linked");

      runIndexedSchemaMigrations(db, 4);

      expect(readIndexedUserVersion(db)).toBe(4);
      expect(db.query("SELECT id, linked FROM person ORDER BY id").all()).toEqual([
        { id: "p-blank", linked: 0 },
        { id: "p-mail", linked: 1 },
        { id: "p-none", linked: 0 },
      ]);
      expect(ledgerDescription(db, 4)).toBe("person.linked column");
    } finally {
      db.close();
    }
  });
});
