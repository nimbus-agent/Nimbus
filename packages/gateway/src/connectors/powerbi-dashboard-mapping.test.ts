import { expect, test } from "bun:test";
import { mapPowerBiReportToItem } from "./powerbi-dashboard-mapping.ts";

test("maps a report to a dashboard item with normalized upstream keys", () => {
  const item = mapPowerBiReportToItem(
    {
      id: "r1",
      name: "Sales",
      datasetId: "d1",
      workspace: "Finance",
      datasetTables: ["revenue"],
    },
    { syncedAt: 1_000 },
  );
  expect(item).not.toBeNull();
  expect(item?.service).toBe("powerbi");
  expect(item?.type).toBe("dashboard");
  expect(item?.externalId).toBe("powerbi:r1");
  expect(item?.title).toBe("Sales");
  expect(item?.metadata["upstreamDataModelKeys"]).toContain("revenue");
  expect(item?.metadata["workspace"]).toBe("Finance");
  expect(item?.metadata["datasetId"]).toBe("d1");
});

test("normalizes dataset table names (uppercase → lowercase)", () => {
  const item = mapPowerBiReportToItem(
    {
      id: "r2",
      name: "Revenue",
      datasetTables: ["ANALYTICS.PUBLIC.REVENUE"],
    },
    { syncedAt: 1_000 },
  );
  expect(item?.metadata["upstreamDataModelKeys"]).toEqual(["analytics.public.revenue"]);
});

test("filters out null normalizations (empty strings)", () => {
  const item = mapPowerBiReportToItem(
    {
      id: "r3",
      name: "Report",
      datasetTables: [""],
    },
    { syncedAt: 1_000 },
  );
  expect(item?.metadata["upstreamDataModelKeys"]).toEqual([]);
});

test("returns null when id is missing", () => {
  expect(
    mapPowerBiReportToItem({ name: "Sales", datasetTables: ["revenue"] }, { syncedAt: 1_000 }),
  ).toBeNull();
});

test("returns null when name is missing", () => {
  expect(
    mapPowerBiReportToItem({ id: "r1", datasetTables: ["revenue"] }, { syncedAt: 1_000 }),
  ).toBeNull();
});

test("returns null when id is empty string", () => {
  expect(mapPowerBiReportToItem({ id: "", name: "Sales" }, { syncedAt: 1_000 })).toBeNull();
});

test("returns null when raw is not a record", () => {
  expect(mapPowerBiReportToItem(null, { syncedAt: 1_000 })).toBeNull();
  expect(mapPowerBiReportToItem("string", { syncedAt: 1_000 })).toBeNull();
  expect(mapPowerBiReportToItem(42, { syncedAt: 1_000 })).toBeNull();
});

test("workspace and datasetId default to null when absent", () => {
  const item = mapPowerBiReportToItem({ id: "r4", name: "Dash" }, { syncedAt: 1_000 });
  expect(item?.metadata["workspace"]).toBeNull();
  expect(item?.metadata["datasetId"]).toBeNull();
});

test("upstreamDataModelKeys is empty when datasetTables is absent", () => {
  const item = mapPowerBiReportToItem({ id: "r5", name: "Dash" }, { syncedAt: 1_000 });
  expect(item?.metadata["upstreamDataModelKeys"]).toEqual([]);
});

test("bodyPreview includes workspace when present", () => {
  const item = mapPowerBiReportToItem(
    { id: "r6", name: "Dash", workspace: "MyWS" },
    { syncedAt: 1_000 },
  );
  expect(item?.bodyPreview).toContain("MyWS");
});

test("non-string entries in datasetTables are filtered out", () => {
  const item = mapPowerBiReportToItem(
    { id: "r7", name: "Dash", datasetTables: [42, null, "sales"] },
    { syncedAt: 1_000 },
  );
  expect(item?.metadata["upstreamDataModelKeys"]).toEqual(["sales"]);
});
