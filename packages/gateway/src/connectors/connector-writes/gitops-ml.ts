// packages/gateway/src/connectors/connector-writes/gitops-ml.ts
import { type ConnectorWriteRow, row } from "./types.ts";

export const GITOPS_ML_ROWS: readonly ConnectorWriteRow[] = [
  row("argocd_app_sync", "argocd.app.sync", "write", 4),
  row("argocd_app_rollback", "argocd.app.rollback", "write", 4),
  row("flux_kustomization_reconcile", "flux.kustomization.reconcile", "write", 4),
  row("flux_helmrelease_reconcile", "flux.helmrelease.reconcile", "write", 4),
  row("mlflow_model_promote", "mlflow.model.promote", "write", 4),
  row("mlflow_model_transition_stage", "mlflow.model.transition_stage", "write", 4),
];
