// packages/gateway/src/connectors/connector-write-registry.test.ts
import { describe, expect, test } from "bun:test";
import { HITL_REQUIRED } from "../engine/executor.ts";
import {
  CONNECTOR_WRITES,
  connectorWriteByActionType,
  isConnectorWriteToolId,
} from "./connector-write-registry.ts";
import { GITOPS_ML_WRITES } from "./gitops-ml-write-tools.ts";
import { WAREHOUSE_BI_WRITES } from "./warehouse-write-tools.ts";

describe("connector-write-registry — union of all connector writes", () => {
  test("union is exactly warehouse ∪ gitops-ml with no collision", () => {
    expect(CONNECTOR_WRITES).toHaveLength(WAREHOUSE_BI_WRITES.length + GITOPS_ML_WRITES.length);
    expect(new Set(CONNECTOR_WRITES.map((x) => x.toolId)).size).toBe(CONNECTOR_WRITES.length);
    expect(new Set(CONNECTOR_WRITES.map((x) => x.actionType)).size).toBe(CONNECTOR_WRITES.length);
  });

  test("predicate spans both groups", () => {
    expect(isConnectorWriteToolId("snowflake_tag_set")).toBe(true);
    expect(isConnectorWriteToolId("argocd_app_sync")).toBe(true);
    expect(isConnectorWriteToolId("argocd_get")).toBe(false);
  });

  test("lookup spans both groups", () => {
    expect(connectorWriteByActionType("tableau.workbook.refresh")?.toolId).toBe(
      "tableau_workbook_refresh",
    );
    expect(connectorWriteByActionType("flux.helmrelease.reconcile")?.toolId).toBe(
      "flux_helmrelease_reconcile",
    );
    expect(connectorWriteByActionType("nope.nope")).toBeUndefined();
  });
});

describe("connector writes are all HITL-gated (I26 ↔ I2 completeness)", () => {
  test("every connector-write action type is in HITL_REQUIRED", () => {
    for (const x of CONNECTOR_WRITES) {
      expect(HITL_REQUIRED.has(x.actionType)).toBe(true);
    }
  });

  test("every tool id flagged by isConnectorWriteToolId maps to a HITL action type", () => {
    for (const x of CONNECTOR_WRITES) {
      expect(isConnectorWriteToolId(x.toolId)).toBe(true);
      expect(HITL_REQUIRED.has(x.actionType)).toBe(true);
    }
  });
});
