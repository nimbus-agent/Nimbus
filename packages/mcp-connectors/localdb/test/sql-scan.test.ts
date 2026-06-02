import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  assertWithinScriptsDir,
  baseTitle,
  filterSavedQueries,
  getSavedQuery,
  type SavedQuery,
  scanSavedQueries,
  scriptsDir,
} from "../src/sql-scan.ts";

describe("baseTitle", () => {
  test("strips the .sql extension from the basename", () => {
    expect(baseTitle("a/b/report.sql")).toBe("report");
    expect(baseTitle("x.SQL")).toBe("x");
  });
});

describe("scriptsDir", () => {
  test("throws when LOCALDB_SCRIPTS_DIR is unset", () => {
    const prev = process.env["LOCALDB_SCRIPTS_DIR"];
    delete process.env["LOCALDB_SCRIPTS_DIR"];
    expect(() => scriptsDir()).toThrow();
    if (prev !== undefined) {
      process.env["LOCALDB_SCRIPTS_DIR"] = prev;
    }
  });
});

describe("assertWithinScriptsDir", () => {
  test("allows the dir itself and descendants, rejects escapes", () => {
    const root = resolve("/tmp/scripts");
    expect(() => assertWithinScriptsDir(root, root)).not.toThrow();
    expect(() => assertWithinScriptsDir(join(root, "a", "b.sql"), root)).not.toThrow();
    expect(() => assertWithinScriptsDir(resolve(root, "..", "secret.sql"), root)).toThrow();
  });
});

describe("filterSavedQueries", () => {
  const queries: SavedQuery[] = [
    {
      relativePath: "orders.sql",
      title: "orders",
      sizeBytes: 1,
      lineCount: 1,
      preview: "SELECT * FROM orders",
    },
    {
      relativePath: "rev/q.sql",
      title: "q",
      sizeBytes: 1,
      lineCount: 1,
      preview: "SELECT revenue",
    },
  ];
  test("matches title / path / SQL text (case-insensitive); empty query returns all", () => {
    expect(filterSavedQueries(queries, "orders")).toHaveLength(1);
    expect(filterSavedQueries(queries, "rev/")).toHaveLength(1);
    expect(filterSavedQueries(queries, "REVENUE")).toHaveLength(1);
    expect(filterSavedQueries(queries, "  ")).toHaveLength(2);
    expect(filterSavedQueries(queries, "nope")).toHaveLength(0);
  });
});

describe("scanSavedQueries / getSavedQuery (real fs)", () => {
  let dir: string;
  let prev: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nimbus-localdb-scan-"));
    prev = process.env["LOCALDB_SCRIPTS_DIR"];
    process.env["LOCALDB_SCRIPTS_DIR"] = dir;
  });
  afterEach(async () => {
    if (prev === undefined) {
      delete process.env["LOCALDB_SCRIPTS_DIR"];
    } else {
      process.env["LOCALDB_SCRIPTS_DIR"] = prev;
    }
    await rm(dir, { recursive: true, force: true });
  });

  test("scans .sql files recursively, skips non-sql and empty files", async () => {
    await writeFile(join(dir, "a.sql"), "SELECT 1;\nSELECT 2;", "utf8");
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "sub", "b.sql"), "SELECT * FROM t", "utf8");
    await writeFile(join(dir, "readme.md"), "nope", "utf8");
    await writeFile(join(dir, "empty.sql"), "  ", "utf8");

    const scanned = await scanSavedQueries();
    expect(scanned.map((q) => q.title).sort()).toEqual(["a", "b"]);
    const a = scanned.find((q) => q.title === "a")!;
    expect(a.lineCount).toBe(2);
    expect(a.preview).toContain("SELECT 1;");
  });

  test("getSavedQuery reads one file and returns null for an unknown / escaping path", async () => {
    await writeFile(join(dir, "one.sql"), "SELECT 1;", "utf8");
    const hit = await getSavedQuery("one.sql");
    expect(hit?.preview).toContain("SELECT 1;");
    expect(await getSavedQuery("missing.sql")).toBeNull();
    await expect(getSavedQuery("../escape.sql")).rejects.toThrow();
  });
});
