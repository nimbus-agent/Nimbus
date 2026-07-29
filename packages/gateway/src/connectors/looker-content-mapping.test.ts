import { expect, test } from "bun:test";
import { mapLookerDashboardToItem, mapLookerViewToItem } from "./looker-content-mapping.ts";

// ──────────────────────────────────────────────────────────────────────────────
// mapLookerDashboardToItem
// ──────────────────────────────────────────────────────────────────────────────

test("maps a dashboard to a dashboard item", () => {
  const item = mapLookerDashboardToItem(
    { id: "42", title: "Sales Overview", folder: "Finance" },
    { syncedAt: 1_000 },
  );
  expect(item).not.toBeNull();
  expect(item?.type).toBe("dashboard");
  expect(item?.service).toBe("looker");
  expect(item?.externalId).toBe("looker:dashboard/42");
  expect(item?.title).toBe("Sales Overview");
  expect(item?.metadata["folder"]).toBe("Finance");
  expect(item?.metadata["upstreamDataModelKeys"]).toEqual([]);
  expect(item?.modifiedAt).toBe(1_000);
  expect(item?.syncedAt).toBe(1_000);
});

test("dashboard item has null url and canonicalUrl", () => {
  const item = mapLookerDashboardToItem({ id: "1", title: "T" }, { syncedAt: 1 });
  expect(item?.url).toBeNull();
  expect(item?.canonicalUrl).toBeNull();
});

test("dashboard folder defaults to null when absent", () => {
  const item = mapLookerDashboardToItem({ id: "1", title: "T" }, { syncedAt: 1 });
  expect(item?.metadata["folder"]).toBeNull();
});

test("returns null when id is missing", () => {
  expect(mapLookerDashboardToItem({ title: "T" }, { syncedAt: 1 })).toBeNull();
});

test("returns null when id is empty string", () => {
  expect(mapLookerDashboardToItem({ id: "", title: "T" }, { syncedAt: 1 })).toBeNull();
});

test("returns null when title is missing", () => {
  expect(mapLookerDashboardToItem({ id: "1" }, { syncedAt: 1 })).toBeNull();
});

test("returns null when title is empty string", () => {
  expect(mapLookerDashboardToItem({ id: "1", title: "" }, { syncedAt: 1 })).toBeNull();
});

test("returns null for non-record dashboard input", () => {
  expect(mapLookerDashboardToItem(null, { syncedAt: 1 })).toBeNull();
  expect(mapLookerDashboardToItem("string", { syncedAt: 1 })).toBeNull();
  expect(mapLookerDashboardToItem(42, { syncedAt: 1 })).toBeNull();
});

// ──────────────────────────────────────────────────────────────────────────────
// mapLookerViewToItem — lineage keys (primary requirements)
// ──────────────────────────────────────────────────────────────────────────────

test("maps a LookML view to a data_model item with normalized derivedFromKeys and dataModelKey", () => {
  const item = mapLookerViewToItem(
    { model: "ecommerce", name: "orders", sql_table_name: "ANALYTICS.PUBLIC.ORDERS" },
    { syncedAt: 2_000 },
  );
  expect(item).not.toBeNull();
  expect(item?.type).toBe("data_model");
  expect(item?.service).toBe("looker");
  expect(item?.externalId).toBe("looker:view/ecommerce.orders");
  expect(item?.title).toBe("ecommerce.orders");
  expect(item?.metadata["dataModelKey"]).toBe("analytics.public.orders");
  expect(item?.metadata["derivedFromKeys"]).toContain("analytics.public.orders");
  expect(item?.modifiedAt).toBe(2_000);
  expect(item?.syncedAt).toBe(2_000);
});

test("lowercases and strips quoting from sql_table_name", () => {
  const item = mapLookerViewToItem(
    { model: "m", name: "v", sql_table_name: "`SCHEMA`.`TABLE`" },
    { syncedAt: 1 },
  );
  expect(item?.metadata["dataModelKey"]).toBe("schema.table");
  expect(item?.metadata["derivedFromKeys"]).toEqual(["schema.table"]);
});

test("returns null when sql_table_name normalizes to null (empty string)", () => {
  expect(
    mapLookerViewToItem({ model: "m", name: "v", sql_table_name: "" }, { syncedAt: 1 }),
  ).toBeNull();
});

test("returns null when sql_table_name is absent", () => {
  expect(mapLookerViewToItem({ model: "m", name: "v" }, { syncedAt: 1 })).toBeNull();
});

test("returns null when model is missing", () => {
  expect(
    mapLookerViewToItem({ name: "orders", sql_table_name: "A.B.C" }, { syncedAt: 1 }),
  ).toBeNull();
});

test("returns null when model is empty string", () => {
  expect(
    mapLookerViewToItem({ model: "", name: "orders", sql_table_name: "A.B.C" }, { syncedAt: 1 }),
  ).toBeNull();
});

test("returns null when name is missing", () => {
  expect(mapLookerViewToItem({ model: "m", sql_table_name: "A.B.C" }, { syncedAt: 1 })).toBeNull();
});

test("returns null when name is empty string", () => {
  expect(
    mapLookerViewToItem({ model: "m", name: "", sql_table_name: "A.B.C" }, { syncedAt: 1 }),
  ).toBeNull();
});

test("returns null for non-record view input", () => {
  expect(mapLookerViewToItem(null, { syncedAt: 1 })).toBeNull();
  expect(mapLookerViewToItem("string", { syncedAt: 1 })).toBeNull();
});

test("data_model item has null url and canonicalUrl", () => {
  const item = mapLookerViewToItem(
    { model: "m", name: "v", sql_table_name: "A.B" },
    { syncedAt: 1 },
  );
  expect(item?.url).toBeNull();
  expect(item?.canonicalUrl).toBeNull();
});
