import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { V32_GIT_BLAME_LINE_SQL } from "../index/git-blame-line-v32-sql.ts";
import {
  lookupBlame,
  parseBlamePorcelain,
  pruneBlameForFile,
  upsertBlameLines,
} from "./blame-store.ts";

function db(): Database {
  const d = new Database(":memory:");
  d.exec(V32_GIT_BLAME_LINE_SQL);
  return d;
}

// Minimal --line-porcelain for two lines from one commit.
const PORCELAIN = [
  "1111111111111111111111111111111111111111 10 10 1",
  "author Ada Lovelace",
  "author-mail <ada@x.dev>",
  "author-time 1700000000",
  "author-tz +0000",
  "\tconst secret = 'x'",
  "1111111111111111111111111111111111111111 11 11 1",
  "\tmore code",
].join("\n");

describe("parseBlamePorcelain", () => {
  test("extracts sha/author/email/time per line", () => {
    const rows = parseBlamePorcelain(PORCELAIN);
    expect(rows).toEqual([
      {
        lineNo: 10,
        commitSha: "1111111111111111111111111111111111111111",
        authorName: "Ada Lovelace",
        authorEmail: "ada@x.dev",
        authorTimeMs: 1700000000000,
      },
      {
        lineNo: 11,
        commitSha: "1111111111111111111111111111111111111111",
        authorName: "Ada Lovelace",
        authorEmail: "ada@x.dev",
        authorTimeMs: 1700000000000,
      },
    ]);
  });
});

describe("upsertBlameLines + lookupBlame", () => {
  test("roundtrips a row and returns null for a miss", () => {
    const d = db();
    upsertBlameLines(d, "/repo", "src/x.ts", parseBlamePorcelain(PORCELAIN));
    const hit = lookupBlame(d, "/repo", "src/x.ts", 10);
    expect(hit?.commitSha).toBe("1111111111111111111111111111111111111111");
    expect(hit?.authorEmail).toBe("ada@x.dev");
    expect(lookupBlame(d, "/repo", "src/x.ts", 999)).toBeNull();
  });

  test("re-upsert replaces (no duplicate PK error)", () => {
    const d = db();
    const rows = parseBlamePorcelain(PORCELAIN);
    upsertBlameLines(d, "/repo", "src/x.ts", rows);
    upsertBlameLines(d, "/repo", "src/x.ts", rows);
    const n = d.query("SELECT COUNT(*) AS c FROM git_blame_line").get() as { c: number };
    expect(n.c).toBe(2);
  });
});

describe("pruneBlameForFile", () => {
  test("removes only the given file's rows", () => {
    const d = db();
    upsertBlameLines(d, "/repo", "a.ts", [
      {
        lineNo: 1,
        commitSha: "a".repeat(40),
        authorName: "x",
        authorEmail: "x@y",
        authorTimeMs: 1,
      },
    ]);
    upsertBlameLines(d, "/repo", "b.ts", [
      {
        lineNo: 1,
        commitSha: "b".repeat(40),
        authorName: "x",
        authorEmail: "x@y",
        authorTimeMs: 1,
      },
    ]);

    pruneBlameForFile(d, "/repo", "a.ts");

    expect(
      d.query("SELECT COUNT(*) AS c FROM git_blame_line WHERE file_path='a.ts'").get(),
    ).toEqual({ c: 0 });
    expect(
      d.query("SELECT COUNT(*) AS c FROM git_blame_line WHERE file_path='b.ts'").get(),
    ).toEqual({ c: 1 });
  });

  test("scopes the delete to the given repo_root", () => {
    const d = db();
    const rows = [
      {
        lineNo: 1,
        commitSha: "c".repeat(40),
        authorName: "x",
        authorEmail: "x@y",
        authorTimeMs: 1,
      },
    ];
    upsertBlameLines(d, "/repo-1", "a.ts", rows);
    upsertBlameLines(d, "/repo-2", "a.ts", rows);

    pruneBlameForFile(d, "/repo-1", "a.ts");

    expect(
      d.query("SELECT COUNT(*) AS c FROM git_blame_line WHERE repo_root='/repo-2'").get(),
    ).toEqual({ c: 1 });
  });
});
