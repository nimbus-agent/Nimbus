import { describe, expect, test } from "bun:test";

import {
  type DataModelProfile,
  jsKind,
  mapDataModelToItem,
  parquetColumnsFromMetadata,
  parseCsvHeader,
  parseJsonColumns,
  parseJsonlColumns,
} from "../../../src/connectors/data-profile-mapping.ts";

const SYNCED_AT = 1_750_000_000_000;

describe("jsKind", () => {
  test("classifies values by kind, never returning the value", () => {
    expect(jsKind("x")).toBe("string");
    expect(jsKind(3)).toBe("number");
    expect(jsKind(true)).toBe("boolean");
    expect(jsKind(null)).toBe("null");
    expect(jsKind([1, 2])).toBe("array");
    expect(jsKind({ a: 1 })).toBe("object");
  });
});

describe("parseCsvHeader", () => {
  test("splits the header into column names, stripping quotes + CR", () => {
    expect(parseCsvHeader('id,"full name",email\r')).toEqual([
      { name: "id", type: null },
      { name: "full name", type: null },
      { name: "email", type: null },
    ]);
  });
  test("returns [] for an empty header", () => {
    expect(parseCsvHeader("   ")).toEqual([]);
  });
});

describe("parseJsonlColumns", () => {
  test("extracts field names + JS kinds from the first object, never values", () => {
    const cols = parseJsonlColumns('{"id":1,"name":"Ada","tags":["x"],"active":true}');
    expect(cols).toEqual([
      { name: "id", type: "number" },
      { name: "name", type: "string" },
      { name: "tags", type: "array" },
      { name: "active", type: "boolean" },
    ]);
    // No actual values leak.
    expect(JSON.stringify(cols)).not.toContain("Ada");
  });
  test("returns [] for a non-object line or bad JSON", () => {
    expect(parseJsonlColumns("[1,2,3]")).toEqual([]);
    expect(parseJsonlColumns("not json")).toEqual([]);
  });
});

describe("parseJsonColumns", () => {
  test("array of objects → columns from first element + row count = length", () => {
    expect(parseJsonColumns([{ a: 1, b: "x" }, { a: 2 }])).toEqual({
      columns: [
        { name: "a", type: "number" },
        { name: "b", type: "string" },
      ],
      rowCountEstimate: 2,
    });
  });
  test("single object → columns from keys, rowCount null", () => {
    expect(parseJsonColumns({ k: true })).toEqual({
      columns: [{ name: "k", type: "boolean" }],
      rowCountEstimate: null,
    });
  });
  test("array of scalars → no columns, rowCount = length", () => {
    expect(parseJsonColumns([1, 2, 3])).toEqual({ columns: [], rowCountEstimate: 3 });
  });
});

describe("parquetColumnsFromMetadata", () => {
  test("takes leaf schema elements (with a type) as columns + num_rows (bigint)", () => {
    const meta = {
      schema: [
        { name: "root" }, // root group — no type, skipped
        { name: "id", type: "INT64" },
        { name: "email", type: "BYTE_ARRAY" },
      ],
      num_rows: 1234n,
    };
    expect(parquetColumnsFromMetadata(meta)).toEqual({
      columns: [
        { name: "id", type: "INT64" },
        { name: "email", type: "BYTE_ARRAY" },
      ],
      rowCountEstimate: 1234,
    });
  });
  test("tolerates a missing schema / num_rows", () => {
    expect(parquetColumnsFromMetadata({})).toEqual({ columns: [], rowCountEstimate: null });
  });
});

function profile(over: Partial<DataModelProfile> = {}): DataModelProfile {
  return {
    relativePath: "exports/orders.parquet",
    format: "parquet",
    columns: [
      { name: "order_id", type: "INT64" },
      { name: "total", type: "DOUBLE" },
    ],
    rowCountEstimate: 5000,
    sizeBytes: 4096,
    modifiedAtMs: 1_700_000_000_000,
    ...over,
  };
}

describe("mapDataModelToItem", () => {
  test("maps a profile to a dataprofile:data_model item (schema only)", () => {
    const row = mapDataModelToItem(profile(), { syncedAt: SYNCED_AT });
    expect(row).not.toBeNull();
    if (row === null) {
      return;
    }
    expect(row.service).toBe("dataprofile");
    expect(row.type).toBe("data_model");
    expect(row.externalId).toBe("exports/orders.parquet");
    expect(row.title).toBe("orders.parquet");
    expect(row.bodyPreview).toContain("parquet · 2 columns · ~5000 rows");
    expect(row.bodyPreview).toContain("order_id:INT64");
    expect(row.modifiedAt).toBe(1_700_000_000_000);
    expect(row.metadata.columnCount).toBe(2);
    expect(row.metadata.rowCountEstimate).toBe(5000);
    expect(row.metadata.format).toBe("parquet");
  });

  test("renders 'rows unknown' when the row estimate is null", () => {
    const row = mapDataModelToItem(profile({ rowCountEstimate: null }), { syncedAt: SYNCED_AT });
    expect(row?.bodyPreview).toContain("rows unknown");
  });

  test("falls back to syncedAt when mtime is null; returns null for empty path", () => {
    expect(
      mapDataModelToItem(profile({ modifiedAtMs: null }), { syncedAt: SYNCED_AT })?.modifiedAt,
    ).toBe(SYNCED_AT);
    expect(mapDataModelToItem(profile({ relativePath: "  " }), { syncedAt: SYNCED_AT })).toBeNull();
  });
});
