import { describe, expect, it } from "bun:test";
import {
  firstLineAndRows,
  jsKind,
  parquetColumnsFromMetadata,
  parseCsvHeader,
  parseJsonColumns,
  parseJsonlColumns,
} from "./index.ts";

// ---------------------------------------------------------------------------
// jsKind
// ---------------------------------------------------------------------------
describe("jsKind", () => {
  it("returns 'null' for null", () => {
    expect(jsKind(null)).toBe("null");
  });
  it("returns 'array' for arrays", () => {
    expect(jsKind([])).toBe("array");
    expect(jsKind([1, 2, 3])).toBe("array");
  });
  it("returns 'string' for strings", () => {
    expect(jsKind("hello")).toBe("string");
  });
  it("returns 'number' for numbers", () => {
    expect(jsKind(42)).toBe("number");
  });
  it("returns 'boolean' for booleans", () => {
    expect(jsKind(true)).toBe("boolean");
    expect(jsKind(false)).toBe("boolean");
  });
  it("returns 'object' for plain objects", () => {
    expect(jsKind({})).toBe("object");
    expect(jsKind({ a: 1 })).toBe("object");
  });
  it("returns 'undefined' for undefined", () => {
    expect(jsKind(undefined)).toBe("undefined");
  });
  it("never returns a value — only the kind name", () => {
    const secret = "SENSITIVE_VALUE_12345";
    expect(jsKind(secret)).toBe("string");
    expect(jsKind(secret)).not.toContain("SENSITIVE");
  });
});

// ---------------------------------------------------------------------------
// parseCsvHeader
// ---------------------------------------------------------------------------
describe("parseCsvHeader", () => {
  it("parses a simple header", () => {
    const cols = parseCsvHeader("id,name,age");
    expect(cols).toEqual([
      { name: "id", type: null },
      { name: "name", type: null },
      { name: "age", type: null },
    ]);
  });

  it("strips surrounding double-quotes", () => {
    const cols = parseCsvHeader('"first_name","last_name"');
    expect(cols).toEqual([
      { name: "first_name", type: null },
      { name: "last_name", type: null },
    ]);
  });

  it("trims whitespace around column names", () => {
    const cols = parseCsvHeader(" col_a , col_b ");
    expect(cols.map((c) => c.name)).toEqual(["col_a", "col_b"]);
  });

  it("returns empty array for an empty/whitespace-only line", () => {
    expect(parseCsvHeader("")).toEqual([]);
    expect(parseCsvHeader("   ")).toEqual([]);
  });

  it("strips trailing carriage return", () => {
    const cols = parseCsvHeader("a,b\r");
    expect(cols.map((c) => c.name)).toEqual(["a", "b"]);
  });

  it("type is always null (no cell values stored)", () => {
    const cols = parseCsvHeader("revenue,user_id");
    expect(cols.every((c) => c.type === null)).toBe(true);
  });

  it("caps at MAX_COLUMNS (512) — no overflow", () => {
    const bigHeader = Array.from({ length: 600 }, (_, i) => `col${i}`).join(",");
    const cols = parseCsvHeader(bigHeader);
    expect(cols.length).toBeLessThanOrEqual(512);
  });
});

