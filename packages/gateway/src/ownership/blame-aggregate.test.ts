import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import {
  aggregateBlameForRoot,
  compileIgnoreGlobs,
  isIgnoredPath,
  lineWeight,
  matchesAnyCompiledGlob,
} from "./blame-aggregate.ts";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const ROOT = "/repo/alpha";

function db(): Database {
  const d = new Database(":memory:");
  runIndexedSchemaMigrations(d, CURRENT_SCHEMA_VERSION);
  return d;
}

function addLine(
  d: Database,
  file: string,
  lineNo: number,
  email: string,
  name: string,
  ageDays: number,
): void {
  d.run(
    `INSERT INTO git_blame_line
       (repo_root, file_path, line_no, commit_sha, author_name, author_email, author_time_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [ROOT, file, lineNo, `sha${String(lineNo)}`, name, email, NOW - ageDays * DAY],
  );
}

describe("lineWeight", () => {
  test("a line authored right now weighs exactly 1", () => {
    expect(lineWeight(NOW, NOW, 365 * DAY)).toBeCloseTo(1, 10);
  });

  test("a line exactly one half-life old weighs exactly 0.5", () => {
    expect(lineWeight(NOW - 365 * DAY, NOW, 365 * DAY)).toBeCloseTo(0.5, 10);
  });

  test("two half-lives weigh 0.25", () => {
    expect(lineWeight(NOW - 730 * DAY, NOW, 365 * DAY)).toBeCloseTo(0.25, 10);
  });

  test("a future timestamp is clamped to weight 1, never amplified", () => {
    expect(lineWeight(NOW + 1000 * DAY, NOW, 365 * DAY)).toBeCloseTo(1, 10);
  });
});

// These target the COMPILED pair, because that is what production runs:
// `aggregateBlameForRoot` uses `compileIgnoreGlobs` + `matchesAnyCompiledGlob`.
// `isIgnoredPath` is a thin convenience over them and is covered by the
// equivalence test alone — testing only the wrapper would leave the hot path
// unverified.
describe("glob exclusion", () => {
  test("matches lock files and nested generated trees", () => {
    const compiled = compileIgnoreGlobs(["**/package-lock.json", "**/dist/**", "**/*.min.js"]);
    expect(matchesAnyCompiledGlob("package-lock.json", compiled)).toBe(true);
    expect(matchesAnyCompiledGlob("packages/app/package-lock.json", compiled)).toBe(true);
    expect(matchesAnyCompiledGlob("packages/app/dist/index.js", compiled)).toBe(true);
    expect(matchesAnyCompiledGlob("a/b/c.min.js", compiled)).toBe(true);
    expect(matchesAnyCompiledGlob("packages/app/src/index.ts", compiled)).toBe(false);
  });

  test("compiling an empty list yields a matcher that matches nothing", () => {
    expect(matchesAnyCompiledGlob("package-lock.json", compileIgnoreGlobs([]))).toBe(false);
  });

  test("a path containing glob metacharacters does not corrupt matching", () => {
    const compiled = compileIgnoreGlobs(["**/dist/**"]);
    expect(matchesAnyCompiledGlob("src/weird[1]/a{b}.ts", compiled)).toBe(false);
  });

  test("isIgnoredPath is exactly the compiled pair composed", () => {
    const globs = ["**/dist/**", "**/*.min.js", "**/package-lock.json"];
    const compiled = compileIgnoreGlobs(globs);
    for (const p of ["a/dist/b.js", "a/b.min.js", "package-lock.json", "a/b.ts", ""]) {
      expect(isIgnoredPath(p, globs)).toBe(matchesAnyCompiledGlob(p, compiled));
    }
  });
});

describe("aggregateBlameForRoot", () => {
  let d: Database;
  beforeEach(() => {
    d = db();
  });

  test("splits a file's weight between two authors by recency", () => {
    addLine(d, "src/a.ts", 1, "old@x.com", "Old", 730); // weight 0.25
    addLine(d, "src/a.ts", 2, "new@x.com", "New", 0); //   weight 1.0
    const agg = aggregateBlameForRoot(d, ROOT, {
      nowMs: NOW,
      halfLifeDays: 365,
      ignoreGlobs: [],
    });
    expect(agg.filesCovered).toBe(1);
    const byEmail = new Map(agg.rows.map((r) => [r.authorEmail, r]));
    expect(byEmail.get("old@x.com")?.weightedLines).toBeCloseTo(0.25, 10);
    expect(byEmail.get("new@x.com")?.weightedLines).toBeCloseTo(1.0, 10);
    expect(byEmail.get("old@x.com")?.rawLines).toBe(1);
  });

  test("normalizes author email case", () => {
    addLine(d, "src/a.ts", 1, "Mixed@Case.COM", "M", 0);
    const agg = aggregateBlameForRoot(d, ROOT, {
      nowMs: NOW,
      halfLifeDays: 365,
      ignoreGlobs: [],
    });
    expect(agg.rows[0]?.authorEmail).toBe("mixed@case.com");
  });

  test("EXCLUDES an ignored file from rows AND counts it", () => {
    addLine(d, "src/a.ts", 1, "a@x.com", "A", 0);
    addLine(d, "package-lock.json", 1, "bot@x.com", "B", 0);
    const agg = aggregateBlameForRoot(d, ROOT, {
      nowMs: NOW,
      halfLifeDays: 365,
      ignoreGlobs: ["**/package-lock.json"],
    });
    expect(agg.filesCovered).toBe(1);
    expect(agg.filesExcluded).toBe(1);
    expect(agg.rows.every((r) => r.filePath !== "package-lock.json")).toBe(true);
  });

  test("only reads the requested root", () => {
    addLine(d, "src/a.ts", 1, "a@x.com", "A", 0);
    d.run(
      `INSERT INTO git_blame_line
         (repo_root, file_path, line_no, commit_sha, author_name, author_email, author_time_ms)
       VALUES ('/repo/beta', 'src/b.ts', 1, 'sha', 'B', 'b@x.com', ?)`,
      [NOW],
    );
    const agg = aggregateBlameForRoot(d, ROOT, {
      nowMs: NOW,
      halfLifeDays: 365,
      ignoreGlobs: [],
    });
    expect(agg.rows.every((r) => r.authorEmail === "a@x.com")).toBe(true);
  });

  test("lastTouchedMs is the newest of the author's lines", () => {
    addLine(d, "src/a.ts", 1, "a@x.com", "A", 100);
    addLine(d, "src/a.ts", 2, "a@x.com", "A", 5);
    const agg = aggregateBlameForRoot(d, ROOT, {
      nowMs: NOW,
      halfLifeDays: 365,
      ignoreGlobs: [],
    });
    expect(agg.rows[0]?.lastTouchedMs).toBe(NOW - 5 * DAY);
  });

  test("a NULL author_email is skipped rather than grouped under empty string", () => {
    d.run(
      `INSERT INTO git_blame_line
         (repo_root, file_path, line_no, commit_sha, author_name, author_email, author_time_ms)
       VALUES (?, 'src/a.ts', 1, 'sha', 'A', NULL, ?)`,
      [ROOT, NOW],
    );
    const agg = aggregateBlameForRoot(d, ROOT, {
      nowMs: NOW,
      halfLifeDays: 365,
      ignoreGlobs: [],
    });
    expect(agg.rows).toHaveLength(0);
  });

  test("a NULL author_time_ms is treated as maximally old, not as weight 1", () => {
    d.run(
      `INSERT INTO git_blame_line
         (repo_root, file_path, line_no, commit_sha, author_name, author_email, author_time_ms)
       VALUES (?, 'src/a.ts', 1, 'sha', 'A', 'a@x.com', NULL)`,
      [ROOT],
    );
    const agg = aggregateBlameForRoot(d, ROOT, {
      nowMs: NOW,
      halfLifeDays: 365,
      ignoreGlobs: [],
    });
    expect(agg.rows[0]?.weightedLines).toBeCloseTo(0, 6);
  });
});
