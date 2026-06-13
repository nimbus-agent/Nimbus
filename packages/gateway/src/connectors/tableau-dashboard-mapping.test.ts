import { expect, test } from "bun:test";
import { mapTableauViewToItem } from "./tableau-dashboard-mapping.ts";

test("maps a view to a dashboard item with normalized upstream data model keys", () => {
  const item = mapTableauViewToItem(
    {
      luid: "v1",
      name: "Q1 Revenue",
      dataSourceTables: ["ANALYTICS.PUBLIC.REVENUE"],
      author: "Alice",
      folder: "Finance",
      extractRefreshStatus: "success",
    },
    { syncedAt: 1_000 },
  );
  expect(item?.type).toBe("dashboard");
  expect(item?.service).toBe("tableau");
  expect(item?.externalId).toBe("tableau:v1");
  expect(item?.title).toBe("Q1 Revenue");
  expect(item?.metadata["upstreamDataModelKeys"]).toEqual(["analytics.public.revenue"]);
  expect(item?.metadata["author"]).toBe("Alice");
  expect(item?.metadata["folder"]).toBe("Finance");
  expect(item?.metadata["extractRefreshStatus"]).toBe("success");
});

test("normalizes multiple upstream tables", () => {
  const item = mapTableauViewToItem(
    {
      luid: "v2",
      name: "Sales Overview",
      dataSourceTables: ["DW.SALES.ORDERS", "DW.SALES.CUSTOMERS"],
    },
    { syncedAt: 2_000 },
  );
  expect(item?.metadata["upstreamDataModelKeys"]).toEqual([
    "dw.sales.orders",
    "dw.sales.customers",
  ]);
});

test("filters out null-normalizing upstream table entries", () => {
  const item = mapTableauViewToItem(
    {
      luid: "v3",
      name: "Empty Tables",
      dataSourceTables: ["", "VALID.SCHEMA.TABLE"],
    },
    { syncedAt: 3_000 },
  );
  expect(item?.metadata["upstreamDataModelKeys"]).toEqual(["valid.schema.table"]);
});

test("sets upstreamDataModelKeys to [] when dataSourceTables is absent", () => {
  const item = mapTableauViewToItem({ luid: "v4", name: "No Upstream" }, { syncedAt: 4_000 });
  expect(item).not.toBeNull();
  expect(item?.metadata["upstreamDataModelKeys"]).toEqual([]);
});

test("returns null when luid is missing", () => {
  expect(
    mapTableauViewToItem({ name: "No LUID", dataSourceTables: [] }, { syncedAt: 1 }),
  ).toBeNull();
});

test("returns null when name is missing", () => {
  expect(mapTableauViewToItem({ luid: "v1", dataSourceTables: [] }, { syncedAt: 1 })).toBeNull();
});
