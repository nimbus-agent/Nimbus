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
  expect(item?.metadata.dataModelKey).toBe("analytics.public.revenue");
  expect(item?.metadata.rowCountEstimate).toBe(1234);
});

test("returns null when the table name is missing", () => {
  expect(
    mapSnowflakeTableToItem({ database_name: "A", schema_name: "B" }, { syncedAt: 1 }),
  ).toBeNull();
});
