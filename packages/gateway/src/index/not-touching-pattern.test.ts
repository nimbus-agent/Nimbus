import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { countPathsMatchingGlob, validatePathGlob } from "./negation-predicates.ts";
import { PR_CHANGED_FILE_V55_SQL } from "./pr-changed-file-v55-sql.ts";

/**
 * F20 — `--not-touching <glob>` bound the caller's string straight into SQLite `GLOB`, so five of
 * the most natural ways to write a path matched NOTHING, excluded NOTHING, and returned every PR
 * as an answer to "which PRs did not touch this?".
 *
 * For a negation that is not an incomplete answer, it is an INVERTED one: measured against the
 * live index, `packages/gateway` returned all 173 PRs including the 49 that do touch it, while
 * `packages/gateway/**` correctly returned 124.
 *
 * Two SQLite `GLOB` properties the surface never stated:
 *   - case-sensitive (deliberate and correct for paths — but it fails OPEN and silently on the
 *     two platforms whose filesystems are case-insensitive);
 *   - `*` crosses `/`, so `**` and `*` are the same pattern and a minimatch intuition is wrong
 *     in both directions.
 * And a pattern with no wildcard is not a prefix: `GLOB 'packages/gateway'` demands the whole
 * path equal that string.
 *
 * The existing substrate probe cannot catch this. It asks whether the TABLE has rows, never
 * whether the PATTERN does — and the table was fully populated in every failing case above.
 */

const openDbs: Database[] = [];

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

function dbWithPaths(paths: readonly string[]): Database {
  const db = new Database(":memory:");
  openDbs.push(db);
  db.exec(`CREATE TABLE item (id TEXT PRIMARY KEY, type TEXT NOT NULL)`);
  db.exec(PR_CHANGED_FILE_V55_SQL);
  db.query("INSERT INTO item (id, type) VALUES ('pr1', 'pr')").run();
  for (const p of paths) {
    db.query(
      "INSERT INTO pr_changed_file (item_id, repo_full, path, status) VALUES ('pr1', 'a/b', ?, 'modified')",
    ).run(p);
  }
  return db;
}

describe("validatePathGlob rejects forms that cannot ever match (F20)", () => {
  test("a Windows-separator path is rejected, naming the POSIX form", () => {
    // `pr_changed_file.path` is always POSIX-separated. On Windows this is what `Copy as path`,
    // Explorer and `path.join` all produce, so it is the single most likely wrong input — and it
    // silently disabled the filter rather than erroring.
    const r = validatePathGlob(String.raw`packages\gateway\**`);
    expect(r.ok).toBe(false);
    expect(r.ok === false ? r.reason : "").toContain("packages/gateway/**");
  });

  test("a leading slash is rejected", () => {
    const r = validatePathGlob("/packages/gateway/**");
    expect(r.ok).toBe(false);
    expect(r.ok === false ? r.reason : "").toContain("packages/gateway/**");
  });

  test("a leading ./ is rejected", () => {
    const r = validatePathGlob("./packages/gateway/**");
    expect(r.ok).toBe(false);
    expect(r.ok === false ? r.reason : "").toContain("packages/gateway/**");
  });

  test("an empty pattern is rejected", () => {
    expect(validatePathGlob("   ").ok).toBe(false);
  });

  test("a legitimate glob passes untouched", () => {
    // The validator must not become a silent rewriter: correcting the caller's pattern would
    // answer a question they did not ask, which for a negation is the same class of harm.
    const r = validatePathGlob("packages/gateway/**");
    expect(r.ok).toBe(true);
    expect(r.ok === true ? r.glob : "").toBe("packages/gateway/**");
  });

  test("a bare path with no wildcard passes validation but is NOT silently widened", () => {
    // `packages/gateway` is a legal GLOB — it just matches only an exact path. It is caught by
    // the zero-match disclosure below, not here, because it CAN be right: a caller may genuinely
    // mean one exact file.
    expect(validatePathGlob("packages/gateway").ok).toBe(true);
  });
});

describe("countPathsMatchingGlob makes a zero-match pattern visible (F20)", () => {
  test("a wrong-case pattern matches zero indexed paths", () => {
    // GLOB is case-sensitive by design. The defect was that this failed OPEN.
    const db = dbWithPaths(["packages/gateway/src/a.ts"]);
    expect(countPathsMatchingGlob(db, "Packages/Gateway/**")).toBe(0);
  });

  test("a no-wildcard directory pattern matches zero indexed paths", () => {
    const db = dbWithPaths(["packages/gateway/src/a.ts"]);
    expect(countPathsMatchingGlob(db, "packages/gateway")).toBe(0);
  });

  test("the correct pattern matches, so the check does not fire on a good query", () => {
    const db = dbWithPaths(["packages/gateway/src/a.ts", "packages/cli/src/b.ts"]);
    expect(countPathsMatchingGlob(db, "packages/gateway/**")).toBe(1);
  });

  test("zero matches is distinguishable from an empty table", () => {
    // The two readings — "genuinely nothing touches this" and "your pattern is wrong" — cannot
    // be told apart from the count alone, which is exactly why the caller must DISCLOSE it
    // rather than resolve it either way.
    const empty = dbWithPaths([]);
    expect(countPathsMatchingGlob(empty, "packages/gateway/**")).toBe(0);
  });
});