// ---------------------------------------------------------------------------
// parseJsonlColumns
// ---------------------------------------------------------------------------
describe("parseJsonlColumns", () => {
  it("extracts field names + kinds from the first record", () => {
    const line = JSON.stringify({ id: 1, name: "Alice", active: true, score: 9.9 });
    const cols = parseJsonlColumns(line);
    expect(cols).toEqual([
      { name: "id", type: "number" },
      { name: "name", type: "string" },
      { name: "active", type: "boolean" },
      { name: "score", type: "number" },
    ]);
  });

  it("reports 'null' kind for null fields", () => {
    const line = JSON.stringify({ val: null });
    const cols = parseJsonlColumns(line);
    expect(cols).toEqual([{ name: "val", type: "null" }]);
  });

  it("reports 'array' kind for array fields", () => {
    const line = JSON.stringify({ tags: ["a", "b"] });
    const cols = parseJsonlColumns(line);
    expect(cols).toEqual([{ name: "tags", type: "array" }]);
  });

  it("never stores any value — only the kind", () => {
    const line = JSON.stringify({ password: "SUPER_SECRET_123" });
    const cols = parseJsonlColumns(line);
    expect(cols[0]?.type).toBe("string");
    expect(JSON.stringify(cols)).not.toContain("SUPER_SECRET");
  });

  it("returns [] for a non-object JSON line", () => {
    expect(parseJsonlColumns("[1,2,3]")).toEqual([]);
    expect(parseJsonlColumns('"just a string"')).toEqual([]);
    expect(parseJsonlColumns("42")).toEqual([]);
    expect(parseJsonlColumns("null")).toEqual([]);
  });

  it("returns [] for invalid JSON", () => {
    expect(parseJsonlColumns("not json at all")).toEqual([]);
    expect(parseJsonlColumns("{broken}")).toEqual([]);
  });

  it("caps at MAX_COLUMNS", () => {
    const obj: Record<string, number> = {};
    for (let i = 0; i < 600; i++) {
      obj[`f${i}`] = i;
    }
    const cols = parseJsonlColumns(JSON.stringify(obj));
    expect(cols.length).toBeLessThanOrEqual(512);
  });
});

// ---------------------------------------------------------------------------
// parseJsonColumns
// ---------------------------------------------------------------------------
describe("parseJsonColumns", () => {
  it("handles a JSON array of objects — returns columns + length as rowCount", () => {
    const parsed = [
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ];
    const { columns, rowCountEstimate } = parseJsonColumns(parsed);
    expect(columns).toEqual([
      { name: "id", type: "number" },
      { name: "name", type: "string" },
    ]);
    expect(rowCountEstimate).toBe(2);
  });

  it("handles a JSON array of non-objects — columns empty, rowCount = length", () => {
    const { columns, rowCountEstimate } = parseJsonColumns([1, 2, 3]);
    expect(columns).toEqual([]);
    expect(rowCountEstimate).toBe(3);
  });

  it("handles an empty array", () => {
    const { columns, rowCountEstimate } = parseJsonColumns([]);
    expect(columns).toEqual([]);
    expect(rowCountEstimate).toBe(0);
  });

  it("handles a top-level JSON object — rowCount null", () => {
    const parsed = { version: "1.0", items: [] as unknown[] };
    const { columns, rowCountEstimate } = parseJsonColumns(parsed);
    expect(columns).toEqual([
      { name: "version", type: "string" },
      { name: "items", type: "array" },
    ]);
    expect(rowCountEstimate).toBeNull();
  });

  it("handles primitives — columns empty, rowCount null", () => {
    const { columns, rowCountEstimate } = parseJsonColumns(42);
    expect(columns).toEqual([]);
    expect(rowCountEstimate).toBeNull();
  });

  it("never stores cell values — only kinds", () => {
    const parsed = [{ secret: "MY_SECRET_VALUE" }];
    const { columns } = parseJsonColumns(parsed);
    expect(columns[0]?.type).toBe("string");
    expect(JSON.stringify(columns)).not.toContain("MY_SECRET");
  });

  it("caps at MAX_COLUMNS", () => {
    const row: Record<string, number> = {};
    for (let i = 0; i < 600; i++) {
      row[`f${i}`] = i;
    }
    const { columns } = parseJsonColumns([row]);
    expect(columns.length).toBeLessThanOrEqual(512);
  });
});

