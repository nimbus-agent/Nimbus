import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  assertWithinDataDir,
  dataDir,
  filterDataModels,
  getDataModel,
  jsKind,
  listDataModels,
  parquetColumnsFromMetadata,
  parseCsvHeader,
  parseJsonColumns,
  parseJsonlColumns,
} from "../src/profile.ts";

describe("pure parsers", () => {
  test("parseCsvHeader / parseJsonlColumns / parseJsonColumns / parquetColumnsFromMetadata", () => {
    expect(parseCsvHeader("a,b,c").map((c) => c.name)).toEqual(["a", "b", "c"]);
    expect(parseJsonlColumns('{"x":1,"y":"v"}')).toEqual([
      { name: "x", type: "number" },
      { name: "y", type: "string" },
    ]);
    expect(parseJsonColumns([{ a: 1 }, { a: 2 }]).rowCountEstimate).toBe(2);
    expect(
      parquetColumnsFromMetadata({ schema: [{ name: "id", type: "INT32" }], num_rows: 7n }),
    ).toEqual({
      columns: [{ name: "id", type: "INT32" }],
      rowCountEstimate: 7,
    });
    expect(jsKind([1])).toBe("array");
  });
});

describe("dataDir / assertWithinDataDir", () => {
  test("dataDir throws when DATAPROFILE_DIR is unset", () => {
    const prev = process.env["DATAPROFILE_DIR"];
    delete process.env["DATAPROFILE_DIR"];
    expect(() => dataDir()).toThrow();
    if (prev !== undefined) {
      process.env["DATAPROFILE_DIR"] = prev;
    }
  });
  test("assertWithinDataDir allows descendants, rejects escapes", () => {
    const root = resolve("/tmp/data");
    expect(() => assertWithinDataDir(join(root, "a.csv"), root)).not.toThrow();
    expect(() => assertWithinDataDir(resolve(root, "..", "x.csv"), root)).toThrow();
  });
});

describe("filterDataModels", () => {
  const models = [
    {
      relativePath: "a/orders.csv",
      format: "csv" as const,
      columns: [{ name: "order_id", type: null }],
      columnCount: 1,
      rowCountEstimate: 3,
      sizeBytes: 1,
    },
    {
      relativePath: "b/users.json",
      format: "json" as const,
      columns: [{ name: "email", type: "string" }],
      columnCount: 1,
      rowCountEstimate: null,
      sizeBytes: 1,
    },
  ];
  test("matches path / format / column names; empty query returns all", () => {
    expect(filterDataModels(models, "orders")).toHaveLength(1);
    expect(filterDataModels(models, "json")).toHaveLength(1);
    expect(filterDataModels(models, "email")).toHaveLength(1);
    expect(filterDataModels(models, "  ")).toHaveLength(2);
    expect(filterDataModels(models, "nope")).toHaveLength(0);
  });
});

describe("listDataModels / getDataModel (real fs, no parquet)", () => {
  let dir: string;
  let prev: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nimbus-dataprofile-"));
    prev = process.env["DATAPROFILE_DIR"];
    process.env["DATAPROFILE_DIR"] = dir;
  });
  afterEach(async () => {
    if (prev === undefined) {
      delete process.env["DATAPROFILE_DIR"];
    } else {
      process.env["DATAPROFILE_DIR"] = prev;
    }
    await rm(dir, { recursive: true, force: true });
  });

  test("profiles csv/jsonl/json into schema-only models, never reading cell values", async () => {
    await writeFile(join(dir, "people.csv"), "id,name\n1,Ada\n2,Bob\n", "utf8");
    await writeFile(join(dir, "log.jsonl"), '{"ts":1,"msg":"hi"}\n{"ts":2,"msg":"yo"}\n', "utf8");
    await writeFile(join(dir, "rows.json"), JSON.stringify([{ k: "v" }, { k: "w" }]), "utf8");

    const models = await listDataModels();
    expect(models.map((m) => m.relativePath).sort((a, b) => a.localeCompare(b))).toEqual([
      "log.jsonl",
      "people.csv",
      "rows.json",
    ]);

    const csv = models.find((m) => m.relativePath === "people.csv")!;
    expect(csv.columns.map((c) => c.name)).toEqual(["id", "name"]);
    expect(csv.rowCountEstimate).toBe(2); // excludes header

    const serialized = JSON.stringify(models);
    expect(serialized).not.toContain("Ada");
    expect(serialized).not.toContain('"hi"');
  });

  test("getDataModel reads one file; null for unknown / non-data; rejects escape", async () => {
    await writeFile(join(dir, "one.csv"), "x,y\n", "utf8");
    expect((await getDataModel("one.csv"))?.columns.map((c) => c.name)).toEqual(["x", "y"]);
    expect(await getDataModel("missing.csv")).toBeNull();
    expect(await getDataModel("notes.txt")).toBeNull();
    await expect(getDataModel("../escape.csv")).rejects.toThrow();
  });

  test("profiles parquet via an injected footer reader (no real parquet bytes needed)", async () => {
    await writeFile(join(dir, "orders.parquet"), "not-real", "utf8");
    const fakeReader = async (path: string) =>
      path.endsWith("orders.parquet")
        ? { schema: [{ name: "root" }, { name: "id", type: "INT64" }], num_rows: 9n }
        : null;

    const all = await listDataModels(fakeReader);
    const pq = all.find((m) => m.relativePath === "orders.parquet");
    expect(pq?.columns).toEqual([{ name: "id", type: "INT64" }]);
    expect(pq?.rowCountEstimate).toBe(9);

    const one = await getDataModel("orders.parquet", fakeReader);
    expect(one?.format).toBe("parquet");

    // A reader returning null → the parquet file is skipped.
    const none = await getDataModel("orders.parquet", async () => null);
    expect(none).toBeNull();
  });
});
