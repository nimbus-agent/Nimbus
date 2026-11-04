// packages/gateway/src/connectors/connector-writes/gitops-ml.ts
import { type ConnectorWriteRow, row, textField, withPreview } from "./types.ts";

export const GITOPS_ML_ROWS: readonly ConnectorWriteRow[] = [
  withPreview(row("argocd_app_sync", "argocd.app.sync", "write", 4), {
    target: "{name}",
    summary: "Sync Argo CD application {name}",
    // The upstream handler omits both from the request when unset; Argo CD then uses the
    // application's own target revision and does not prune.
    fields: [
      textField("revision", undefined, "(not set: the application's configured target revision)"),
      textField("prune", undefined, "(not set: the server default, no pruning)"),
    ],
  }),
  withPreview(row("argocd_app_rollback", "argocd.app.rollback", "write", 4), {
    target: "{name}",
    summary: "Roll back Argo CD application {name} to history id {id}",
    fields: [],
  }),
  withPreview(row("flux_kustomization_reconcile", "flux.kustomization.reconcile", "write", 4), {
    target: "{namespace}/{name}",
    summary: "Reconcile Flux Kustomization {namespace}/{name}",
    fields: [],
  }),
  withPreview(row("flux_helmrelease_reconcile", "flux.helmrelease.reconcile", "write", 4), {
    target: "{namespace}/{name}",
    summary: "Reconcile Flux HelmRelease {namespace}/{name}",
    fields: [],
  }),
  withPreview(row("mlflow_model_promote", "mlflow.model.promote", "write", 4), {
    target: "{name} v{version}",
    summary: "Promote MLflow model {name} version {version}",
    // The upstream handler does `archiveExisting ?? true`.
    fields: [
      textField(
        "archiveExisting",
        "Archive existing versions",
        "(not set: defaults to true, archives the current version)",
      ),
    ],
  }),
  withPreview(row("mlflow_model_transition_stage", "mlflow.model.transition_stage", "write", 4), {
    target: "{name} v{version}",
    summary: "Move MLflow model {name} version {version} to {stage}",
    // The upstream handler does `archiveExisting ?? false`.
    fields: [
      textField("stage"),
      textField(
        "archiveExisting",
        "Archive existing versions",
        "(not set: defaults to false, keeps the other versions)",
      ),
    ],
  }),
];
