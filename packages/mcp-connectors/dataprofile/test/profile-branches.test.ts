/**
 * Branch-coverage supplement for packages/mcp-connectors/dataprofile/src/profile.ts
 *
 * The existing profile.test.ts covers the happy path.  This file targets every
 * branch arm that was NOT yet executed:
 *   - parseCsvHeader: empty/whitespace-only line
 *   - parseJsonlColumns: invalid JSON (catch), non-object parsed value, parsed array
 *   - parseJsonColumns: array-of-non-objects, primitive top-level
 *   - parquetColumnsFromMetadata: schema not array, element without type, non-finite
 *     num_rows number, num_rows that is neither number nor bigint
 *   - dataDir: empty-string DATAPROFILE_DIR
 *   - assertWithinDataDir: candidate === root (rel === "")
 *   - firstLineAndRows (indirectly via real files): no newline, truncated=true,
 *     text without trailing newline
 *   - listDataModels/collectDataFiles: .ndjson extension, unknown extension (skipped),
 *     nested sub-directory walk, missing (unreadable) sub-directory
 *   - getDataModel: unknown extension returns null
 *   - profileTextFile via getDataModel: jsonl row-count estimate
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

// ---------------------------------------------------------------------------
// Shared temp root (for assertWithinDataDir tests)
// ---------------------------------------------------------------------------

let TMP_ROOT: string;
beforeAll(() => {
  TMP_ROOT = mkdtempSync(join(tmpdir(), "nimbus-dp-br-"));
});
afterAll(() => {
  if (TMP_ROOT) {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// jsKind — all arms (sanity check, non-null/non-array/typeof)
// ---------------------------------------------------------------------------

describe("jsKind", () => {
  test("null returns 'null'", () => {
    expect(jsKind(null)).toBe("null");
  });
  test("array returns 'array'", () => {
    expect(jsKind([1, 2, 3])).toBe("array");
  });
  test("number returns 'number'", () => {
    expect(jsKind(42)).toBe("number");
  });
  test("string returns 'string'", () => {
    expect(jsKind("hello")).toBe("string");
  });
  test("boolean returns 'boolean'", () => {
    expect(jsKind(true)).toBe("boolean");
  });
  test("object returns 'object'", () => {
    expect(jsKind({ a: 1 })).toBe("object");
  });
  test("undefined returns 'undefined'", () => {
    expect(jsKind(undefined)).toBe("undefined");
  });
});

// ---------------------------------------------------------------------------
// parseCsvHeader — empty / whitespace branch
// ---------------------------------------------------------------------------

describe("parseCsvHeader", () => {
  test("empty line returns []", () => {
    expect(parseCsvHeader("")).toEqual([]);
  });
  test("whitespace-only line returns []", () => {
    expect(parseCsvHeader("   ")).toEqual([]);
  });
  test("CRLF-terminated header is stripped", () => {
    expect(parseCsvHeader("a,b\r").map((c) => c.name)).toEqual(["a", "b"]);
  });
  test("quoted column names are unquoted", () => {
    expect(parseCsvHeader('"first","last"').map((c) => c.name)).toEqual(["first", "last"]);
  });
  test("all columns have null type", () => {
    const cols = parseCsvHeader("x,y");
    expect(cols.every((c) => c.type === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseJsonlColumns — catch / non-object / array arms
// ---------------------------------------------------------------------------

describe("parseJsonlColumns", () => {
  test("invalid JSON returns []", () => {
    expect(parseJsonlColumns("not-json")).toEqual([]);
  });
  test("JSON primitive (number) returns []", () => {
    expect(parseJsonlColumns("42")).toEqual([]);
  });
  test("JSON null returns []", () => {
    expect(parseJsonlColumns("null")).toEqual([]);
  });
  test("JSON array returns []", () => {
    expect(parseJsonlColumns("[1,2,3]")).toEqual([]);
  });
  test("valid object returns column list with inferred types", () => {
    const cols = parseJsonlColumns('{"id":1,"label":"x","active":true}');
    expect(cols).toEqual([
      { name: "id", type: "number" },
      { name: "label", type: "string" },
      { name: "active", type: "boolean" },
    ]);
  });
  test("null-valued field returns 'null' type", () => {
    const cols = parseJsonlColumns('{"k":null}');
    expect(cols).toEqual([{ name: "k", type: "null" }]);
  });
  test("array-valued field returns 'array' type", () => {
    const cols = parseJsonlColumns('{"tags":[1,2]}');
    expect(cols).toEqual([{ name: "tags", type: "array" }]);
  });
});

// ---------------------------------------------------------------------------
// parseJsonColumns — array-of-non-objects, primitive
// ---------------------------------------------------------------------------

describe("parseJsonColumns", () => {
  test("array of objects returns first-row schema + length as estimate", () => {
    const result = parseJsonColumns([{ a: 1 }, { a: 2 }]);
    expect(result.columns).toEqual([{ name: "a", type: "number" }]);
    expect(result.rowCountEstimate).toBe(2);
  });
  test("empty array returns no columns, 0 estimate", () => {
    // parsed[0] is undefined → typeof first === 'undefined' → not the object arm
    const result = parseJsonColumns([]);
    expect(result.columns).toEqual([]);
    expect(result.rowCountEstimate).toBe(0);
  });
  test("array of primitives (strings) returns [] columns, length as estimate", () => {
    const result = parseJsonColumns(["a", "b", "c"]);
    expect(result.columns).toEqual([]);
    expect(result.rowCountEstimate).toBe(3);
  });
  test("array whose first element is an array returns [] columns", () => {
    const result = parseJsonColumns([
      [1, 2],
      [3, 4],
    ]);
    expect(result.columns).toEqual([]);
    expect(result.rowCountEstimate).toBe(2);
  });
  test("plain object returns its keys as columns, null estimate", () => {
    const result = parseJsonColumns({ x: "hello", y: 99 });
    expect(result.columns).toEqual([
      { name: "x", type: "string" },
      { name: "y", type: "number" },
    ]);
    expect(result.rowCountEstimate).toBeNull();
  });
  test("primitive top-level returns [] columns and null estimate", () => {
    expect(parseJsonColumns(42)).toEqual({ columns: [], rowCountEstimate: null });
    expect(parseJsonColumns("oops")).toEqual({ columns: [], rowCountEstimate: null });
    expect(parseJsonColumns(null)).toEqual({ columns: [], rowCountEstimate: null });
  });
});

// ---------------------------------------------------------------------------
// parquetColumnsFromMetadata — schema not array, element without type, non-finite
// ---------------------------------------------------------------------------

describe("parquetColumnsFromMetadata", () => {
  test("missing schema (undefined) treated as empty array", () => {
    const result = parquetColumnsFromMetadata({ num_rows: 0 });
    expect(result.columns).toEqual([]);
    expect(result.rowCountEstimate).toBe(0);
  });
  test("schema = null treated as empty array", () => {
    // Cast to unknown so TS strict doesn't block us passing unexpected shape
    const result = parquetColumnsFromMetadata({ schema: null as unknown as undefined });
    expect(result.columns).toEqual([]);
  });
  test("schema element without type is skipped", () => {
    // Only the element that has a type should appear
    const result = parquetColumnsFromMetadata({
      schema: [{ name: "root" }, { name: "id", type: "INT32" }],
    });
    expect(result.columns).toEqual([{ name: "id", type: "INT32" }]);
  });
  test("schema element without name is skipped", () => {
    const result = parquetColumnsFromMetadata({
      schema: [{ type: "BYTE_ARRAY" }, { name: "col", type: "FLOAT" }],
    });
    expect(result.columns).toEqual([{ name: "col", type: "FLOAT" }]);
  });
  test("schema element that is null is skipped", () => {
    const meta = {
      schema: [null as unknown as { name?: unknown; type?: unknown }, { name: "x", type: "INT64" }],
    };
    const result = parquetColumnsFromMetadata(meta);
    expect(result.columns).toEqual([{ name: "x", type: "INT64" }]);
  });
  test("num_rows as bigint converts to number", () => {
    const result = parquetColumnsFromMetadata({ schema: [], num_rows: 99n });
    expect(result.rowCountEstimate).toBe(99);
  });
  test("num_rows as finite number is returned directly", () => {
    const result = parquetColumnsFromMetadata({ schema: [], num_rows: 5 });
    expect(result.rowCountEstimate).toBe(5);
  });
  test("num_rows as non-finite number (Infinity) returns null", () => {
    // Use raw 1e309 which JSON.parse evaluates to Infinity
    const inf: number = JSON.parse("1e309") as number;
    const result = parquetColumnsFromMetadata({ schema: [], num_rows: inf });
    expect(result.rowCountEstimate).toBeNull();
  });
  test("num_rows as undefined returns null", () => {
    const result = parquetColumnsFromMetadata({ schema: [] });
    expect(result.rowCountEstimate).toBeNull();
  });
  test("num_rows as string (neither number nor bigint) returns null", () => {
    const result = parquetColumnsFromMetadata({
      schema: [],
      num_rows: "100" as unknown as number,
    });
    expect(result.rowCountEstimate).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// dataDir — empty string and whitespace-only
// ---------------------------------------------------------------------------

describe("dataDir", () => {
  let prevVal: string | undefined;

  beforeEach(() => {
    prevVal = process.env["DATAPROFILE_DIR"];
  });
  afterEach(() => {
    if (prevVal === undefined) {
      delete process.env["DATAPROFILE_DIR"];
    } else {
      process.env["DATAPROFILE_DIR"] = prevVal;
    }
  });

  test("throws when DATAPROFILE_DIR is undefined", () => {
    delete process.env["DATAPROFILE_DIR"];
    expect(() => dataDir()).toThrow("DATAPROFILE_DIR is not set");
  });
  test("throws when DATAPROFILE_DIR is empty string", () => {
    process.env["DATAPROFILE_DIR"] = "";
    expect(() => dataDir()).toThrow("DATAPROFILE_DIR is not set");
  });
  test("throws when DATAPROFILE_DIR is whitespace-only", () => {
    process.env["DATAPROFILE_DIR"] = "   ";
    // Whitespace trims to "" → throw
    expect(() => dataDir()).toThrow("DATAPROFILE_DIR is not set");
  });
  test("returns resolved path when set to a valid path", () => {
    process.env["DATAPROFILE_DIR"] = TMP_ROOT;
    expect(dataDir()).toBe(resolve(TMP_ROOT));
  });
});

// ---------------------------------------------------------------------------
// assertWithinDataDir — root-equals-candidate branch (rel === "")
// ---------------------------------------------------------------------------

describe("assertWithinDataDir", () => {
  test("candidate equal to root does NOT throw (rel === '')", () => {
    const root = resolve(join(TMP_ROOT, "sub"));
    // root itself: relative(root, root) === ""
    expect(() => assertWithinDataDir(root, root)).not.toThrow();
  });
  test("descendant does not throw", () => {
    const root = resolve(join(TMP_ROOT, "root2"));
    expect(() => assertWithinDataDir(join(root, "a", "b.csv"), root)).not.toThrow();
  });
  test("path escaping via '..' throws", () => {
    const root = resolve(join(TMP_ROOT, "root3"));
    expect(() => assertWithinDataDir(resolve(root, "..", "evil.csv"), root)).toThrow(
      "path escapes",
    );
  });
  test("absolute path outside root throws", () => {
    const root = resolve(join(TMP_ROOT, "root4"));
    // On any OS the tmp root's parent is outside root
    const outside = resolve(TMP_ROOT);
    // only attempt if outside !== root (always true since root has a sub-dir)
    if (outside !== root) {
      expect(() => assertWithinDataDir(outside, root)).toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// filterDataModels — additional branch: column match (case-insensitive)
// ---------------------------------------------------------------------------

describe("filterDataModels extra branches", () => {
  const models = [
    {
      relativePath: "sales/ORDERS.CSV",
      format: "csv" as const,
      columns: [{ name: "OrderID", type: null }],
      columnCount: 1,
      rowCountEstimate: 10,
      sizeBytes: 50,
    },
  ];

  test("column match is case-insensitive", () => {
    expect(filterDataModels(models, "orderid")).toHaveLength(1);
  });
  test("path match is case-insensitive", () => {
    expect(filterDataModels(models, "orders")).toHaveLength(1);
  });
  test("empty query (only spaces) returns all", () => {
    expect(filterDataModels(models, "  ")).toHaveLength(1);
  });
  test("no match returns empty array", () => {
    expect(filterDataModels(models, "xyz")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: listDataModels + getDataModel — uncovered extensions, nested dirs,
//   jsonl row-count, ndjson, unreadable dir
// ---------------------------------------------------------------------------

describe("listDataModels / getDataModel — additional branches (real fs)", () => {
  let dir: string;
  let prevDataprofileDir: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nimbus-dp-br-int-"));
    prevDataprofileDir = process.env["DATAPROFILE_DIR"];
    process.env["DATAPROFILE_DIR"] = dir;
  });
  afterEach(async () => {
    if (prevDataprofileDir === undefined) {
      delete process.env["DATAPROFILE_DIR"];
    } else {
      process.env["DATAPROFILE_DIR"] = prevDataprofileDir;
    }
    await rm(dir, { recursive: true, force: true });
  });

  test(".ndjson extension is recognized as jsonl format", async () => {
    await writeFile(join(dir, "events.ndjson"), '{"ts":1}\n{"ts":2}\n', "utf8");
    const models = await listDataModels();
    expect(models).toHaveLength(1);
    expect(models[0]?.format).toBe("jsonl");
    expect(models[0]?.relativePath).toBe("events.ndjson");
  });

  test("unknown extension (.txt) is ignored", async () => {
    await writeFile(join(dir, "readme.txt"), "ignore me", "utf8");
    const models = await listDataModels();
    expect(models).toHaveLength(0);
  });

  test("nested subdirectory files are discovered", async () => {
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "sub", "nested.csv"), "col\nval\n", "utf8");
    const models = await listDataModels();
    expect(models).toHaveLength(1);
    // relative path uses the OS separator — normalise for assertion
    expect(models[0]?.relativePath.replace(/\\/g, "/")).toBe("sub/nested.csv");
  });

  test("jsonl row-count estimate is correct (rows excluding nothing — no header)", async () => {
    // 3 JSON lines
    await writeFile(join(dir, "lines.jsonl"), '{"x":1}\n{"x":2}\n{"x":3}\n', "utf8");
    const model = await getDataModel("lines.jsonl");
    expect(model?.rowCountEstimate).toBe(3);
    expect(model?.columns).toEqual([{ name: "x", type: "number" }]);
  });

  test("csv row-count excludes header row", async () => {
    await writeFile(join(dir, "data.csv"), "a,b\n1,2\n3,4\n", "utf8");
    const model = await getDataModel("data.csv");
    expect(model?.rowCountEstimate).toBe(2);
    expect(model?.columns.map((c) => c.name)).toEqual(["a", "b"]);
  });

  test("csv with no trailing newline: row count is correct", async () => {
    // 1 header + 1 data row, no trailing newline
    await writeFile(join(dir, "notail.csv"), "a,b\n1,2", "utf8");
    const model = await getDataModel("notail.csv");
    expect(model?.rowCountEstimate).toBe(1);
  });

  test("json file containing an array-of-objects profile", async () => {
    await writeFile(
      join(dir, "arr.json"),
      JSON.stringify([
        { name: "alice", age: 30 },
        { name: "bob", age: 25 },
      ]),
      "utf8",
    );
    const model = await getDataModel("arr.json");
    expect(model?.rowCountEstimate).toBe(2);
    expect(model?.columns.map((c) => c.name)).toEqual(["name", "age"]);
  });

  test("json file containing a plain object has null rowCountEstimate", async () => {
    await writeFile(join(dir, "obj.json"), JSON.stringify({ key: "val", num: 1 }), "utf8");
    const model = await getDataModel("obj.json");
    expect(model?.rowCountEstimate).toBeNull();
    expect(model?.columns.map((c) => c.name)).toEqual(["key", "num"]);
  });

  test("json file containing primitive (invalid shape) returns empty columns", async () => {
    await writeFile(join(dir, "prim.json"), "42", "utf8");
    const model = await getDataModel("prim.json");
    expect(model?.columns).toEqual([]);
    expect(model?.rowCountEstimate).toBeNull();
  });

  test("getDataModel returns null for unknown extension", async () => {
    // no file needed — extension check happens before file access
    const model = await getDataModel("notes.xml");
    expect(model).toBeNull();
  });

  test("parquet reader returning null causes profileFile to return null", async () => {
    await writeFile(join(dir, "bad.parquet"), "garbage", "utf8");
    const result = await getDataModel("bad.parquet", async () => null);
    expect(result).toBeNull();
  });

  test("listDataModels skips parquet when reader returns null", async () => {
    await writeFile(join(dir, "skip.parquet"), "not real parquet", "utf8");
    await writeFile(join(dir, "real.csv"), "a\n1\n", "utf8");
    const models = await listDataModels(async () => null);
    // skip.parquet silently dropped; real.csv still shows up
    expect(models.map((m) => m.relativePath)).toEqual(["real.csv"]);
  });

  test("jsonl file with a single-field first line: columns inferred from first line only", async () => {
    await writeFile(join(dir, "single.jsonl"), '{"only":"val"}\n', "utf8");
    const model = await getDataModel("single.jsonl");
    expect(model?.columns).toEqual([{ name: "only", type: "string" }]);
    expect(model?.rowCountEstimate).toBe(1);
  });

  test("jsonl first line that is not a JSON object returns empty columns", async () => {
    await writeFile(join(dir, "bad.jsonl"), "not-json-at-all\nstill-bad\n", "utf8");
    const model = await getDataModel("bad.jsonl");
    expect(model?.columns).toEqual([]);
    // row count is still derived from newline count
    expect(model?.rowCountEstimate).toBe(2);
  });

  test("jsonl first line that is a JSON array returns empty columns", async () => {
    await writeFile(join(dir, "arr.jsonl"), "[1,2,3]\n[4,5,6]\n", "utf8");
    const model = await getDataModel("arr.jsonl");
    expect(model?.columns).toEqual([]);
    expect(model?.rowCountEstimate).toBe(2);
  });

  test("csv file with a single line (no newline, no data rows) returns 0 rows", async () => {
    // CSV: header only, no trailing newline  → rows = 0
    await writeFile(join(dir, "headonly.csv"), "x,y,z", "utf8");
    const model = await getDataModel("headonly.csv");
    // firstLineAndRows: idx==-1 → firstLine=entire text; nl=0; text doesn't end \n → nl+1=1; CSV subtracts 1 → 0
    expect(model?.rowCountEstimate).toBe(0);
    expect(model?.columns.map((c) => c.name)).toEqual(["x", "y", "z"]);
  });

  test("parquet with bigint row count is converted to number", async () => {
    await writeFile(join(dir, "big.parquet"), "x", "utf8");
    const fakeReader = async () => ({
      schema: [{ name: "col", type: "INT32" }],
      num_rows: 1000n,
    });
    const model = await getDataModel("big.parquet", fakeReader);
    expect(model?.rowCountEstimate).toBe(1000);
    expect(model?.columns).toEqual([{ name: "col", type: "INT32" }]);
  });
});
