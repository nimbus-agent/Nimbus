// packages/gateway/src/connectors/connector-write-registry.test.ts
import { describe, expect, test } from "bun:test";
import { HITL_REQUIRED } from "../engine/executor.ts";
import {
  CONNECTOR_WRITES,
  connectorWriteByActionType,
  isConnectorWriteToolId,
} from "./connector-write-registry.ts";
import { CONNECTOR_WRITE_ROWS } from "./connector-writes/index.ts";

describe("connector-write-registry — union of all connector writes", () => {
  test("dispatchable writes are exactly the write-transport rows, with no collision", () => {
    expect(CONNECTOR_WRITES).toHaveLength(
      CONNECTOR_WRITE_ROWS.filter((r) => r.transport === "write").length,
    );
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

describe("I26 matches a write however the federated runner names it", () => {
  test("a server-namespaced write id is a write — that is the form a session executes", () => {
    // `@mastra/mcp` keys a session's tools `<server>_<tool>`, and the federated runner looks the
    // requested id up verbatim, so these are the ids a peer would actually have to send.
    for (const id of [
      "tableau_tableau_datasource_refresh", // warehouse/BI
      "argocd_argocd_app_sync", // GitOps/ML
      "kubernetes_k8s_pod_delete", // migrated
      "aws_aws_ec2_instance_stop", // reclassified in connectors 0.2.2
      "github_actions_gha_run_trigger", // a server key that itself contains `_`
      "x_y_z_slack_message_post_dm", // any depth of prefix
    ]) {
      expect(isConnectorWriteToolId(id)).toBe(true);
    }
  });

  test("a namespaced read is still a read", () => {
    for (const id of [
      "tableau_tableau_list",
      "aws_aws_ecs_service_list",
      "github_github_pr_get",
      "kubernetes_k8s_pod_list",
    ]) {
      expect(isConnectorWriteToolId(id)).toBe(false);
    }
  });

  test("only a `_`-delimited SUFFIX names a write — not a lookalike, not a prefix", () => {
    expect(isConnectorWriteToolId("xtableau_datasource_refresh")).toBe(false);
    expect(isConnectorWriteToolId("tableau_datasource_refresh_status")).toBe(false);
    expect(isConnectorWriteToolId("tableau_datasource_refreshx")).toBe(false);
    expect(isConnectorWriteToolId("")).toBe(false);
    expect(isConnectorWriteToolId("_")).toBe(false);
  });

  test("its cost is bounded by the longest write id, not by the caller's id", () => {
    // A peer controls `toolId`. Testing every `_`-suffix would hash O(n²) characters on this one;
    // only suffixes no longer than a write id can match, so the bounded scan is linear.
    const hostile = "_".repeat(200_000);
    const started = performance.now();
    expect(isConnectorWriteToolId(hostile)).toBe(false);
    expect(isConnectorWriteToolId(`${hostile}k8s_pod_delete`)).toBe(true);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe("migrated write tool ids", () => {
  test("the I26 predicate covers migrated tools, not just the dispatchable rows", () => {
    expect(isConnectorWriteToolId("github_branch_delete")).toBe(true);
    expect(isConnectorWriteToolId("argocd_app_sync")).toBe(true);
    expect(isConnectorWriteToolId("github_repo_list")).toBe(false);
  });

  test("no mesh row overlaps a dispatchable row", () => {
    // A tool with a dispatch path belongs in CONNECTOR_WRITES; one without belongs here. Both
    // would make connectorWriteByActionType and this set disagree about the same tool.
    for (const r of CONNECTOR_WRITE_ROWS.filter((x) => x.transport === "mesh")) {
      expect(CONNECTOR_WRITES.some((w) => w.toolId === r.toolId)).toBe(false);
      expect(connectorWriteByActionType(r.actionType)?.toolId).not.toBe(r.toolId);
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
