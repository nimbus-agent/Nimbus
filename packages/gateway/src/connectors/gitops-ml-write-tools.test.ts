// packages/gateway/src/connectors/gitops-ml-write-tools.test.ts
import { describe, expect, test } from "bun:test";
import {
  GITOPS_ML_WRITE_TOOL_IDS,
  GITOPS_ML_WRITES,
  gitopsMlWriteByActionType,
  isGitopsMlWriteToolId,
} from "./gitops-ml-write-tools.ts";

describe("gitops-ml-write-tools — single source of truth", () => {
  test("exposes exactly six write actions across argocd/flux/mlflow", () => {
    expect(GITOPS_ML_WRITES).toHaveLength(6);
    expect([...new Set(GITOPS_ML_WRITES.map((x) => x.service))].sort()).toEqual([
      "argocd",
      "flux",
      "mlflow",
    ]);
  });

  test("action types and tool ids are unique and service-prefixed", () => {
    const types = GITOPS_ML_WRITES.map((x) => x.actionType);
    const ids = GITOPS_ML_WRITES.map((x) => x.toolId);
    expect(new Set(types).size).toBe(6);
    expect(new Set(ids).size).toBe(6);
    for (const x of GITOPS_ML_WRITES) {
      expect(x.actionType.startsWith(`${x.service}.`)).toBe(true);
      expect(x.toolId.startsWith(`${x.service}_`)).toBe(true);
    }
  });

  test("predicate + set agree; lookup resolves and rejects", () => {
    expect(GITOPS_ML_WRITE_TOOL_IDS.size).toBe(6);
    expect(isGitopsMlWriteToolId("argocd_app_sync")).toBe(true);
    expect(isGitopsMlWriteToolId("argocd_get")).toBe(false);
    expect(gitopsMlWriteByActionType("mlflow.model.promote")?.toolId).toBe("mlflow_model_promote");
    expect(gitopsMlWriteByActionType("snowflake.tag.set")).toBeUndefined();
  });
});