// ---------------------------------------------------------------------------
// parquetColumnsFromMetadata
// ---------------------------------------------------------------------------
describe("parquetColumnsFromMetadata", () => {
  it("extracts leaf columns (those with a type) from schema", () => {
    const meta = {
      schema: [
        { name: "schema_root" }, // no type → group element, skip
        { name: "id", type: "INT64" },
        { name: "price", type: "DOUBLE" },
      ],
      num_rows: 1000,
    };
    const { columns, rowCountEstimate } = parquetColumnsFromMetadata(meta);
    expect(columns).toEqual([
      { name: "id", type: "INT64" },
      { name: "price", type: "DOUBLE" },
    ]);
    expect(rowCountEstimate).toBe(1000);
  });

  it("handles bigint num_rows", () => {
    const meta = { schema: [{ name: "col", type: "BYTE_ARRAY" }], num_rows: BigInt(5_000_000) };
    const { rowCountEstimate } = parquetColumnsFromMetadata(meta);
    expect(rowCountEstimate).toBe(5_000_000);
  });

  it("returns null rowCount when num_rows is missing", () => {
    const meta = { schema: [{ name: "col", type: "BOOLEAN" }] };
    const { rowCountEstimate } = parquetColumnsFromMetadata(meta);
    expect(rowCountEstimate).toBeNull();
  });

  it("returns null rowCount when num_rows is non-finite", () => {
    const { rowCountEstimate } = parquetColumnsFromMetadata({ num_rows: Number.POSITIVE_INFINITY });
    expect(rowCountEstimate).toBeNull();
  });

  it("returns empty columns when schema is absent", () => {
    expect(parquetColumnsFromMetadata({}).columns).toEqual([]);
  });

  it("skips schema elements with no name or no type", () => {
    const meta = {
      schema: [
        { name: "ok", type: "INT32" },
        { type: "INT32" }, // no name
        { name: "noType" }, // no type
        null as unknown as { name?: unknown; type?: unknown }, // null element
      ],
    };
    const { columns } = parquetColumnsFromMetadata(meta);
    expect(columns.map((c) => c.name)).toEqual(["ok"]);
  });

  it("converts type to string", () => {
    const meta = { schema: [{ name: "flags", type: 99 }] };
    const { columns } = parquetColumnsFromMetadata(meta);
    expect(columns[0]?.type).toBe("99");
  });

  it("caps at MAX_COLUMNS (512)", () => {
    const schema = Array.from({ length: 600 }, (_, i) => ({ name: `c${i}`, type: "INT32" }));
    const { columns } = parquetColumnsFromMetadata({ schema });
    expect(columns.length).toBeLessThanOrEqual(512);
  });
});

// ---------------------------------------------------------------------------
// firstLineAndRows
// ---------------------------------------------------------------------------
describe("firstLineAndRows", () => {
  it("extracts first line and counts rows when not truncated", () => {
    const text = "header\nrow1\nrow2\n";
    const { firstLine, rowCountEstimate } = firstLineAndRows(text, false);
    expect(firstLine).toBe("header");
    expect(rowCountEstimate).toBe(3); // 3 newlines → 3 lines
  });

  it("counts rows with no trailing newline", () => {
    const text = "header\nrow1\nrow2";
    const { firstLine, rowCountEstimate } = firstLineAndRows(text, false);
    expect(firstLine).toBe("header");
    expect(rowCountEstimate).toBe(3); // nl=2 + 1 = 3
  });

  it("handles single-line text (no newline)", () => {
    const { firstLine, rowCountEstimate } = firstLineAndRows("onlyone", false);
    expect(firstLine).toBe("onlyone");
    expect(rowCountEstimate).toBe(1);
  });

  it("returns null rowCount when truncated", () => {
    const { firstLine, rowCountEstimate } = firstLineAndRows("col_a,col_b\nsome", true);
    expect(firstLine).toBe("col_a,col_b");
    expect(rowCountEstimate).toBeNull();
  });

  it("returns min 0 for empty text", () => {
    const { rowCountEstimate } = firstLineAndRows("", false);
    expect(rowCountEstimate).toBeGreaterThanOrEqual(0);
  });

  it("firstLine is empty string when text starts with newline", () => {
    const { firstLine } = firstLineAndRows("\nsecond", false);
    expect(firstLine).toBe("");
  });
});
