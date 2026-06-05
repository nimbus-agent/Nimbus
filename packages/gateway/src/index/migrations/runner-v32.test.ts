import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "./runner.ts";

describe("V32 migration — git_blame_line table", () => {
  test("creates the table with the expected columns", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 32);
    const cols = db.query("PRAGMA table_info(git_blame_line)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name).sort((a, b) => a.localeCompare(b))).toEqual(
      [
        "author_email",
        "author_name",
        "author_time_ms",
        "commit_sha",
        "file_path",
        "line_no",
        "repo_root",
      ].sort((a, b) => a.localeCompare(b)),
    );
  });

  test("primary key is (repo_root, file_path, line_no)", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 32);
    db.run(
      "INSERT INTO git_blame_line (repo_root, file_path, line_no, commit_sha) VALUES (?, ?, ?, ?)",
      ["/repo", "src/x.ts", 1, "abc"],
    );
    expect(() =>
      db.run(
        "INSERT INTO git_blame_line (repo_root, file_path, line_no, commit_sha) VALUES (?, ?, ?, ?)",
        ["/repo", "src/x.ts", 1, "def"],
      ),
    ).toThrow(/UNIQUE|PRIMARY/);
  });

  test("V32 records an applied row in _schema_migrations", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 32);
    const row = db
      .query("SELECT version, description FROM _schema_migrations WHERE version = 32")
      .get() as { version: number; description: string } | null;
    expect(row?.version).toBe(32);
    expect(row?.description).toContain("git_blame_line");
  });
});
