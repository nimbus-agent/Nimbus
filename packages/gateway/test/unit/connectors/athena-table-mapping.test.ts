import { describe, expect, test } from "bun:test";

import { mapAthenaTableToItem } from "../../../src/connectors/athena-table-mapping.ts";

const CTX = { catalog: "AwsDataCatalog", database: "analytics", syncedAt: 1_700_000_000_000 };

describe("mapAthenaTableToItem", () => {
  test("maps a full table-metadata entry (schema + metadata, NO row data)", () => {
    const row = mapAthenaTableToItem(
      {
        Name: "events",
        TableType: "EXTERNAL_TABLE",
        Columns: [
          { Name: "event_id", Type: "string" },
          { Name: "ts", Type: "timestamp", Comment: "ignored" },
        ],
        PartitionKeys: [{ Name: "dt", Type: "string" }],
        Parameters: { classification: "parquet" },
        CreateTime: "2023-07-22T00:00:00Z",
        LastAccessTime: "2023-11-03T00:00:00Z",
      },
      CTX,
    );
    expect(row).not.toBeNull();
    expect(row?.service).toBe("athena");
    expect(row?.type).toBe("table");
    expect(row?.externalId).toBe("AwsDataCatalog/analytics.events");
    expect(row?.title).toBe("analytics.events");
    expect(row?.url).toBeNull();
    expect(row?.canonicalUrl).toBeNull();
    expect(row?.modifiedAt).toBe(Date.parse("2023-11-03T00:00:00Z"));
    const meta = row?.metadata as Record<string, unknown>;
    expect(meta.catalog).toBe("AwsDataCatalog");
    expect(meta.database).toBe("analytics");
    expect(meta.tableName).toBe("events");
    expect(meta.tableType).toBe("EXTERNAL_TABLE");
    expect(meta.columns).toEqual([
      { name: "event_id", type: "string" },
      { name: "ts", type: "timestamp" },
    ]);
    expect(meta.partitionKeys).toEqual([{ name: "dt", type: "string" }]);
    expect(meta.parameters).toEqual({ classification: "parquet" });
    // No row/cell data anywhere in the metadata.
    expect(JSON.stringify(meta)).not.toContain("rows");
  });

  test("falls back to createTime when lastAccessTime is absent", () => {
    const row = mapAthenaTableToItem(
      { Name: "t", Columns: [], CreateTime: "2022-01-01T00:00:00Z" },
      CTX,
    );
    expect(row?.modifiedAt).toBe(Date.parse("2022-01-01T00:00:00Z"));
  });

  test("falls back to syncedAt when no timestamps are present", () => {
    const row = mapAthenaTableToItem({ Name: "t", Columns: [] }, CTX);
    expect(row?.modifiedAt).toBe(CTX.syncedAt);
  });

  test("parses epoch-seconds CreateTime to millis", () => {
    const row = mapAthenaTableToItem({ Name: "t", CreateTime: 1_690_000_000 }, CTX);
    expect(row?.modifiedAt).toBe(1_690_000_000_000);
  });

  test("treats a large numeric timestamp as already-millis", () => {
    const row = mapAthenaTableToItem({ Name: "t", LastAccessTime: 1_690_000_000_000 }, CTX);
    expect(row?.modifiedAt).toBe(1_690_000_000_000);
  });

  test("bodyPreview summarizes column name:type pairs", () => {
    const row = mapAthenaTableToItem(
      {
        Name: "t",
        Columns: [
          { Name: "a", Type: "int" },
          { Name: "b", Type: "string" },
        ],
      },
      CTX,
    );
    expect(row?.bodyPreview).toBe("a:int, b:string");
  });

  test("bodyPreview falls back to qualified name when no columns", () => {
    const row = mapAthenaTableToItem({ Name: "t", Columns: [] }, CTX);
    expect(row?.bodyPreview).toBe("analytics.t");
  });

  test("returns null when table name is missing", () => {
    expect(mapAthenaTableToItem({ TableType: "EXTERNAL_TABLE" }, CTX)).toBeNull();
    expect(mapAthenaTableToItem({ Name: "" }, CTX)).toBeNull();
  });

  test("returns null on non-record input", () => {
    expect(mapAthenaTableToItem(null, CTX)).toBeNull();
    expect(mapAthenaTableToItem(["x"], CTX)).toBeNull();
    expect(mapAthenaTableToItem(42, CTX)).toBeNull();
  });

  test("skips columns missing a Name; omits empty partitionKeys/parameters", () => {
    const row = mapAthenaTableToItem(
      { Name: "t", Columns: [{ Type: "int" }, { Name: "ok", Type: "string" }] },
      CTX,
    );
    const meta = row?.metadata as Record<string, unknown>;
    expect(meta.columns).toEqual([{ name: "ok", type: "string" }]);
    expect("partitionKeys" in meta).toBe(false);
    expect("parameters" in meta).toBe(false);
  });
});
