// packages/gateway/src/connectors/connector-writes/gitops-ml.ts
import {
  ARGOCD_ROLLBACK_HISTORY_GUARD,
  argocdReadArgs,
  fluxReadArgs,
  mlflowReadArgs,
  selectArgocdRollback,
  selectArgocdSync,
  selectFluxResource,
  selectMlflowModel,
} from "./gitops-readers.ts";
import {
  type BeforeStateReader,
  type ConnectorWritePreviewTemplate,
  type ConnectorWriteRow,
  row,
  textField,
  withBefore,
  withConfirm,
  withPreview,
} from "./types.ts";

/** A wave 4 `write` row: typed preview, a before-state read of the target and a confirm text. */
function gitopsRow(
  toolId: string,
  actionType: string,
  preview: ConnectorWritePreviewTemplate,
  before: BeforeStateReader,
  template: string,
): ConnectorWriteRow {
  return withConfirm(
    withBefore(withPreview(row(toolId, actionType, "write", 4), preview), before),
    {
      template,
    },
  );
}

/** The two Flux reconciles differ only in the resource kind and its words. */
function fluxReconcileRow(
  toolId: string,
  actionType: string,
  kind: "kustomization" | "helm_release",
  label: string,
  word: string,
): ConnectorWriteRow {
  return gitopsRow(
    toolId,
    actionType,
    {
      target: "{namespace}/{name}",
      summary: `Reconcile Flux ${label} {namespace}/{name}`,
      fields: [],
    },
    {
      tool: "flux_get",
      argKeys: ["namespace", "name"],
      args: fluxReadArgs(kind),
      select: selectFluxResource,
    },
    `reconcile ${word} {namespace}/{name}`,
  );
}

// D1: every row reads the target before the prompt (Argo CD, Flux and MLflow state). `revision` is
// shown in full and not scanned (see the free-text table in d1-templates.test.ts).
export const GITOPS_ML_ROWS: readonly ConnectorWriteRow[] = [
  gitopsRow(
    "argocd_app_sync",
    "argocd.app.sync",
    {
      target: "{name}",
      summary: "Sync Argo CD application {name}",
      // The upstream handler omits both from the request when unset; Argo CD then uses the
      // application's own target revision and does not prune.
      fields: [
        textField("revision", undefined, "(not set: the application's configured target revision)"),
        textField("prune", undefined, "(not set: the server default, no pruning)"),
      ],
    },
    {
      tool: "argocd_get",
      argKeys: ["name"],
      args: argocdReadArgs,
      select: selectArgocdSync,
    },
    "sync {name}",
  ),
  gitopsRow(
    "argocd_app_rollback",
    "argocd.app.rollback",
    {
      target: "{name}",
      summary: "Roll back Argo CD application {name} to history id {id}",
      fields: [textField("id", "History id")],
    },
    {
      tool: "argocd_get",
      // `id` is declared for the select and the guard, never sent to the read.
      argKeys: ["name", "id"],
      args: argocdReadArgs,
      select: selectArgocdRollback,
      guard: ARGOCD_ROLLBACK_HISTORY_GUARD,
    },
    "rollback {name}@{id}",
  ),
  fluxReconcileRow(
    "flux_kustomization_reconcile",
    "flux.kustomization.reconcile",
    "kustomization",
    "Kustomization",
    "kustomization",
  ),
  fluxReconcileRow(
    "flux_helmrelease_reconcile",
    "flux.helmrelease.reconcile",
    "helm_release",
    "HelmRelease",
    "helmrelease",
  ),
  gitopsRow(
    "mlflow_model_promote",
    "mlflow.model.promote",
    {
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
    },
    {
      tool: "mlflow_get",
      // `version` and `archiveExisting` are declared for the select, never sent to the read.
      argKeys: ["name", "version", "archiveExisting"],
      args: mlflowReadArgs,
      select: selectMlflowModel("promote"),
    },
    "promote {name}/v{version}",
  ),
  gitopsRow(
    "mlflow_model_transition_stage",
    "mlflow.model.transition_stage",
    {
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
    },
    {
      tool: "mlflow_get",
      argKeys: ["name", "version", "stage", "archiveExisting"],
      args: mlflowReadArgs,
      select: selectMlflowModel("transition"),
    },
    "transition {name}/v{version} to {stage}",
  ),
];
