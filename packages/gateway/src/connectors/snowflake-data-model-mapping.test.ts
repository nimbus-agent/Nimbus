import { expect, test } from "bun:test";
import { mapSnowflakeTableToItem } from "./snowflake-data-model-mapping.ts";

test("maps a table to a data_model item with a normalized key and no cell values", () => {
  const item = mapSnowflakeTableToItem(
    {
      database_name: "ANALYTICS",
      schema_name: "PUBLIC",
      table_name: "REVENUE",
      row_count: 1234,
      last_altered: "2026-06-01T00:00:00Z",
      columns: [{ name: "AMOUNT", tag: "pii:false" }],
    },
    { syncedAt: 1_000 },
  );
  expect(item?.type).toBe("data_model");
  expect(item?.externalId).toBe("snowflake:analytics.public.revenue");
  expect(item?.metadata["dataModelKey"]).toBe("analytics.public.revenue");
  expect(item?.metadata["rowCountEstimate"]).toBe(1234);
});

test("returns null when the table name is missing", () => {
  expect(
    mapSnowflakeTableToItem({ database_name: "A", schema_name: "B" }, { syncedAt: 1 }),
  ).toBeNull();
});

test("epoch-0 last_altered yields modifiedAt === 0, not the syncedAt fallback", () => {
  const item = mapSnowflakeTableToItem(
    {
      database_name: "ANALYTICS",
      schema_name: "PUBLIC",
      table_name: "ORDERS",
      row_count: 0,
      last_altered: "1970-01-01T00:00:00.000Z",
    },
    { syncedAt: 999_999 },
  );
  expect(item).not.toBeNull();
  expect(item?.modifiedAt).toBe(0);
});

test("invalid last_altered string falls back to syncedAt", () => {
  const item = mapSnowflakeTableToItem(
    {
      database_name: "ANALYTICS",
      schema_name: "PUBLIC",
      table_name: "ORDERS",
      row_count: 0,
      last_altered: "not-a-date",
    },
    { syncedAt: 55_000 },
  );
  expect(item?.modifiedAt).toBe(55_000);
});

test("columns carry name, type and nullability only, and are complete only when the connector says so", () => {
  const row = {
    database_name: "ANALYTICS",
    schema_name: "PUBLIC",
    table_name: "ORDERS",
    columns: [
      { name: "ID", type: "NUMBER", nullable: false, ordinal: 1 },
      { name: "NOTE", type: "TEXT", nullable: null, ordinal: 2, default: "secret", value: "x" },
    ],
  };
  const done = mapSnowflakeTableToItem({ ...row, columns_complete: true }, { syncedAt: 1 });
  expect(done?.metadata["columns"]).toEqual([
    { name: "ID", type: "NUMBER", nullable: false },
    { name: "NOTE", type: "TEXT", nullable: null },
  ]);
  expect(done?.metadata["columnsComplete"]).toBe(true);
  // no cell values or defaults reach the index
  expect(JSON.stringify(done?.metadata)).not.toContain("secret");
  for (const flag of [false, undefined]) {
    const cut = mapSnowflakeTableToItem(
      { ...row, ...(flag === undefined ? {} : { columns_complete: flag }) },
      { syncedAt: 1 },
    );
    expect(cut?.metadata["columnsComplete"]).toBe(false);
  }
});

test("an unreadable column entry makes the set incomplete instead of shortening it silently", () => {
  const item = mapSnowflakeTableToItem(
    {
      database_name: "A",
      schema_name: "B",
      table_name: "C",
      columns: [{ name: "X", type: "T", nullable: true }, "oops", { type: "T" }],
      columns_complete: true,
    },
    { syncedAt: 1 },
  );
  expect(item?.metadata["columnsComplete"]).toBe(false);
});
