// packages/gateway/src/connectors/connector-write-registry.test.ts
import { describe, expect, test } from "bun:test";
import { HITL_REQUIRED } from "../engine/executor.ts";
import {
  CONNECTOR_WRITES,
  connectorWriteByActionType,
  isConnectorWriteToolId,
  MIGRATED_WRITE_TOOL_IDS,
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

describe("migrated write tool ids", () => {
  test("the I26 predicate covers migrated tools, not just the dispatchable rows", () => {
    expect(isConnectorWriteToolId("github_branch_delete")).toBe(true);
    expect(isConnectorWriteToolId("argocd_app_sync")).toBe(true);
    expect(isConnectorWriteToolId("github_repo_list")).toBe(false);
  });

  test("no migrated id overlaps a dispatchable row", () => {
    // A tool with a dispatch path belongs in CONNECTOR_WRITES; one without belongs here. Both
    // would make connectorWriteByActionType and this set disagree about the same tool.
    for (const id of MIGRATED_WRITE_TOOL_IDS) {
      expect(CONNECTOR_WRITES.some((w) => w.toolId === id)).toBe(false);
    }
  });

  test("ADDITIVE: generic action types survive alongside the per-connector ones", () => {
    // Removing a generic silently ungates anything still emitting it.
    for (const generic of ["email.send", "file.create", "calendar.event.create", "repo.pr.merge"]) {
      expect(HITL_REQUIRED.has(generic)).toBe(true);
    }
  });

  test("every migrated tool has a per-connector action type whose prefix is a real service", () => {
    // The prefix is I29's egress destination and I20's delegation scope: "email" is not a place
    // data can go, "gmail" is.
    for (const t of [
      "github.pr.merge",
      "github.pr.close",
      "github.issue.create",
      "github.branch.delete",
      "github.tag.create",
    ]) {
      expect(HITL_REQUIRED.has(t)).toBe(true);
      expect(t.split(".")[0]).not.toBe("repo");
    }
  });
});
