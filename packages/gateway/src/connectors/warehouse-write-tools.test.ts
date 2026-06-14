// packages/gateway/src/connectors/warehouse-write-tools.test.ts
import { describe, expect, test } from "bun:test";
import {
  isWarehouseWriteToolId,
  WAREHOUSE_BI_WRITE_TOOL_IDS,
  WAREHOUSE_BI_WRITES,
  warehouseWriteByActionType,
} from "./warehouse-write-tools.ts";

describe("warehouse-write-tools — single source of truth", () => {
  test("exposes exactly the twelve write actions, 2 per connector", () => {
    expect(WAREHOUSE_BI_WRITES).toHaveLength(12);
    const services = new Set(WAREHOUSE_BI_WRITES.map((w) => w.service));
    expect([...services].sort()).toEqual([
      "bigeye",
      "looker",
      "montecarlo",
      "powerbi",
      "snowflake",
      "tableau",
    ]);
    for (const svc of services) {
      expect(WAREHOUSE_BI_WRITES.filter((w) => w.service === svc)).toHaveLength(2);
    }
  });

  test("action types and tool ids are unique and well-formed", () => {
    const types = WAREHOUSE_BI_WRITES.map((w) => w.actionType);
    const ids = WAREHOUSE_BI_WRITES.map((w) => w.toolId);
    expect(new Set(types).size).toBe(12);
    expect(new Set(ids).size).toBe(12);
    for (const w of WAREHOUSE_BI_WRITES) {
      expect(w.actionType.startsWith(`${w.service}.`)).toBe(true);
      expect(w.toolId.startsWith(`${w.service}_`)).toBe(true);
    }
  });

  test("WAREHOUSE_BI_WRITE_TOOL_IDS + isWarehouseWriteToolId agree", () => {
    expect(WAREHOUSE_BI_WRITE_TOOL_IDS.size).toBe(12);
    expect(isWarehouseWriteToolId("tableau_datasource_refresh")).toBe(true);
    expect(isWarehouseWriteToolId("tableau_list")).toBe(false);
    expect(isWarehouseWriteToolId("")).toBe(false);
  });

  test("warehouseWriteByActionType resolves and rejects", () => {
    expect(warehouseWriteByActionType("powerbi.dataset.refresh")?.toolId).toBe(
      "powerbi_dataset_refresh",
    );
    expect(warehouseWriteByActionType("notion.page.create")).toBeUndefined();
  });
});
