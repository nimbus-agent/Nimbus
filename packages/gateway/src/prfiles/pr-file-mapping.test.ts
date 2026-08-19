import { describe, expect, test } from "bun:test";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { mapGithubPrFiles } from "./pr-file-mapping.ts";

// Fixtures are read and parsed, NOT imported with an import attribute. This repo uses zero
// `with { type: "json" }` imports; the established pattern is readFileSync + JSON.parse
// (`connectors/openapi-indexer-parsing.test.ts:8-12`). Do not "modernise" this.
const FIX = join(import.meta.dir, "../../test/fixtures/pr-files");
export const loadFixture = (name: string): unknown =>
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
