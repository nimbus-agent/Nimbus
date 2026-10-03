import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { collectFiles } from "./collect-files.ts";

const isSql = (name: string): boolean => name.toLowerCase().endsWith(".sql");

describe("collectFiles", () => {
  let root: string;

  /** Write an empty file at `rel` (a path under `root`), creating its directories. */
  function touch(...rel: string[]): string {
    const full = join(root, ...rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, "");
    return full;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "nimbus-collect-files-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("collects the accepted regular files at every level, as full paths", async () => {
    const expected = [touch("a.sql"), touch("sub", "b.SQL"), touch("sub", "deeper", "c.sql")];
    touch("notes.txt");
    touch("sub", "readme.md");

    const found = await collectFiles(root, { maxDepth: 12, maxFiles: 100, accept: isSql });

    expect(found.toSorted()).toEqual(expected.toSorted());
  });

  test("never collects a directory, even one whose name is accepted", async () => {
    mkdirSync(join(root, "looks-like.sql"));
    const file = touch("looks-like.sql", "inner.sql");

    expect(await collectFiles(root, { maxDepth: 12, maxFiles: 100, accept: isSql })).toEqual([
      file,
    ]);
  });

  test("reads no directory deeper than maxDepth (the root is depth 0)", async () => {
    const top = touch("top.sql");
    const level1 = touch("one", "level1.sql");
    touch("one", "two", "level2.sql");

    const depth0 = await collectFiles(root, { maxDepth: 0, maxFiles: 100, accept: isSql });
    expect(depth0).toEqual([top]);

    const depth1 = await collectFiles(root, { maxDepth: 1, maxFiles: 100, accept: isSql });
    expect(depth1.toSorted()).toEqual([level1, top].toSorted());
  });

  test("stops at maxFiles, across directories", async () => {
    for (const name of ["a.sql", "b.sql", "c.sql"]) touch(name);
    for (const name of ["d.sql", "e.sql", "f.sql"]) touch("sub", name);

    const found = await collectFiles(root, { maxDepth: 12, maxFiles: 4, accept: isSql });

    expect(found).toHaveLength(4);
    expect(new Set(found).size).toBe(4);
    for (const path of found) expect(isSql(path)).toBe(true);
  });

  test("a maxFiles of 0 reads nothing", async () => {
    touch("a.sql");

    expect(await collectFiles(root, { maxDepth: 12, maxFiles: 0, accept: isSql })).toEqual([]);
  });

  test("an unreadable root yields nothing rather than throwing", async () => {
    const missing = join(root, "does-not-exist");

    expect(await collectFiles(missing, { maxDepth: 12, maxFiles: 100, accept: isSql })).toEqual([]);
  });
});
