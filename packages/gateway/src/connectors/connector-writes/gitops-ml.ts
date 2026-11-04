// packages/gateway/src/connectors/connector-writes/gitops-ml.ts
import { type ConnectorWriteRow, type PreviewFieldTemplate, row, withPreview } from "./types.ts";

/** A plain text field; the label defaults to the key. */
function text(key: string, label?: string, whenUnset?: string): PreviewFieldTemplate {
  return {
    key,
    label: label ?? key,
    kind: "text",
    ...(whenUnset === undefined ? {} : { whenUnset }),
  };
}

export const GITOPS_ML_ROWS: readonly ConnectorWriteRow[] = [
  withPreview(row("argocd_app_sync", "argocd.app.sync", "write", 4), {
    target: "{name}",
    summary: "Sync Argo CD application {name}",
    // The upstream handler omits both from the request when unset; Argo CD then uses the
    // application's own target revision and does not prune.
    fields: [
      text("revision", undefined, "(not set: the application's configured target revision)"),
      text("prune", undefined, "(not set: the server default, no pruning)"),
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
      text(
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
      text("stage"),
      text(
        "archiveExisting",
        "Archive existing versions",
        "(not set: defaults to false, keeps the other versions)",
      ),
    ],
  }),
];
