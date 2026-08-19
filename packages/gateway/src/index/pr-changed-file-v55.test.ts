import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { PR_CHANGED_FILE_V55_SQL } from "./pr-changed-file-v55-sql.ts";

/** Minimal parent tables so the foreign keys have something to reference. */
function makeDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`CREATE TABLE item (id TEXT PRIMARY KEY, service TEXT NOT NULL,
    type TEXT NOT NULL, external_id TEXT NOT NULL)`);
  db.exec(`CREATE TABLE graph_entity (id TEXT PRIMARY KEY, type TEXT NOT NULL)`);
  db.exec(PR_CHANGED_FILE_V55_SQL);
  db.exec(`INSERT INTO item VALUES ('github:o/r#1','github','pr','o/r#1')`);
  db.exec(`INSERT INTO graph_entity VALUES ('ent-1','source_file')`);
  return db;
}

describe("V55 pr changed-file schema", () => {
  test("stores a row and reads it back", () => {
    const db = makeDb();
    db.exec(`INSERT INTO pr_changed_file (item_id, repo_full, path, status, local_file_id)
             VALUES ('github:o/r#1','o/r','src/a.ts','modified','ent-1')`);
    const row = db.query("SELECT path, local_file_id FROM pr_changed_file").get() as {
      path: string;
      local_file_id: string | null;
    };
    expect(row.path).toBe("src/a.ts");
    expect(row.local_file_id).toBe("ent-1");
    db.close();
  });

  // The cascade is the whole pruning story. If foreign_keys were off, or the
  // REFERENCES clause were missing, this passes silently as a no-op delete —
  // so assert the ROWS ARE GONE, not merely that the delete ran.
  test("deleting the PR item cascades BOTH tables", () => {
    const db = makeDb();
    db.exec(`INSERT INTO pr_changed_file (item_id, repo_full, path, status)
             VALUES ('github:o/r#1','o/r','src/a.ts','modified')`);
    db.exec(`INSERT INTO pr_files_state (item_id, fetched_at_ms, api_file_count, stored_count)
             VALUES ('github:o/r#1', 1, 1, 1)`);
    db.exec("DELETE FROM item WHERE id = 'github:o/r#1'");
    const files = db.query("SELECT COUNT(*) AS c FROM pr_changed_file").get() as { c: number };
    const state = db.query("SELECT COUNT(*) AS c FROM pr_files_state").get() as { c: number };
    expect(files.c).toBe(0);
    expect(state.c).toBe(0);
    db.close();
  });

  // `reapOrphansForRoot` really deletes degree-0 source_file entities, so this
  // path is live, not theoretical. SET NULL returns the row to the same state
  // it has for a repo that was never cloned.
  test("deleting the graph entity nulls local_file_id and KEEPS the row", () => {
    const db = makeDb();
    db.exec(`INSERT INTO pr_changed_file (item_id, repo_full, path, status, local_file_id)
             VALUES ('github:o/r#1','o/r','src/a.ts','modified','ent-1')`);
    db.exec("DELETE FROM graph_entity WHERE id = 'ent-1'");
    const row = db.query("SELECT path, local_file_id FROM pr_changed_file").get() as {
      path: string;
      local_file_id: string | null;
    } | null;
    expect(row?.path).toBe("src/a.ts");
    expect(row?.local_file_id).toBeNull();
    db.close();
  });

  test("re-applying the DDL is idempotent", () => {
    const db = makeDb();
    db.exec(PR_CHANGED_FILE_V55_SQL);
    db.exec(PR_CHANGED_FILE_V55_SQL);
    const t = db
      .query(
        `SELECT COUNT(*) AS c FROM sqlite_master
          WHERE type='table' AND name IN ('pr_changed_file','pr_files_state')`,
      )
      .get() as { c: number };
    expect(t.c).toBe(2);
    db.close();
  });

  test("(item_id, path) is unique — a rename's two rows do not collide", () => {
    const db = makeDb();
    db.exec(`INSERT INTO pr_changed_file (item_id, repo_full, path, status, counterpart_path)
             VALUES ('github:o/r#1','o/r','src/a.ts','renamed','tests/a.ts')`);
    db.exec(`INSERT INTO pr_changed_file (item_id, repo_full, path, status, counterpart_path)
             VALUES ('github:o/r#1','o/r','tests/a.ts','renamed','src/a.ts')`);
    const c = db.query("SELECT COUNT(*) AS c FROM pr_changed_file").get() as { c: number };
    expect(c.c).toBe(2);
    expect(() =>
      db.exec(`INSERT INTO pr_changed_file (item_id, repo_full, path, status)
               VALUES ('github:o/r#1','o/r','src/a.ts','modified')`),
    ).toThrow();
    db.close();
  });
});
