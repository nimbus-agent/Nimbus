import { describe, expect, test } from "bun:test";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { mapBitbucketPrFiles, mapGithubPrFiles, mapGitlabMrFiles } from "./pr-file-mapping.ts";

// Fixtures are read and parsed, NOT imported with an import attribute. This repo uses zero
// `with { type: "json" }` imports; the established pattern is readFileSync + JSON.parse
// (`connectors/openapi-indexer-parsing.test.ts:8-12`). Do not "modernise" this.
const FIX = join(import.meta.dir, "../../test/fixtures/pr-files");
const loadFixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIX, name), "utf8")) as unknown;

const fixture = loadFixture("github-pull-files.json");

describe("mapGithubPrFiles", () => {
  test("a rename produces TWO rows, one per touched path", () => {
    const rows = mapGithubPrFiles(fixture);
    const renamed = rows.filter((r) => r.status === "renamed").map((r) => r.path);
    expect(renamed.sort()).toEqual(["src/moved.ts", "tests/moved.ts"]);
  });

  test("both halves of a rename point at each other", () => {
    const rows = mapGithubPrFiles(fixture);
    const to = rows.find((r) => r.path === "src/moved.ts");
    const from = rows.find((r) => r.path === "tests/moved.ts");
    expect(to?.counterpartPath).toBe("tests/moved.ts");
    expect(from?.counterpartPath).toBe("src/moved.ts");
  });

  test("a deletion produces exactly one row", () => {
    const rows = mapGithubPrFiles(fixture);
    expect(rows.filter((r) => r.path === "tests/gone.ts")).toHaveLength(1);
  });

  test("copied and changed normalise to modified", () => {
    const rows = mapGithubPrFiles(fixture);
    expect(rows.find((r) => r.path === "src/copied.ts")?.status).toBe("modified");
    expect(rows.find((r) => r.path === "src/changed.ts")?.status).toBe("modified");
    // The copied entry carries its own `previous_filename` (GitHub sets this for copies too, not
    // only renames). Pin that a copy stays ONE row: a regression that widened the rename branch to
    // fire on any present `previous_filename` would emit a second row for this source path, and
    // every assertion above would still pass.
    expect(rows.find((r) => r.path === "src/original.ts")).toBeUndefined();
    expect(rows.filter((r) => r.status === "renamed")).toHaveLength(2);
  });

  test("a non-array payload yields no rows rather than throwing", () => {
    expect(mapGithubPrFiles({ message: "Not Found" })).toEqual([]);
    expect(mapGithubPrFiles(null)).toEqual([]);
  });

  test("an entry missing filename is skipped, not defaulted", () => {
    expect(mapGithubPrFiles([{ status: "added" }, { filename: "ok.ts", status: "added" }])).toEqual(
      [{ path: "ok.ts", status: "added", counterpartPath: null }],
    );
  });
});

// Reuse the `loadFixture` helper already defined at the top of THIS SAME FILE by Task 3 — these
// tests are APPENDED to it, so the helper is already in scope. Do NOT import it, and do NOT export
// it: importing a `.test.ts` module re-executes its top-level `describe`/`test` calls, so a
// consumer that imported this helper would silently re-run all of Task 3's tests inside its own
// file (measured: 7 passes where 1 was expected). Also do not switch to an import attribute — this
// repo uses none.
const gitlabFixture = loadFixture("gitlab-mr-diffs.json");
const bitbucketFixture = loadFixture("bitbucket-pr-diffstat.json");

describe("mapGitlabMrFiles", () => {
  test("a rename produces TWO rows", () => {
    const rows = mapGitlabMrFiles(gitlabFixture);
    expect(
      rows
        .filter((r) => r.status === "renamed")
        .map((r) => r.path)
        .sort(),
    ).toEqual(["src/d.ts", "tests/d.ts"]);
  });

  test("the boolean flags map onto added / removed / modified", () => {
    const rows = mapGitlabMrFiles(gitlabFixture);
    expect(rows.find((r) => r.path === "src/b.ts")?.status).toBe("added");
    expect(rows.find((r) => r.path === "tests/c.ts")?.status).toBe("removed");
    expect(rows.find((r) => r.path === "src/a.ts")?.status).toBe("modified");
  });

  test("a non-array payload yields no rows", () => {
    expect(mapGitlabMrFiles({ error: "nope" })).toEqual([]);
  });
});

describe("mapBitbucketPrFiles", () => {
  test("reads the paginated values envelope", () => {
    expect(mapBitbucketPrFiles(bitbucketFixture).length).toBeGreaterThan(0);
  });

  test("a rename produces TWO rows", () => {
    const rows = mapBitbucketPrFiles(bitbucketFixture);
    expect(
      rows
        .filter((r) => r.status === "renamed")
        .map((r) => r.path)
        .sort(),
    ).toEqual(["src/d.ts", "tests/d.ts"]);
  });

  test("a null old/new side is skipped rather than yielding an empty path", () => {
    const rows = mapBitbucketPrFiles(bitbucketFixture);
    expect(rows.some((r) => r.path === "")).toBe(false);
    expect(rows.find((r) => r.path === "src/b.ts")?.status).toBe("added");
    expect(rows.find((r) => r.path === "tests/c.ts")?.status).toBe("removed");
  });

  test("a payload with no values array yields no rows", () => {
    expect(mapBitbucketPrFiles({})).toEqual([]);
  });
});
