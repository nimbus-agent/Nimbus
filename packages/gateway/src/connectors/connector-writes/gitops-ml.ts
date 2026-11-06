// packages/gateway/src/connectors/connector-writes/gitops-ml.ts
import {
  type ConnectorWriteRow,
  fieldlessWrite,
  row,
  textField,
  withConfirm,
  withPreview,
} from "./types.ts";

export const GITOPS_ML_ROWS: readonly ConnectorWriteRow[] = [
  withConfirm(
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
    { template: "sync {name}" },
  ),
  withConfirm(
    fieldlessWrite(
      "argocd_app_rollback",
      "argocd.app.rollback",
      4,
      "{name}",
      "Roll back Argo CD application {name} to history id {id}",
    ),
    { template: "rollback {name}@{id}" },
  ),
  withConfirm(
    fieldlessWrite(
      "flux_kustomization_reconcile",
      "flux.kustomization.reconcile",
      4,
      "{namespace}/{name}",
      "Reconcile Flux Kustomization {namespace}/{name}",
    ),
    { template: "reconcile kustomization {namespace}/{name}" },
  ),
  withConfirm(
    fieldlessWrite(
      "flux_helmrelease_reconcile",
      "flux.helmrelease.reconcile",
      4,
      "{namespace}/{name}",
      "Reconcile Flux HelmRelease {namespace}/{name}",
    ),
    { template: "reconcile helmrelease {namespace}/{name}" },
  ),
  withConfirm(
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
    { template: "promote {name}/v{version}" },
  ),
  withConfirm(
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
    { template: "transition {name}/v{version} to {stage}" },
  ),
];
