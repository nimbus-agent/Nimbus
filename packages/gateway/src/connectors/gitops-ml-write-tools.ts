// packages/gateway/src/connectors/gitops-ml-write-tools.ts
import { type ConnectorWrite, w } from "./connector-write.ts";

/** Phase 6 Slice 9 W1 — GitOps + ML write actions (kept in sync with HITL_REQUIRED_BACKING in
 *  engine/executor.ts; the connector-write-registry drift test ties the two lists together). */
export const GITOPS_ML_WRITES: readonly ConnectorWrite[] = [
  w("argocd.app.sync", "argocd_app_sync", "argocd"),
  w("argocd.app.rollback", "argocd_app_rollback", "argocd"),
  w("flux.kustomization.reconcile", "flux_kustomization_reconcile", "flux"),
  w("flux.helmrelease.reconcile", "flux_helmrelease_reconcile", "flux"),
  w("mlflow.model.promote", "mlflow_model_promote", "mlflow"),
  w("mlflow.model.transition_stage", "mlflow_model_transition_stage", "mlflow"),
];

export const GITOPS_ML_WRITE_TOOL_IDS: ReadonlySet<string> = new Set(
  GITOPS_ML_WRITES.map((x) => x.toolId),
);

const BY_ACTION_TYPE: ReadonlyMap<string, ConnectorWrite> = new Map(
  GITOPS_ML_WRITES.map((x) => [x.actionType, x]),
);

export function isGitopsMlWriteToolId(toolId: string): boolean {
  return GITOPS_ML_WRITE_TOOL_IDS.has(toolId);
}

export function gitopsMlWriteByActionType(actionType: string): ConnectorWrite | undefined {
  return BY_ACTION_TYPE.get(actionType);
}
