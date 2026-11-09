// Phase 9.7 D1: the typed previews, before-readers and guards of the Wave 4 rows the model is
// offered (merges, deletes, CI runs, AWS, GitOps, ML, warehouse). Each row's template keys are its
// tool's input-schema keys in the installed `@nimbus-dev/connectors` (the D-X PR1 release), checked
// twice: a spelled-out constant AND the installed source. The reply fixtures follow the shape each
// connector's writer or projection produces (GitHub, GitLab, Bitbucket, Jenkins, GitHub Actions,
// CircleCI, Argo CD, Flux, MLflow and Graph return the service's JSON as is; the GitHub commit,
// the CircleCI job, the EC2 instance, the ECS service and the Snowflake object are the
// connector's own projections).
import { describe, expect, test } from "bun:test";
import { dirname } from "node:path";

import { stripComments } from "../../../../../scripts/structure-audit/lib.ts";
import { createBeforeStateRunner, WAVE4_BEFORE_REFUSAL } from "../../engine/before-state.ts";
import { serviceOf } from "../../engine/service-of.ts";
import type { PlannedAction } from "../../engine/types.ts";
import { isReadOnlyToolId } from "../../share/read-tool-registry.ts";
import { isConnectorWriteToolId } from "../connector-write-registry.ts";
import { mcpClientToolKey } from "../lazy-mesh/tool-map.ts";
import {
  constStatement,
  declaredInputKeys,
  matchingClose,
  withSchemaArgumentDeclarations,
} from "../testing/connector-schema-source.ts";
import {
  installedConnectorsPackageRoot,
  readConnectorPackageSources,
  scanWriteToolRegistrations,
} from "../testing/connector-write-registrations.ts";
import { renderConfirmText } from "./confirm.ts";
import {
  D1_SHA,
  FULL_INPUT,
  GOLDEN_FULL,
  GOLDEN_MIN,
  MIN_INPUT,
} from "./d1-golden.test-helpers.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import { isModelOfferableRow, MODEL_NEVER_OFFERED_TOOL_IDS } from "./model-offerable.ts";
import { modelWriteRefusal } from "./model-write-refusals.ts";
import { buildConnectorWritePreviewFrom, renderConnectorWritePreviewLines } from "./preview.ts";
import { type ConnectorWriteRow, previewTemplateKeys } from "./types.ts";

/** The 27 Wave 4 rows the model is offered (each has a reader and a confirm text). */
const OFFERED = [
  "github_pr_merge",
  "github_branch_delete",
  "github_tag_create",
  "gitlab_mr_merge",
  "jenkins_build_trigger",
  "jenkins_build_abort",
  "gha_run_trigger",
  "gha_run_cancel",
  "circleci_pipeline_trigger",
  "circleci_job_cancel",
  "gitlab_pipeline_retry",
  "gitlab_pipeline_cancel",
  "aws_ecs_service_update",
  "aws_lambda_invoke",
  "aws_ec2_instance_stop",
  "aws_ec2_instance_start",
  "argocd_app_sync",
  "argocd_app_rollback",
  "flux_kustomization_reconcile",
  "flux_helmrelease_reconcile",
  "mlflow_model_promote",
  "mlflow_model_transition_stage",
  "snowflake_tag_set",
  "snowflake_comment_set",
  "onedrive_item_delete",
  "outlook_calendar_delete",
  "apple_calendar_event_delete",
] as const;

/** A preview and a reader, but never offered (no head-commit precondition to send). */
const READER_NEVER_OFFERED = ["bitbucket_pr_merge"] as const;

/**
 * A preview and a confirm text but no reader: their natural reads are `az` / `gcloud` reads, which
 * the code-execution class keeps out of `isReadOnlyToolId`, so the before-read dispatcher would
 * refuse them (see `cloud-infra.ts`).
 */
const PREVIEW_ONLY = [
  "azure_app_service_restart",
  "azure_aks_node_pool_scale",
  "gcp_cloud_run_deploy",
] as const;

/** The two multi-file commit writes (D1c): bound, previewed with a diff and offered; tested in commit-bound.test.ts. */
const COMMITS = ["github_file_commit", "gitlab_commit_create"] as const;

const WITH_PREVIEW = [...OFFERED, ...READER_NEVER_OFFERED, ...PREVIEW_ONLY] as const;
type D1Row = (typeof WITH_PREVIEW)[number];

/** The input keys the installed source declares for each write (sorted). */
const DECLARED_KEYS: Readonly<Record<D1Row, readonly string[]>> = {
  github_pr_merge: ["commitTitle", "mergeMethod", "owner", "pullNumber", "repo", "sha"],
  github_branch_delete: ["branch", "owner", "repo"],
  github_tag_create: ["owner", "repo", "sha", "tag"],
  gitlab_mr_merge: [
    "mergeCommitMessage",
    "mergeRequestIid",
    "projectPath",
    "sha",
    "shouldRemoveSourceBranch",
    "squash",
  ],
  bitbucket_pr_merge: ["mergeStrategy", "message", "pullRequestId", "repoFull"],
  jenkins_build_trigger: ["jobName"],
  jenkins_build_abort: ["buildNumber", "jobName"],
  gha_run_trigger: ["inputs", "owner", "ref", "repo", "workflowId"],
  gha_run_cancel: ["owner", "repo", "runId"],
  circleci_pipeline_trigger: ["branch", "parameters", "projectSlug", "tag"],
  circleci_job_cancel: ["jobNumber", "projectSlug"],
  gitlab_pipeline_retry: ["pipelineId", "projectPath"],
  gitlab_pipeline_cancel: ["pipelineId", "projectPath"],
  aws_ecs_service_update: ["cluster", "service", "taskDefinition"],
  aws_lambda_invoke: ["functionName", "payloadJson"],
  aws_ec2_instance_stop: ["instanceIds"],
  aws_ec2_instance_start: ["instanceIds"],
  azure_app_service_restart: ["name", "resourceGroup", "subscriptionId"],
  azure_aks_node_pool_scale: [
    "clusterName",
    "nodeCount",
    "poolName",
    "resourceGroup",
    "subscriptionId",
  ],
  gcp_cloud_run_deploy: ["image", "projectId", "region", "service"],
  argocd_app_sync: ["name", "prune", "revision"],
  argocd_app_rollback: ["id", "name"],
  flux_kustomization_reconcile: ["name", "namespace"],
  flux_helmrelease_reconcile: ["name", "namespace"],
  mlflow_model_promote: ["archiveExisting", "name", "version"],
  mlflow_model_transition_stage: ["archiveExisting", "name", "stage", "version"],
  snowflake_tag_set: ["object", "tag", "value"],
  snowflake_comment_set: ["comment", "object"],
  onedrive_item_delete: ["itemId"],
  outlook_calendar_delete: ["eventId"],
  apple_calendar_event_delete: ["href"],
};

/** The reader of each row with one: the read tool, the keys `args` sends, the extra keys declared. */
const READERS: Readonly<
  Record<
    (typeof OFFERED)[number] | (typeof READER_NEVER_OFFERED)[number],
    { readonly tool: string; readonly sent: readonly string[]; readonly extra: readonly string[] }
  >
> = {
  github_pr_merge: {
    tool: "github_pr_get",
    sent: ["owner", "pullNumber", "repo"],
    extra: ["sha"],
  },
  github_branch_delete: {
    tool: "github_ref_get",
    sent: ["owner", "ref", "repo"],
    extra: ["branch"],
  },
  github_tag_create: {
    tool: "github_commit_get",
    sent: ["ref", "repoFull"],
    extra: ["owner", "repo", "sha"],
  },
  gitlab_mr_merge: {
    tool: "gitlab_mr_get",
    sent: ["mergeRequestIid", "projectPath"],
    extra: ["sha"],
  },
  bitbucket_pr_merge: { tool: "bitbucket_pr_get", sent: ["pullRequestId", "repoFull"], extra: [] },
  jenkins_build_trigger: { tool: "jenkins_job_get", sent: ["jobName"], extra: [] },
  jenkins_build_abort: { tool: "jenkins_build_get", sent: ["buildNumber", "jobName"], extra: [] },
  gha_run_trigger: {
    tool: "gha_run_list",
    sent: ["branch", "owner", "perPage", "repo"],
    extra: ["ref"],
  },
  gha_run_cancel: { tool: "gha_run_get", sent: ["owner", "repo", "runId"], extra: [] },
  circleci_pipeline_trigger: {
    tool: "circleci_pipeline_list",
    sent: ["projectSlug"],
    extra: ["branch", "tag"],
  },
  circleci_job_cancel: {
    tool: "circleci_job_get",
    sent: ["jobNumber", "projectSlug"],
    extra: [],
  },
  gitlab_pipeline_retry: {
    tool: "gitlab_pipeline_get",
    sent: ["pipelineId", "projectPath"],
    extra: [],
  },
  gitlab_pipeline_cancel: {
    tool: "gitlab_pipeline_get",
    sent: ["pipelineId", "projectPath"],
    extra: [],
  },
  aws_ecs_service_update: {
    tool: "aws_ecs_service_get",
    sent: ["cluster", "service"],
    extra: ["taskDefinition"],
  },
  aws_lambda_invoke: { tool: "aws_lambda_list", sent: [], extra: ["functionName"] },
  aws_ec2_instance_stop: {
    tool: "aws_ec2_instance_get",
    sent: ["instanceId"],
    extra: ["instanceIds"],
  },
  aws_ec2_instance_start: {
    tool: "aws_ec2_instance_get",
    sent: ["instanceId"],
    extra: ["instanceIds"],
  },
  argocd_app_sync: { tool: "argocd_get", sent: ["name"], extra: [] },
  argocd_app_rollback: { tool: "argocd_get", sent: ["name"], extra: ["id"] },
  flux_kustomization_reconcile: {
    tool: "flux_get",
    sent: ["kind", "name", "namespace"],
    extra: [],
  },
  flux_helmrelease_reconcile: {
    tool: "flux_get",
    sent: ["kind", "name", "namespace"],
    extra: [],
  },
  mlflow_model_promote: {
    tool: "mlflow_get",
    sent: ["name"],
    extra: ["archiveExisting", "version"],
  },
  mlflow_model_transition_stage: {
    tool: "mlflow_get",
    sent: ["name"],
    extra: ["archiveExisting", "stage", "version"],
  },
  snowflake_tag_set: { tool: "snowflake_object_metadata_get", sent: ["object"], extra: ["tag"] },
  snowflake_comment_set: { tool: "snowflake_object_metadata_get", sent: ["object"], extra: [] },
  onedrive_item_delete: { tool: "onedrive_item_get", sent: ["itemId"], extra: [] },
  outlook_calendar_delete: { tool: "outlook_calendar_get", sent: ["eventId"], extra: [] },
  apple_calendar_event_delete: { tool: "apple_calendar_event_get", sent: ["href"], extra: [] },
};

const sources = readConnectorPackageSources(installedConnectorsPackageRoot());
const scan = scanWriteToolRegistrations(sources);
const codeByFile = new Map(sources.map((s) => [s.rel, stripComments(s.text)]));

/** The file a tool is registered in, and the declared keys of its schema. */
function writeRegistration(toolId: string): { file: string; keys: string[] } {
  if (toolId.startsWith("gitlab_pipeline_")) {
    // Registered through a forwarding function; the input is `gitlabPipelineGetSchema`.
    return { file: "connectors/gitlab/src/tools.ts", keys: ["pipelineId", "projectPath"] };
  }
  const reg = scan.registrations.find((r) => r.id === toolId);
  if (reg === undefined)
    throw new Error(`${toolId}: not a registered write in the installed package`);
  const code = codeByFile.get(reg.file) ?? "";
  const call = code.slice(reg.span[0], reg.span[1] + 1);
  return {
    file: reg.file,
    keys: declaredInputKeys(withSchemaArgumentDeclarations(sources, code, call)),
  };
}

/**
 * The call that registers the READ tool `toolId` in `code`: `registerX("<id>", ...)`, from its `(`
 * to the matching `)`. A registration guarded by Outlook's `outlookToolShouldRegister("<id>", ...)`
 * is not the registration itself, so that callee is skipped.
 */
function registrationCall(code: string, toolId: string): string | undefined {
  for (const m of code.matchAll(new RegExp(`(\\w+)\\(\\s*"${toolId}"\\s*,`, "g"))) {
    if (m[1] === "outlookToolShouldRegister") continue;
    const open = m.index + (m[1]?.length ?? 0);
    const close = matchingClose(code, open);
    if (close >= 0) return code.slice(open, close + 1);
  }
  return undefined;
}

function readRegistration(toolId: string): { file: string; keys: string[] } {
  const hits = sources.flatMap((s) => {
    const code = codeByFile.get(s.rel) ?? "";
    const call = registrationCall(code, toolId);
    return call === undefined ? [] : [{ rel: s.rel, code, call }];
  });
  if (hits.length !== 1) throw new Error(`${toolId}: registered in ${String(hits.length)} files`);
  const [hit] = hits;
  if (hit === undefined) throw new Error(toolId);
  // The iCloud read passes `deleteArgs.shape`: the object it spreads is declared beside it.
  const shapeOf = /(\w+)\.shape/.exec(hit.call)?.[1];
  const shapeDecl = shapeOf === undefined ? "" : (constStatement(hit.code, shapeOf) ?? "");
  return {
    file: hit.rel,
    keys: declaredInputKeys(
      `${withSchemaArgumentDeclarations(sources, hit.code, hit.call)}
${shapeDecl}`,
    ),
  };
}

const connectorDir = (file: string): string => dirname(dirname(file));
const sortedKeys = (keys: Iterable<string>): string[] =>
  [...keys].sort((a, b) => a.localeCompare(b));

function rowOf(toolId: string): ConnectorWriteRow {
  const r = CONNECTOR_WRITE_ROWS.find((x) => x.toolId === toolId);
  if (r === undefined) throw new Error(`no row ${toolId}`);
  return r;
}

function actionOf(toolId: string, input: Record<string, unknown>): PlannedAction {
  const r = rowOf(toolId);
  return {
    type: r.actionType,
    origin: "model",
    payload: { mcpToolId: mcpClientToolKey(serviceOf(r.actionType), toolId), input },
  };
}

function linesOf(toolId: string, input: Record<string, unknown>): string[] {
  const p = buildConnectorWritePreviewFrom(
    actionOf(toolId, input),
    CONNECTOR_WRITE_ROWS,
    () => "personal",
  );
  if (p === undefined) throw new Error(`no preview for ${toolId}`);
  expect(p.otherFields, toolId).toEqual([]);
  return renderConnectorWritePreviewLines(p);
}

describe("D1 rows: shape and offerability", () => {
  test("the sets are disjoint and every id is a real Wave 4 row", () => {
    const all = [...OFFERED, ...READER_NEVER_OFFERED, ...PREVIEW_ONLY, ...COMMITS];
    expect(new Set(all).size).toBe(all.length);
    expect(OFFERED).toHaveLength(27);
    for (const id of all) {
      const r = rowOf(id);
      expect(r.wave, id).toBe(4);
      expect(r.transport === "mesh" || r.transport === "write", id).toBe(true);
      expect(isConnectorWriteToolId(id), id).toBe(true);
      expect(r.confirm, id).toBeDefined();
    }
  });

  test("exactly the 27 are offered through a before-state; the Bitbucket merge and the three preview-only rows are not", () => {
    for (const id of OFFERED) {
      const r = rowOf(id);
      expect(r.preview, id).toBeDefined();
      expect(r.before, id).toBeDefined();
      expect(isModelOfferableRow(r), id).toBe(true);
    }
    for (const id of [...READER_NEVER_OFFERED, ...PREVIEW_ONLY]) {
      expect(isModelOfferableRow(rowOf(id)), id).toBe(false);
    }
    expect(rowOf("bitbucket_pr_merge").before).toBeDefined();
    expect(MODEL_NEVER_OFFERED_TOOL_IDS.has("bitbucket_pr_merge")).toBe(true);
    for (const id of PREVIEW_ONLY) {
      expect(rowOf(id).preview, id).toBeDefined();
      expect(rowOf(id).before, id).toBeUndefined();
    }
    // The commits are offered through a bound prepare step instead (D1c), not a before-state.
    for (const id of COMMITS) {
      expect(rowOf(id).before, id).toBeUndefined();
      expect(rowOf(id).bound, id).toBeDefined();
      expect(isModelOfferableRow(rowOf(id)), id).toBe(true);
    }
  });

  test("the four Kubernetes and GKE rows, the Pulumi apply and the two D2 classified-only rows are untouched: confirm only (the three plan-bound iac rows are D2's)", () => {
    for (const id of [
      "k8s_rollout_restart",
      "k8s_deployment_scale",
      "k8s_pod_delete",
      "gcp_gke_workload_restart",
      "iac_pulumi_up",
      "iac_cloudformation_changeset_discard",
      "k8s_manifest_apply",
    ]) {
      const r = rowOf(id);
      expect(r.preview, id).toBeUndefined();
      expect(r.before, id).toBeUndefined();
      expect(r.confirm, id).toBeDefined();
      expect(isModelOfferableRow(r), id).toBe(false);
    }
  });

  test("the template keys equal the installed schema keys, and the spelled-out keys equal the source", () => {
    for (const id of WITH_PREVIEW) {
      const preview = rowOf(id).preview;
      if (preview === undefined) throw new Error(id);
      const declared = writeRegistration(id).keys;
      expect(declared.length, `${id}: the schema shape was not recognised`).toBeGreaterThan(0);
      expect(sortedKeys(declared), id).toEqual([...DECLARED_KEYS[id]]);
      expect(sortedKeys(previewTemplateKeys(preview)), id).toEqual([...DECLARED_KEYS[id]]);
    }
  });

  test("every reader tool is a registered read of the SAME connector as its write, and a read the dispatcher accepts", () => {
    for (const id of [...OFFERED, ...READER_NEVER_OFFERED]) {
      const reader = rowOf(id).before;
      if (reader === undefined) throw new Error(id);
      expect(reader.tool, id).toBe(READERS[id].tool);
      expect(isReadOnlyToolId(reader.tool), id).toBe(true);
      expect(isConnectorWriteToolId(reader.tool), id).toBe(false);
      const read = readRegistration(reader.tool);
      expect(connectorDir(read.file), id).toBe(connectorDir(writeRegistration(id).file));
    }
  });

  test("what args sends is a subset of the keys the read tool declares and equals the spelled-out set; argKeys adds the keys the select reads", () => {
    for (const id of [...OFFERED, ...READER_NEVER_OFFERED]) {
      const want = READERS[id];
      const reader = rowOf(id).before;
      if (reader === undefined) throw new Error(id);
      const declared = new Set(readRegistration(reader.tool).keys);
      const sent = reader.args(MIN_INPUT[id] ?? {});
      expect(sent, `${id}: args refused the minimal input`).toBeDefined();
      const sentKeys = sortedKeys(Object.keys(sent ?? {}));
      expect(sentKeys, id).toEqual([...want.sent]);
      for (const k of sentKeys) expect(declared.has(k), `${id}: ${k}`).toBe(true);
      // every argKey is a write key the preview names
      const named = previewTemplateKeys(
        rowOf(id).preview ?? { target: "", summary: "", fields: [] },
      );
      for (const k of reader.argKeys) expect(named.has(k), `${id}: ${k}`).toBe(true);
      // the extra keys are exactly the argKeys the read does not need under that name
      const extra = reader.argKeys.filter((k) => !want.sent.includes(k));
      expect(sortedKeys(extra), id).toEqual([...want.extra]);
    }
  });
});

describe("D1 previews: golden lines, and every unset default says what the connector really does", () => {
  for (const id of WITH_PREVIEW) {
    test(`golden lines (required keys only): ${id}`, () => {
      expect(linesOf(id, MIN_INPUT[id] ?? {})).toEqual([...(GOLDEN_MIN[id] ?? [])]);
    });
  }

  for (const [id, input] of Object.entries(FULL_INPUT)) {
    test(`golden lines (every optional key set): ${id}`, () => {
      expect(linesOf(id, { ...input })).toEqual([...(GOLDEN_FULL[id] ?? [])]);
    });
  }

  test("every whenUnset text shows for the minimal input and is gone when the key is set", () => {
    let checked = 0;
    for (const id of WITH_PREVIEW) {
      const fields = rowOf(id).preview?.fields ?? [];
      for (const f of fields) {
        if (f.whenUnset === undefined) continue;
        const min = linesOf(id, MIN_INPUT[id] ?? {}).join("\n");
        expect(min, `${id}.${f.key}`).toContain(f.whenUnset);
        const full = FULL_INPUT[id];
        if (full === undefined || full[f.key] === undefined) {
          throw new Error(`${id}.${f.key}: no fully-set input to prove the default disappears`);
        }
        expect(linesOf(id, { ...full }).join("\n"), `${id}.${f.key}`).not.toContain(f.whenUnset);
        checked++;
      }
    }
    // github merge 3 + gitlab merge 4 + bitbucket 2 + gha 2 + circleci 3 + lambda 1 + argocd 2
    // + mlflow 2 + snowflake 1 = 20.
    expect(checked).toBe(20);
  });

  test("the unset-default texts state the connector's real default, from the installed writers", () => {
    const text = (id: string) => linesOf(id, MIN_INPUT[id] ?? {}).join("\n");
    // gha_run_trigger sends `ref ?? "main"`; circleci sends `tag` if set, else `branch ?? "main"`.
    expect(text("gha_run_trigger")).toContain("Branch or tag: (not set: main)");
    expect(text("circleci_pipeline_trigger")).toContain(
      "Branch: (not set: main, unless a tag is given)",
    );
    // aws_lambda_invoke sends no payload at all when `payloadJson` is unset.
    expect(text("aws_lambda_invoke")).toContain("(not set: no payload)");
    // mlflow: promote does `archiveExisting ?? true`, the transition `?? false`.
    expect(text("mlflow_model_promote")).toContain("defaults to true");
    expect(text("mlflow_model_transition_stage")).toContain("defaults to false");
    // Merges: an unpinned head says NOT PINNED on both services that can pin.
    expect(text("github_pr_merge")).toContain("NOT PINNED");
    expect(text("gitlab_mr_merge")).toContain("NOT PINNED");
    // Snowflake: no value is an UNSET TAG.
    expect(text("snowflake_tag_set")).toContain("the tag is REMOVED");
  });

  test("a merge or delete summary says Nimbus cannot undo it", () => {
    for (const id of [
      "github_pr_merge",
      "gitlab_mr_merge",
      "bitbucket_pr_merge",
      "outlook_calendar_delete",
      "apple_calendar_event_delete",
      "onedrive_item_delete",
    ]) {
      expect(linesOf(id, MIN_INPUT[id] ?? {}).join("\n"), id).toMatch(/cannot undo/);
    }
  });

  test("the golden table covers exactly the rows with a preview", () => {
    expect(sortedKeys(Object.keys(GOLDEN_MIN))).toEqual(sortedKeys(WITH_PREVIEW));
    expect(sortedKeys(Object.keys(MIN_INPUT))).toEqual(sortedKeys(WITH_PREVIEW));
  });
});

describe("D1 confirm text", () => {
  test("every offered row renders a confirm text from its minimal input", () => {
    for (const id of [...OFFERED, ...READER_NEVER_OFFERED, ...PREVIEW_ONLY]) {
      const out = renderConfirmText(rowOf(id), MIN_INPUT[id] ?? {});
      expect(out.ok, id).toBe(true);
    }
  });

  test("an Outlook event id ending in base64 padding is typeable and shown in the preview (an = is a value character)", () => {
    const id = "AAMkAGI2THVSAAA=";
    const out = renderConfirmText(rowOf("outlook_calendar_delete"), { eventId: id });
    expect(out).toEqual({ ok: true, text: "outlook/delete THVSAAA=" });
    const lines = linesOf("outlook_calendar_delete", { eventId: id }).join("\n");
    expect(lines).toContain(id);
  });

  test("no confirm template has an = in its literal text (the character is for values only)", () => {
    for (const r of CONNECTOR_WRITE_ROWS) {
      if (r.confirm === undefined) continue;
      expect(r.confirm.template, r.toolId).not.toContain("=");
      if (r.confirm.whenUnset !== undefined) {
        expect(r.confirm.whenUnset.template, r.toolId).not.toContain("=");
      }
    }
  });

  test("the Cloud Run deploy names its image by the last 8 characters", () => {
    const out = renderConfirmText(rowOf("gcp_cloud_run_deploy"), {
      projectId: "p1",
      region: "us-east1",
      service: "api",
      image: "gcr.io/p1/api@sha256:00000000deadbeef",
    });
    expect(out).toEqual({ ok: true, text: "gcp/deploy p1/us-east1/api deadbeef" });
  });

  test("a slashed branch is typeable, and one holding its following separator is refused", () => {
    const r = rowOf("github_branch_delete");
    expect(renderConfirmText(r, { owner: "acme", repo: "api", branch: "feat/x" })).toEqual({
      ok: true,
      text: "github/delete acme/api@feat/x",
    });
    expect(renderConfirmText(r, { owner: "acme", repo: "a@pi", branch: "x" }).ok).toBe(false);
  });
});

describe("D1 free text is shown in full and not scanned (plan section 2.8)", () => {
  /** The identity of a target: a name, id, ref or path, not prose. */
  const IDENTITY = new Set([
    "owner",
    "repo",
    "pullNumber",
    "branch",
    "tag",
    "sha",
    "projectPath",
    "mergeRequestIid",
    "repoFull",
    "pullRequestId",
    "jobName",
    "buildNumber",
    "workflowId",
    "ref",
    "runId",
    "projectSlug",
    "jobNumber",
    "pipelineId",
    "cluster",
    "service",
    "taskDefinition",
    "functionName",
    "instanceIds",
    "subscriptionId",
    "resourceGroup",
    "name",
    "clusterName",
    "poolName",
    "nodeCount",
    "projectId",
    "region",
    "id",
    "namespace",
    "version",
    "stage",
    "object",
    "itemId",
    "eventId",
    "href",
  ]);
  /** A choice among the connector's fixed values, or a flag. */
  const FLAGS = new Set([
    "mergeMethod",
    "mergeStrategy",
    "squash",
    "shouldRemoveSourceBranch",
    "prune",
    "archiveExisting",
  ]);
  /** Text the model writes that lands in git history, a build, a BI tool or a function. */
  const FREE_TEXT: Readonly<Record<string, string>> = {
    commitTitle:
      "the merge commit's title: git history, which renders no Markdown or HTML and notifies no one",
    mergeCommitMessage:
      "the merge commit's message: git history, which renders no Markdown or HTML and notifies no one",
    message:
      "the Bitbucket merge commit's message (the merge is never offered to the model at all)",
    inputs:
      "workflow_dispatch inputs: strings handed to the workflow, which the owner approves by typing the workflow",
    parameters:
      "CircleCI pipeline parameters: strings handed to the pipeline, which the owner approves by typing the project",
    payloadJson:
      "the Lambda's payload, shown as JSON in full: the function's own code decides what it does",
    comment:
      "the Snowflake table comment: metadata a BI tool shows as plain text, never rendered as markup",
    value:
      "the Snowflake tag value: governance metadata, a plain string literal (sfLiteral) in the statement",
    revision: "the Argo CD target revision: a git ref or chart version Argo CD resolves, not prose",
    image:
      "the container image reference the deploy pulls: the Cloud Run row is preview-only (no reader)",
  };

  test("every preview key of every D1 row is an identity, a flag or in the free-text table, and the table has no stale entry", () => {
    const used = new Set<string>();
    for (const id of WITH_PREVIEW) {
      for (const key of previewTemplateKeys(
        rowOf(id).preview ?? { target: "", summary: "", fields: [] },
      )) {
        used.add(key);
        const classes = [IDENTITY.has(key), FLAGS.has(key), key in FREE_TEXT].filter(Boolean);
        expect(
          classes.length,
          `${id}.${key} must be exactly one of identity, flag or free text`,
        ).toBe(1);
      }
    }
    expect(sortedKeys(Object.keys(FREE_TEXT)), "a stale free-text entry").toEqual(
      sortedKeys([...used].filter((k) => k in FREE_TEXT)),
    );
    for (const [key, reason] of Object.entries(FREE_TEXT)) {
      expect(reason.trim().length, key).toBeGreaterThan(20);
    }
  });

  test("the free-text fields are not scanned by either door: a loud value on every one is not refused", () => {
    const loud = "<!channel> @all @o/t <at/> /close /assign @bob ![x](https://evil.example/p.png)";
    for (const id of OFFERED) {
      const preview = rowOf(id).preview;
      if (preview === undefined) throw new Error(id);
      const input: Record<string, unknown> = { ...MIN_INPUT[id] };
      for (const key of Object.keys(FREE_TEXT)) {
        if (previewTemplateKeys(preview).has(key) && typeof input[key] !== "object") {
          input[key] = loud;
        }
      }
      expect(
        modelWriteRefusal(id, input, { chatops: undefined, kb: undefined }),
        id,
      ).toBeUndefined();
    }
  });

  test("a benign input is not refused on any of the 27 offered rows", () => {
    for (const id of OFFERED) {
      expect(
        modelWriteRefusal(id, { ...MIN_INPUT[id] }, { chatops: undefined, kb: undefined }),
        id,
      ).toBeUndefined();
      expect(
        modelWriteRefusal(
          id,
          { ...MIN_INPUT[id], ...FULL_INPUT[id] },
          { chatops: undefined, kb: undefined },
        ),
        id,
      ).toBeUndefined();
    }
  });
});

// ---- readers: args, selectors, guards ---------------------------------------------------------

const mcp = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const fieldMap = (fields: readonly { label: string; value: string }[]): Record<string, string> =>
  Object.fromEntries(fields.map((f) => [f.label, f.value]));

function selectOf(toolId: string, reply: unknown, picked: Record<string, unknown> = {}) {
  const reader = rowOf(toolId).before;
  if (reader === undefined) throw new Error(toolId);
  return fieldMap(reader.select(reply, picked, undefined));
}

/** The fixed reason of a row's guard; the row must have one. */
function guardReasonOf(toolId: string): string {
  const reason = rowOf(toolId).before?.guard?.reason;
  if (reason === undefined) throw new Error(`${toolId} has no guard`);
  return reason;
}

/** The input the first before-read was dispatched with. */
function sentInput(a: PlannedAction | undefined): unknown {
  const payload: unknown = a?.payload;
  return typeof payload === "object" && payload !== null
    ? (payload as { input?: unknown }).input
    : undefined;
}

/** Run a row's real reader through the real runner against a fake dispatcher. */
async function readThrough(
  toolId: string,
  input: Record<string, unknown>,
  reply: unknown | (() => unknown),
) {
  const seen: PlannedAction[] = [];
  const out = await createBeforeStateRunner().read(actionOf(toolId, input), {
    gate: async (a) => {
      seen.push(a);
      return "proceed";
    },
    dispatch: async () => (typeof reply === "function" ? (reply as () => unknown)() : reply),
  });
  return { out, seen };
}

describe("D1 readers' args: the keys they need, else no read", () => {
  test("a missing, empty or ill-typed key means no read, for every reader", () => {
    for (const id of [...OFFERED, ...READER_NEVER_OFFERED]) {
      const reader = rowOf(id).before;
      if (reader === undefined) throw new Error(id);
      // The keys `args` reads are the ones it sends or derives; blanking any ONE of the argKeys
      // it needs must not produce a read. (Keys it never reads, e.g. a guard's `sha`, are skipped.)
      const base = { ...MIN_INPUT[id] };
      const sent = reader.args(base);
      expect(sent, id).toBeDefined();
      let refused = 0;
      for (const key of reader.argKeys) {
        for (const bad of ["", 0, -1, null, {}, []]) {
          const out = reader.args({ ...base, [key]: bad });
          if (out === undefined) refused++;
        }
      }
      expect(refused, `${id}: nothing was ever refused`).toBeGreaterThan(0);
    }
  });

  test("github_pr_get and the pull number: a digit string is a number, a bad one is no read", () => {
    const r = rowOf("github_pr_merge").before;
    expect(r?.args({ owner: "a", repo: "b", pullNumber: "42" })).toEqual({
      owner: "a",
      repo: "b",
      pullNumber: 42,
    });
    for (const bad of [0, -1, 1.5, "4x", "", null, undefined]) {
      expect(r?.args({ owner: "a", repo: "b", pullNumber: bad }), String(bad)).toBeUndefined();
    }
  });

  test("the branch delete reads heads/<branch>; the tag create reads owner/repo", () => {
    expect(
      rowOf("github_branch_delete").before?.args({ owner: "a", repo: "b", branch: "feat/x" }),
    ).toEqual({
      owner: "a",
      repo: "b",
      ref: "heads/feat/x",
    });
    expect(
      rowOf("github_tag_create").before?.args({ owner: "a", repo: "b", sha: "abc1234" }),
    ).toEqual({
      repoFull: "a/b",
      ref: "abc1234",
    });
  });

  test("the workflow dispatch reads the branch it will use: ref, else main; an ill-typed ref is no read", () => {
    const r = rowOf("gha_run_trigger").before;
    expect(r?.args({ owner: "a", repo: "b" })).toEqual({
      owner: "a",
      repo: "b",
      branch: "main",
      perPage: 1,
    });
    expect(r?.args({ owner: "a", repo: "b", ref: "release" })).toEqual({
      owner: "a",
      repo: "b",
      branch: "release",
      perPage: 1,
    });
    for (const bad of ["", 7, null, {}]) {
      expect(r?.args({ owner: "a", repo: "b", ref: bad }), String(bad)).toBeUndefined();
    }
  });

  test("the Lambda list takes no input; a missing function name is no read", () => {
    const r = rowOf("aws_lambda_invoke").before;
    expect(r?.args({ functionName: "f" })).toEqual({});
    expect(r?.args({})).toBeUndefined();
  });

  test("the EC2 read takes the write's instanceIds as instanceId; a multi-id array is no read", () => {
    const r = rowOf("aws_ec2_instance_stop").before;
    expect(r?.args({ instanceIds: "i-0a1b2c3d" })).toEqual({ instanceId: "i-0a1b2c3d" });
    expect(r?.args({ instanceIds: ["i-0a1", "i-0b2"] })).toBeUndefined();
  });

  test("Flux reads the kind of its own row", () => {
    expect(
      rowOf("flux_kustomization_reconcile").before?.args({ namespace: "n", name: "a" }),
    ).toEqual({
      kind: "kustomization",
      namespace: "n",
      name: "a",
    });
    expect(rowOf("flux_helmrelease_reconcile").before?.args({ namespace: "n", name: "a" })).toEqual(
      {
        kind: "helm_release",
        namespace: "n",
        name: "a",
      },
    );
  });
});

// ---- group A -----------------------------------------------------------------------------------

const GH_PR = {
  title: "Fix login",
  state: "open",
  merged: false,
  draft: false,
  mergeable_state: "clean",
  head: { ref: "fix-x", sha: D1_SHA },
  base: { ref: "main" },
  commits: 3,
  changed_files: 5,
  additions: 40,
  deletions: 7,
  user: { login: "alice" },
  body: "BODY-MUST-NOT-SHOW",
};

const GL_MR = {
  title: "Add cache",
  state: "opened",
  source_branch: "feat/cache",
  target_branch: "main",
  sha: D1_SHA,
  draft: false,
  detailed_merge_status: "mergeable",
  has_conflicts: false,
  squash: true,
  force_remove_source_branch: false,
  changes_count: "4",
  description: "DESCRIPTION-MUST-NOT-SHOW",
};

describe("D1 group A selectors", () => {
  test("GitHub merge: title, state, branches, head commit, draft, mergeable, changes, author; never the body; bare and MCP-wrapped", () => {
    const expected = {
      Title: "Fix login",
      State: "open",
      Branches: "fix-x -> main",
      "Head commit": D1_SHA,
      Draft: "no",
      Mergeable: "clean",
      Changes: "3 commits, 5 files, +40 -7",
      Author: "alice",
    };
    expect(selectOf("github_pr_merge", GH_PR)).toEqual(expected);
    expect(selectOf("github_pr_merge", mcp(GH_PR))).toEqual(expected);
    expect(JSON.stringify(selectOf("github_pr_merge", GH_PR))).not.toContain("BODY-MUST-NOT-SHOW");
  });

  test("GitHub merge: a merged or closed pull request says so; a bare title and partial numbers still show", () => {
    expect(selectOf("github_pr_merge", { ...GH_PR, merged: true, state: "closed" })["State"]).toBe(
      "merged: it is already merged",
    );
    expect(selectOf("github_pr_merge", { ...GH_PR, state: "closed" })["State"]).toBe(
      "closed: it is not open",
    );
    const bare = selectOf("github_pr_merge", { title: "T", additions: 1 });
    expect(bare).toEqual({ Title: "T", Changes: "+1 -?" });
  });

  test("GitHub branch delete: the branch and the full head commit it holds", () => {
    const reply = { ref: "heads/fix-x", kind: "branch", sha: D1_SHA };
    expect(selectOf("github_branch_delete", reply, { branch: "fix-x" })).toEqual({
      Branch: "fix-x",
      "Head commit": D1_SHA,
    });
    expect(selectOf("github_branch_delete", mcp(reply), {})["Branch"]).toBe("(unknown)");
    expect(() => selectOf("github_branch_delete", { sha: "not-a-sha" })).toThrow();
  });

  test("GitHub tag create: the resolved sha beside the requested one, message, author and date", () => {
    const reply = {
      sha: D1_SHA,
      message: "Fix the thing",
      authorName: "Al",
      authorDate: "2026-11-01T10:00:00Z",
      parents: [],
    };
    const expected = {
      "Resolves to": D1_SHA,
      "Requested sha": "aaaaaaa",
      Message: "Fix the thing",
      Author: "Al",
      Authored: "2026-11-01T10:00:00Z",
    };
    expect(selectOf("github_tag_create", reply, { sha: "aaaaaaa" })).toEqual(expected);
    expect(selectOf("github_tag_create", mcp(reply), { sha: "aaaaaaa" })).toEqual(expected);
    expect(selectOf("github_tag_create", { sha: D1_SHA }, {})["Requested sha"]).toBe(
      "(not a string)",
    );
  });

  test("GitLab merge: title, state, branches, head, draft, merge status, conflicts, own settings, changes", () => {
    const expected = {
      Title: "Add cache",
      State: "opened",
      Branches: "feat/cache -> main",
      "Head commit": D1_SHA,
      Draft: "no",
      "Merge status": "mergeable",
      Conflicts: "no",
      "Squash (the merge request's own setting)": "yes",
      "Removes source branch (the merge request's own setting)": "no",
      Changes: "4",
    };
    expect(selectOf("gitlab_mr_merge", GL_MR)).toEqual(expected);
    expect(selectOf("gitlab_mr_merge", mcp(GL_MR))).toEqual(expected);
    expect(JSON.stringify(selectOf("gitlab_mr_merge", GL_MR))).not.toContain("DESCRIPTION-MUST");
    // `merge_status` stands in for `detailed_merge_status`.
    expect(
      selectOf("gitlab_mr_merge", { title: "T", merge_status: "can_be_merged" })["Merge status"],
    ).toBe("can_be_merged");
  });

  const BB_PR = {
    title: "Add retries",
    state: "OPEN",
    source: { branch: { name: "feat" }, commit: { hash: "abc123" } },
    destination: { branch: { name: "main" } },
    author: { display_name: "Al" },
    close_source_branch: true,
  };

  test("Bitbucket merge: title, state, branches, source commit, author, closes source branch", () => {
    expect(selectOf("bitbucket_pr_merge", BB_PR)).toEqual({
      Title: "Add retries",
      State: "OPEN",
      Branches: "feat -> main",
      "Source commit": "abc123",
      Author: "Al",
      "Closes source branch": "yes",
    });
    expect(selectOf("bitbucket_pr_merge", mcp({ title: "T" }))).toEqual({ Title: "T" });
  });

  const JOB = {
    name: "deploy-prod",
    fullName: "folder/deploy-prod",
    buildable: true,
    inQueue: false,
    lastBuild: { number: 118 },
    lastSuccessfulBuild: { number: 117 },
    lastFailedBuild: { number: 110 },
    color: "blue",
  };

  test("Jenkins job: name (fullName first), buildable, in queue, last builds, status", () => {
    const expected = {
      Job: "folder/deploy-prod",
      Buildable: "yes",
      "In queue": "no",
      "Last build": "#118",
      "Last successful": "#117",
      "Last failed": "#110",
      Status: "blue",
    };
    expect(selectOf("jenkins_build_trigger", JOB)).toEqual(expected);
    expect(selectOf("jenkins_build_trigger", mcp(JOB))).toEqual(expected);
    expect(selectOf("jenkins_build_trigger", { name: "only-name" })).toEqual({ Job: "only-name" });
  });

  test("Jenkins build: a running build says yes; a finished one says aborting does nothing", () => {
    const running = {
      fullDisplayName: "deploy-prod #118",
      building: true,
      result: null,
      timestamp: 1_700_000_000_000,
      duration: 0,
    };
    expect(selectOf("jenkins_build_abort", running)).toEqual({
      Build: "deploy-prod #118",
      Building: "yes",
      Started: "2023-11-14T22:13:20.000Z",
      Duration: "0 ms",
    });
    const done = selectOf(
      "jenkins_build_abort",
      mcp({ ...running, building: false, result: "SUCCESS" }),
    );
    expect(done["Building"]).toBe("no: it is not running, so aborting does nothing");
    expect(done["Result"]).toBe("SUCCESS");
    // An unreadable timestamp is omitted, never shown as an invalid date.
    expect(
      Object.hasOwn(
        selectOf("jenkins_build_abort", { fullDisplayName: "b", timestamp: 1e20 }),
        "Started",
      ),
    ).toBe(false);
  });

  const RUN = {
    name: "CI",
    run_number: 812,
    status: "completed",
    conclusion: "success",
    event: "push",
    head_sha: D1_SHA,
    run_started_at: "2026-11-01T10:00:00Z",
    actor: { login: "al" },
  };

  test("GitHub Actions dispatch: the latest run on the branch the dispatch will use, any workflow", () => {
    const reply = { total_count: 1, workflow_runs: [RUN] };
    const expected = {
      "Branch (latest run of ANY workflow)": "main",
      Workflow: "CI",
      "Run number": "812",
      Status: "completed",
      Conclusion: "success",
      Event: "push",
      Commit: D1_SHA,
      Started: "2026-11-01T10:00:00Z",
      Actor: "al",
    };
    expect(selectOf("gha_run_trigger", reply, {})).toEqual(expected);
    expect(
      selectOf("gha_run_trigger", mcp(reply), { ref: "release" })[
        "Branch (latest run of ANY workflow)"
      ],
    ).toBe("release");
    expect(selectOf("gha_run_trigger", { workflow_runs: [] }, { ref: "x" })).toEqual({
      "Branch (latest run of ANY workflow)": "x",
      "Latest run": "(none on this branch)",
    });
  });

  test("GitHub Actions cancel: the run, and a completed run says cancelling does nothing", () => {
    const run = { ...RUN, head_branch: "main", status: "in_progress", conclusion: null };
    expect(selectOf("gha_run_cancel", run)).toEqual({
      Workflow: "CI",
      "Run number": "812",
      Branch: "main",
      Status: "in_progress",
      Event: "push",
      Commit: D1_SHA,
    });
    expect(selectOf("gha_run_cancel", mcp(RUN))["Status"]).toBe(
      "completed: it has already finished, so cancelling does nothing",
    );
    expect(selectOf("gha_run_cancel", { display_title: "Fix", status: "queued" })["Workflow"]).toBe(
      "Fix",
    );
  });

  test("CircleCI trigger: the latest pipeline of the project on ANY branch (a tag wins over a branch)", () => {
    const pipeline = {
      id: "u1",
      number: 204,
      state: "created",
      vcs: { branch: "main" },
      trigger: { type: "webhook" },
      created_at: "2026-11-01T10:00:00Z",
    };
    expect(
      selectOf("circleci_pipeline_trigger", { items: [pipeline], next_page_token: null }),
    ).toEqual({
      "Latest pipeline (ANY branch)": "#204",
      State: "created",
      "Branch or tag": "main",
      Trigger: "webhook",
      Created: "2026-11-01T10:00:00Z",
    });
    expect(
      selectOf(
        "circleci_pipeline_trigger",
        mcp({ items: [{ ...pipeline, vcs: { branch: "main", tag: "v1" } }] }),
      )["Branch or tag"],
    ).toBe("v1");
    expect(selectOf("circleci_pipeline_trigger", { items: [] })).toEqual({
      "Latest pipeline (ANY branch)": "(none)",
    });
  });

  test("CircleCI trigger: a branch AND a tag together are refused (the connector sends the tag alone); either alone is read normally", async () => {
    const reason = guardReasonOf("circleci_pipeline_trigger");
    expect(reason).toBe("set either branch or tag, not both: the pipeline runs on the tag alone");
    const reply = mcp({ items: [] });
    const base = { projectSlug: "gh/acme/api" };
    for (const extra of [{ branch: "main", tag: "v1" }]) {
      const { out, seen } = await readThrough(
        "circleci_pipeline_trigger",
        { ...base, ...extra },
        reply,
      );
      expect(out).toEqual({ status: "refused", reason });
      // the guard-only keys are never sent to the read
      expect(seen.map((a) => JSON.stringify(a.payload))).not.toContain("tag");
    }
    for (const extra of [{ branch: "main" }, { tag: "v1" }, { branch: "main", tag: null }, {}]) {
      const { out } = await readThrough("circleci_pipeline_trigger", { ...base, ...extra }, reply);
      expect(out?.status, JSON.stringify(extra)).toBe("ok");
    }
  });

  test("CircleCI job cancel: the connector's projection; a stopped job says cancelling does nothing", () => {
    const job = {
      name: "build",
      number: 31,
      status: "running",
      startedAt: "2026-11-01T10:00:00Z",
      webUrl: "https://app.circleci.com/x",
      pipelineId: "p-1",
    };
    expect(selectOf("circleci_job_cancel", job)).toEqual({
      Name: "build",
      Status: "running",
      Started: "2026-11-01T10:00:00Z",
      "Pipeline id": "p-1",
    });
    const stopped = selectOf(
      "circleci_job_cancel",
      mcp({ ...job, status: "success", stoppedAt: "2026-11-01T10:05:00Z" }),
    );
    expect(stopped["Status"]).toBe("success: it has already finished, so cancelling does nothing");
    expect(stopped["Stopped"]).toBe("2026-11-01T10:05:00Z");
    // A job with a number but no name is still identified.
    expect(selectOf("circleci_job_cancel", { number: 31 })["Name"]).toBe("job 31");
  });

  const PIPE = {
    id: 55,
    status: "running",
    ref: "main",
    sha: D1_SHA,
    source: "push",
    created_at: "2026-11-01T10:00:00Z",
    finished_at: null,
    user: { username: "al" },
  };

  test("GitLab pipeline retry shows the pipeline; cancel says a pipeline that is not running does nothing", () => {
    const expected = {
      Status: "running",
      Ref: "main",
      Commit: D1_SHA,
      Source: "push",
      Created: "2026-11-01T10:00:00Z",
      User: "al",
    };
    expect(selectOf("gitlab_pipeline_retry", PIPE)).toEqual(expected);
    expect(selectOf("gitlab_pipeline_cancel", mcp(PIPE))).toEqual(expected);
    expect(selectOf("gitlab_pipeline_cancel", { ...PIPE, status: "success" })["Status"]).toBe(
      "success: it is not running, so cancelling does nothing",
    );
    expect(
      selectOf("gitlab_pipeline_retry", { ...PIPE, status: "failed", user: { name: "Al" } })[
        "User"
      ],
    ).toBe("Al");
  });
});

// ---- group A guards, through the real runner ----------------------------------------------------

const OTHER_SHA = "b".repeat(40);

describe("D1 guards: the GitHub merge sha (round-1 fix 1)", () => {
  const input = { owner: "acme", repo: "api", pullNumber: 42 };

  test("the head equals the sha: allowed, and the read sent no sha", async () => {
    const { out, seen } = await readThrough(
      "github_pr_merge",
      { ...input, sha: D1_SHA },
      mcp(GH_PR),
    );
    expect(out?.status).toBe("ok");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.type).toBe("github.before.read");
    expect(sentInput(seen[0])).toEqual(input);
  });

  test("a different sha, an uppercase sha, a malformed sha and an absent sha are all refused with the guard's reason", async () => {
    const reason = guardReasonOf("github_pr_merge");
    expect(reason).toBeDefined();
    for (const sha of [OTHER_SHA, D1_SHA.toUpperCase(), "abc", 7, null, undefined]) {
      const { out } = await readThrough("github_pr_merge", { ...input, sha }, mcp(GH_PR));
      expect(out, String(sha)).toEqual({ status: "refused", reason });
    }
  });

  test("a reply without a head sha refuses, and so does a failed read (with the guard's reason, not the generic one)", async () => {
    const reason = guardReasonOf("github_pr_merge");
    const noHead = await readThrough("github_pr_merge", { ...input, sha: D1_SHA }, { title: "T" });
    expect(noHead.out).toEqual({ status: "refused", reason });
    const failed = await readThrough("github_pr_merge", { ...input, sha: D1_SHA }, () => {
      throw new Error("boom");
    });
    expect(failed.out).toEqual({ status: "refused", reason });
    expect(reason).not.toBe(WAVE4_BEFORE_REFUSAL);
  });
});

describe("D1 guards: the GitHub tag sha prefix (round-1 fix 7)", () => {
  const input = { owner: "acme", repo: "api", tag: "v1.2.0" };
  const commit = { sha: D1_SHA, message: "m", authorName: "a", authorDate: "d", parents: [] };

  test("a prefix of the resolved sha is allowed (case-insensitive), the full sha too", async () => {
    for (const sha of ["aaaaaaa", "AAAAAAA", D1_SHA]) {
      const { out, seen } = await readThrough("github_tag_create", { ...input, sha }, mcp(commit));
      expect(out?.status, sha).toBe("ok");
      expect(sentInput(seen[0])).toEqual({
        repoFull: "acme/api",
        ref: sha,
      });
    }
  });

  test("a sha the read did not resolve to, a branch name and a malformed sha are refused", async () => {
    const reason = guardReasonOf("github_tag_create");
    for (const sha of ["bbbbbbb", "release-1", "abc123", "xyzxyzx", 7, null, undefined]) {
      const { out } = await readThrough("github_tag_create", { ...input, sha }, mcp(commit));
      expect(out, String(sha)).toEqual({ status: "refused", reason });
    }
    const noSha = await readThrough(
      "github_tag_create",
      { ...input, sha: "aaaaaaa" },
      { message: "m" },
    );
    expect(noSha.out).toEqual({ status: "refused", reason });
  });
});

describe("D1 guards: the GitLab merge sha", () => {
  const input = { projectPath: "grp/app", mergeRequestIid: 7 };

  test("no sha: the guard does not apply, the preview shows the merge request, and the write proceeds NOT PINNED", async () => {
    const { out } = await readThrough("gitlab_mr_merge", input, mcp(GL_MR));
    expect(out?.status).toBe("ok");
    expect(linesOf("gitlab_mr_merge", input).join("\n")).toContain("NOT PINNED");
    // a null sha is the same as none
    const nul = await readThrough("gitlab_mr_merge", { ...input, sha: null }, mcp(GL_MR));
    expect(nul.out?.status).toBe("ok");
  });

  test("an equal sha is allowed, case-insensitively", async () => {
    for (const sha of [D1_SHA, D1_SHA.toUpperCase()]) {
      const { out } = await readThrough("gitlab_mr_merge", { ...input, sha }, mcp(GL_MR));
      expect(out?.status, sha).toBe("ok");
    }
  });

  test("a different sha is refused with the fixed reason; a non-string sha too", async () => {
    const reason = "the pinned sha is not the merge request's current head commit";
    for (const sha of [OTHER_SHA, 7, "", {}]) {
      const { out } = await readThrough("gitlab_mr_merge", { ...input, sha }, mcp(GL_MR));
      expect(out, String(sha)).toEqual({ status: "refused", reason });
    }
  });

  test("a failed read: with a sha, the guard's reason; without one, the generic Wave 4 reason", async () => {
    const boom = () => {
      throw new Error("boom");
    };
    const pinned = await readThrough("gitlab_mr_merge", { ...input, sha: D1_SHA }, boom);
    expect(pinned.out).toEqual({
      status: "refused",
      reason: "the pinned sha is not the merge request's current head commit",
    });
    const unpinned = await readThrough("gitlab_mr_merge", input, boom);
    expect(unpinned.out).toEqual({ status: "refused", reason: WAVE4_BEFORE_REFUSAL });
  });
});

// ---- group B -----------------------------------------------------------------------------------

describe("D1 group B selectors (AWS)", () => {
  const FN = {
    FunctionName: "charge-card",
    Runtime: "nodejs20.x",
    Handler: "index.handler",
    MemorySize: 256,
    Timeout: 30,
    LastModified: "2026-10-01T10:00:00.000+0000",
    Description: "Charges a card",
  };

  test("Lambda: the function picked out of the first page by name", () => {
    const reply = { Functions: [{ FunctionName: "other" }, FN] };
    const expected = {
      Function: "charge-card",
      Runtime: "nodejs20.x",
      Handler: "index.handler",
      Memory: "256 MB",
      Timeout: "30 s",
      "Last modified": "2026-10-01T10:00:00.000+0000",
      Description: "Charges a card",
    };
    expect(selectOf("aws_lambda_invoke", mcp(reply), { functionName: "charge-card" })).toEqual(
      expected,
    );
    expect(selectOf("aws_lambda_invoke", reply, { functionName: "charge-card" })).toEqual(expected);
  });

  test("Lambda: a function not in the list, a missing name and a reply with no Functions all throw", () => {
    const reply = { Functions: [FN] };
    expect(() => selectOf("aws_lambda_invoke", reply, { functionName: "nope" })).toThrow();
    expect(() => selectOf("aws_lambda_invoke", reply, {})).toThrow();
    expect(() => selectOf("aws_lambda_invoke", {}, { functionName: "charge-card" })).toThrow();
  });

  const INSTANCE = {
    instanceId: "i-0a1b2c3d",
    state: "running",
    instanceType: "t3.micro",
    launchTime: "2026-10-01T10:00:00.000Z",
    tags: [{ key: "env", value: "prod" }, { key: "owner" }],
    iamProfileArn: "arn:aws:iam::1:instance-profile/web",
  };

  test("EC2: state, type, launch time, tags and instance profile; stopping a stopped instance says so (and starting a running one)", () => {
    expect(selectOf("aws_ec2_instance_stop", INSTANCE)).toEqual({
      Instance: "i-0a1b2c3d",
      State: "running",
      Type: "t3.micro",
      Launched: "2026-10-01T10:00:00.000Z",
      Tags: "env=prod, owner=",
      "IAM profile": "arn:aws:iam::1:instance-profile/web",
    });
    expect(
      selectOf("aws_ec2_instance_stop", mcp({ ...INSTANCE, state: "stopped", tags: [] })),
    ).toMatchObject({
      State: "stopped: it is already stopped, so stopping it does nothing",
      Tags: "(none)",
    });
    expect(selectOf("aws_ec2_instance_start", INSTANCE)["State"]).toBe(
      "running: it is already running, so starting it does nothing",
    );
    expect(
      selectOf("aws_ec2_instance_start", { instanceId: "i-1", state: "stopped" })["State"],
    ).toBe("stopped");
    expect(Object.hasOwn(selectOf("aws_ec2_instance_start", { instanceId: "i-1" }), "Tags")).toBe(
      false,
    );
  });

  const ECS = {
    serviceName: "web",
    status: "ACTIVE",
    desiredCount: 3,
    runningCount: 2,
    taskDefinition: "arn:aws:ecs:eu-west-1:1:task-definition/web:11",
    launchType: "FARGATE",
  };

  test("ECS: the service as it runs now, with the task definition beside the new one", () => {
    expect(selectOf("aws_ecs_service_update", ECS, { taskDefinition: "web:12" })).toEqual({
      Service: "web",
      Status: "ACTIVE",
      "Desired count": "3",
      "Running count": "2",
      "Task definition": "arn:aws:ecs:eu-west-1:1:task-definition/web:11 -> web:12",
      "Launch type": "FARGATE",
    });
    expect(selectOf("aws_ecs_service_update", mcp(ECS), {})["Task definition"]).toBe(
      "arn:aws:ecs:eu-west-1:1:task-definition/web:11",
    );
    expect(
      Object.hasOwn(
        selectOf("aws_ecs_service_update", { serviceName: "web" }, {}),
        "Task definition",
      ),
    ).toBe(false);
  });

  test("an AWS read the connector reports as not found refuses the write (Wave 4 fail closed)", async () => {
    for (const [id, input] of [
      ["aws_ecs_service_update", { cluster: "prod", service: "web", taskDefinition: "web:12" }],
      ["aws_ec2_instance_stop", { instanceIds: "i-0a1b2c3d" }],
      ["aws_lambda_invoke", { functionName: "nope" }],
    ] as const) {
      const failed = await readThrough(id, input, () => {
        throw new Error("service not found");
      });
      expect(failed.out, id).toEqual({ status: "refused", reason: WAVE4_BEFORE_REFUSAL });
    }
  });
});

// ---- group C -----------------------------------------------------------------------------------

describe("D1 group C selectors (Argo CD, Flux, MLflow, Snowflake)", () => {
  const APP = {
    metadata: { name: "web" },
    spec: {
      project: "default",
      source: { repoURL: "https://git.example/app.git", targetRevision: "main" },
      destination: { server: "https://kubernetes.default.svc", namespace: "prod" },
      syncPolicy: { automated: { prune: true } },
    },
    status: {
      sync: { status: "OutOfSync", revision: "abc123" },
      health: { status: "Healthy" },
      operationState: { phase: "Succeeded" },
      history: [
        { id: 11, revision: "r11", deployedAt: "2026-10-01T10:00:00Z" },
        { id: 12, revision: "r12", deployedAt: "2026-10-02T10:00:00Z" },
      ],
    },
  };

  test("Argo CD sync: sync status, health, revisions, repo, destination, auto-sync and the last operation", () => {
    const expected = {
      Application: "web",
      "Sync status": "OutOfSync",
      Health: "Healthy",
      "Synced revision": "abc123",
      "Target revision": "main",
      Repo: "https://git.example/app.git",
      Destination: "https://kubernetes.default.svc / prod",
      "Auto-sync": "on (prune: yes)",
      "Last operation": "Succeeded",
    };
    expect(selectOf("argocd_app_sync", APP)).toEqual(expected);
    expect(selectOf("argocd_app_sync", mcp(APP))).toEqual(expected);
    const manual = selectOf("argocd_app_sync", {
      metadata: { name: "web" },
      spec: { destination: { name: "in-cluster" }, syncPolicy: {} },
    });
    expect(manual).toEqual({ Application: "web", Destination: "in-cluster", "Auto-sync": "off" });
    expect(
      selectOf("argocd_app_sync", {
        metadata: { name: "web" },
        spec: { destination: { namespace: "ns" }, syncPolicy: { automated: {} } },
      }),
    ).toMatchObject({ Destination: "ns", "Auto-sync": "on (prune: no)" });
  });

  test("Argo CD rollback: the history entry the write names, and a note that auto-sync makes Argo CD refuse it", () => {
    const f = selectOf("argocd_app_rollback", APP, { id: 12 });
    expect(f["History entry 12"]).toBe("r12 (deployed 2026-10-02T10:00:00Z)");
    expect(f["Note"]).toBe("auto-sync is on: Argo CD refuses a rollback while it is on");
    const noAuto = selectOf(
      "argocd_app_rollback",
      { ...APP, spec: { ...APP.spec, syncPolicy: {} } },
      { id: "11" },
    );
    expect(noAuto["History entry 11"]).toBe("r11 (deployed 2026-10-01T10:00:00Z)");
    expect(Object.hasOwn(noAuto, "Note")).toBe(false);
    expect(selectOf("argocd_app_rollback", APP, { id: 99 })["History entry 99"]).toBe(
      "not in the deployment history",
    );
    expect(selectOf("argocd_app_rollback", APP, {})["History entry (unknown)"]).toBe(
      "not in the deployment history",
    );
    // an entry with no deploy time shows its revision alone; one with neither shows a placeholder
    expect(
      selectOf(
        "argocd_app_rollback",
        { ...APP, status: { history: [{ id: 1, revision: "r1" }] } },
        { id: 1 },
      )["History entry 1"],
    ).toBe("r1");
    expect(
      selectOf("argocd_app_rollback", { ...APP, status: { history: [{ id: 1 }] } }, { id: 1 })[
        "History entry 1"
      ],
    ).toBe("(unknown revision)");
  });

  test("Argo CD rollback guard: the id must be an entry of status.history (present, absent, no history)", async () => {
    const input = { name: "web" };
    const reason = "the history id is not in the application's deployment history";
    const ok = await readThrough("argocd_app_rollback", { ...input, id: 12 }, mcp(APP));
    expect(ok.out?.status).toBe("ok");
    expect(sentInput(ok.seen[0])).toEqual({
      name: "web",
    });
    for (const id of [99, "99", undefined, null, {}]) {
      const out = await readThrough("argocd_app_rollback", { ...input, id }, mcp(APP));
      expect(out.out, String(id)).toEqual({ status: "refused", reason });
    }
    const noHistory = await readThrough(
      "argocd_app_rollback",
      { ...input, id: 12 },
      { metadata: { name: "web" }, status: {} },
    );
    expect(noHistory.out).toEqual({ status: "refused", reason });
    const failed = await readThrough("argocd_app_rollback", { ...input, id: 12 }, () => {
      throw new Error("boom");
    });
    expect(failed.out).toEqual({ status: "refused", reason });
  });

  const KUSTOMIZATION = {
    metadata: { name: "apps" },
    spec: { interval: "10m", suspend: false },
    status: {
      lastAppliedRevision: "main@sha1:abc",
      conditions: [
        { type: "Healthy", status: "True" },
        {
          type: "Ready",
          status: "True",
          reason: "ReconciliationSucceeded",
          message: "Applied revision",
        },
      ],
    },
  };

  test("Flux: Ready (with its reason and message), suspended, the last applied revision and the interval", () => {
    const expected = {
      Resource: "apps",
      Ready: "True (ReconciliationSucceeded)",
      "Ready message": "Applied revision",
      Suspended: "no",
      "Last applied revision": "main@sha1:abc",
      Interval: "10m",
    };
    expect(selectOf("flux_kustomization_reconcile", KUSTOMIZATION)).toEqual(expected);
    expect(selectOf("flux_helmrelease_reconcile", mcp(KUSTOMIZATION))).toEqual(expected);
    // a HelmRelease may only have an attempted revision; a Ready condition with no reason shows the status
    expect(
      selectOf("flux_helmrelease_reconcile", {
        metadata: { name: "r" },
        status: {
          lastAttemptedRevision: "1.2.3",
          conditions: [{ type: "Ready", status: "False" }],
        },
      }),
    ).toEqual({ Resource: "r", Ready: "False", "Last applied revision": "1.2.3" });
  });

  const MODEL = {
    registered_model: {
      name: "fraud",
      latest_versions: [
        { version: "3", current_stage: "Production" },
        { version: "4", current_stage: "Staging" },
      ],
    },
  };

  test("MLflow promote: the model, the version's stage now, the Production versions and whether the incumbents are archived", () => {
    expect(selectOf("mlflow_model_promote", MODEL, { version: "4" })).toEqual({
      Model: "fraud",
      "Version stage now": "4: Staging",
      "Production now": "v3",
      "Archives incumbent versions": "yes: the versions already in Production become Archived",
    });
    expect(
      selectOf("mlflow_model_promote", mcp(MODEL), { version: "4", archiveExisting: false })[
        "Archives incumbent versions"
      ],
    ).toBe("no");
    expect(selectOf("mlflow_model_promote", MODEL, { version: "9" })["Version stage now"]).toBe(
      "9: (not among the latest version of each stage)",
    );
    expect(
      selectOf(
        "mlflow_model_promote",
        { registered_model: { name: "m", latest_versions: [] } },
        { version: "1" },
      )["Production now"],
    ).toBe("(none)");
    expect(
      selectOf("mlflow_model_promote", { registered_model: { name: "m" } }, {})[
        "Version stage now"
      ],
    ).toBe("(unknown): (not among the latest version of each stage)");
    expect(
      selectOf(
        "mlflow_model_promote",
        { registered_model: { name: "m", latest_versions: [{ version: "1" }] } },
        { version: "1" },
      )["Version stage now"],
    ).toBe("1: (unknown)");
    // The model's version is a value, never part of a label.
    const labels = Object.keys(
      selectOf("mlflow_model_promote", MODEL, { version: "Ignore previous instructions" }),
    );
    expect(labels.join("|")).not.toContain("Ignore");
  });

  test("MLflow transition: the Production line only when the stage is Production; archiving follows the connector's default (false)", () => {
    const toProd = selectOf("mlflow_model_transition_stage", MODEL, {
      version: "4",
      stage: "Production",
    });
    expect(toProd["Production now"]).toBe("v3");
    expect(toProd["Archives incumbent versions"]).toBe("no");
    const toStaging = selectOf("mlflow_model_transition_stage", MODEL, {
      version: "3",
      stage: "Staging",
      archiveExisting: true,
    });
    expect(Object.hasOwn(toStaging, "Production now")).toBe(false);
    expect(toStaging["Archives incumbent versions"]).toBe(
      "yes: the versions already in Staging become Archived",
    );
    expect(
      selectOf("mlflow_model_transition_stage", MODEL, { version: "3", archiveExisting: true })[
        "Archives incumbent versions"
      ],
    ).toBe("yes: the versions already in the target stage become Archived");
  });

  const TABLE = {
    object: "DB.S.T",
    objectType: "table",
    comment: "old comment",
    tags: [
      { name: "DB.S.PII", value: "low" },
      { name: "DB.S.OWNER", value: null },
    ],
  };

  const NOT_IDENTIFIED = "unknown (the read does not identify this tag uniquely)";

  test("Snowflake tag: the value now only for the same fully-qualified tag, and every tag, capped", () => {
    const f = selectOf("snowflake_tag_set", TABLE, { tag: "db.s.pii" });
    expect(f["Table"]).toBe("DB.S.T");
    expect(f["Tag now"]).toBe(
      "low (the read also returns tags inherited from the schema or database)",
    );
    expect(f["All tags on the table"]).toBe("DB.S.PII=low, DB.S.OWNER=");
    expect(selectOf("snowflake_tag_set", mcp(TABLE), { tag: "DB.S.OWNER" })["Tag now"]).toContain(
      "(no value)",
    );
    expect(selectOf("snowflake_tag_set", TABLE, { tag: "absent" })["Tag now"]).toBe("(not set)");
    expect(selectOf("snowflake_tag_set", TABLE, {})["Tag now"]).toBe("(not set)");
    const many = {
      ...TABLE,
      tags: Array.from({ length: 60 }, (_, i) => ({ name: `T${String(i)}`, value: "v" })),
    };
    expect(selectOf("snowflake_tag_set", many, { tag: "T1" })["All tags on the table"]).toContain(
      "(+10 more)",
    );
  });

  test("Snowflake tag: another schema's tag of the same name is never shown as this tag's value", () => {
    const other = { ...TABLE, tags: [{ name: "DB.OTHER.PII", value: "secret-other" }] };
    for (const tag of ["DB.S.PII", "pii", "S.PII"]) {
      expect(selectOf("snowflake_tag_set", other, { tag })["Tag now"], tag).toBe(NOT_IDENTIFIED);
    }
    // a bare name in the reply (what the installed connector returns) is never unique either
    const bare = { ...TABLE, tags: [{ name: "PII", value: "x" }] };
    expect(selectOf("snowflake_tag_set", bare, { tag: "DB.S.PII" })["Tag now"]).toBe(
      NOT_IDENTIFIED,
    );
    // two entries for the same fully-qualified tag are not unique
    const twice = {
      ...TABLE,
      tags: [
        { name: "DB.S.PII", value: "a" },
        { name: "DB.S.PII", value: "b" },
      ],
    };
    expect(selectOf("snowflake_tag_set", twice, { tag: "DB.S.PII" })["Tag now"]).toBe(
      NOT_IDENTIFIED,
    );
  });

  test("Snowflake tag: quoted identifiers keep their case, and a quoted dotted name is one segment", () => {
    const t = (name: string, value = "v") => ({ ...TABLE, tags: [{ name, value }] });
    // quoted lower-case is a different tag from the upper-cased one
    expect(
      selectOf("snowflake_tag_set", t("DB.S.OWNER"), { tag: '"DB"."S"."owner"' })["Tag now"],
    ).toBe("(not set)");
    expect(selectOf("snowflake_tag_set", t('DB.S."owner"'), { tag: "DB.S.OWNER" })["Tag now"]).toBe(
      "(not set)",
    );
    expect(
      selectOf("snowflake_tag_set", t('DB.S."owner"', "q"), { tag: '"DB"."S"."owner"' })["Tag now"],
    ).toContain("q ");
    // a quoted name holding a dot: matches only itself
    expect(
      selectOf("snowflake_tag_set", t('DB.S."a.b"', "dot"), { tag: 'DB.S."a.b"' })["Tag now"],
    ).toContain("dot ");
    expect(
      selectOf("snowflake_tag_set", t('DB.S."a.b"', "dot"), { tag: "DB.S.B" })["Tag now"],
    ).toBe("(not set)");
    expect(
      selectOf("snowflake_tag_set", t('DB.S."a.b"', "dot"), { tag: "DB.A.B" })["Tag now"],
    ).toBe("(not set)");
    // an unparseable wanted name is not identified
    expect(selectOf("snowflake_tag_set", TABLE, { tag: '"unclosed' })["Tag now"]).toBe(
      NOT_IDENTIFIED,
    );
  });

  test("Snowflake comment: the comment now, or (none)", () => {
    expect(selectOf("snowflake_comment_set", TABLE)).toEqual({
      Table: "DB.S.T",
      "Current comment": "old comment",
    });
    expect(
      selectOf("snowflake_comment_set", mcp({ ...TABLE, comment: "" }))["Current comment"],
    ).toBe("(none)");
    expect(selectOf("snowflake_comment_set", { object: "T" })["Current comment"]).toBe("(none)");
    expect(
      selectOf("snowflake_comment_set", { ...TABLE, comment: "x".repeat(5000) })["Current comment"],
    ).toContain("more characters not shown");
  });
});

// ---- group D -----------------------------------------------------------------------------------

describe("D1 group D selectors (OneDrive, Outlook, iCloud deletes)", () => {
  test("OneDrive: a folder says it deletes everything inside; a file shows its size; a shared item says so", () => {
    const folder = {
      name: "Reports",
      folder: { childCount: 12 },
      size: 123456,
      parentReference: { path: "/drive/root:" },
      shared: { scope: "users" },
      lastModifiedDateTime: "2026-10-01T10:00:00Z",
    };
    expect(selectOf("onedrive_item_delete", folder)).toEqual({
      Name: "Reports",
      Type: "folder with 12 items: deleting it deletes everything inside",
      Size: "123456 bytes",
      Parent: "/drive/root:",
      Shared: "yes: others can open it",
      Modified: "2026-10-01T10:00:00Z",
    });
    expect(
      selectOf(
        "onedrive_item_delete",
        mcp({ name: "a.txt", file: {}, parentReference: { id: "p1" } }),
      ),
    ).toEqual({
      Name: "a.txt",
      Type: "file",
      Parent: "p1",
      Shared: "no",
    });
    expect(selectOf("onedrive_item_delete", { name: "x", folder: {} })["Type"]).toBe(
      "folder: deleting it deletes everything inside",
    );
    expect(selectOf("onedrive_item_delete", { name: "x" })["Type"]).toBe("item");
  });

  const EVENT = {
    subject: "Standup",
    start: { dateTime: "2026-11-10T09:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-11-10T09:15:00.0000000", timeZone: "UTC" },
    organizer: { emailAddress: { address: "me@x.com", name: "Me" } },
    isOrganizer: true,
    attendees: [{ emailAddress: { address: "a@x.com" } }, { emailAddress: { address: "b@x.com" } }],
    isCancelled: false,
  };

  test("Outlook: subject, start and end with their time zone, organizer, attendees, cancelled", () => {
    const expected = {
      Subject: "Standup",
      Start: "2026-11-10T09:00:00.0000000 (UTC)",
      End: "2026-11-10T09:15:00.0000000 (UTC)",
      Organizer: "me@x.com",
      "Is organizer": "yes",
      Attendees: "2: a@x.com, b@x.com",
      Cancelled: "no",
    };
    expect(selectOf("outlook_calendar_delete", EVENT)).toEqual(expected);
    expect(selectOf("outlook_calendar_delete", mcp(EVENT))).toEqual(expected);
    const sparse = selectOf("outlook_calendar_delete", {
      subject: "S",
      start: { dateTime: "d" },
      organizer: { emailAddress: { name: "Me" } },
      attendees: [],
    });
    expect(sparse).toEqual({ Subject: "S", Start: "d", Organizer: "Me", Attendees: "(none)" });
    expect(
      selectOf("outlook_calendar_delete", { subject: "S", attendees: [{ emailAddress: {} }] })[
        "Attendees"
      ],
    ).toBe("1: (unreadable)");
  });

  const ICLOUD = {
    href: "/123/calendars/home/ev1.ics",
    uid: "u1",
    summary: "Dentist",
    start: "20261110T090000Z",
    end: "20261110T100000Z",
    allDay: false,
    location: null,
    organizer: null,
    status: null,
    attendees: ["a@x.com"],
    rrule: null,
    notes: "",
    calendar: "Home",
    etag: "e1",
  };

  test("iCloud: summary, times, calendar, attendees, location; a recurring event says it deletes the whole series", () => {
    expect(selectOf("apple_calendar_event_delete", ICLOUD)).toEqual({
      Summary: "Dentist",
      Start: "20261110T090000Z",
      End: "20261110T100000Z",
      Calendar: "Home",
      Attendees: "1: a@x.com",
    });
    const recurring = selectOf(
      "apple_calendar_event_delete",
      mcp({
        ...ICLOUD,
        rrule: "FREQ=WEEKLY",
        summary: null,
        attendees: [],
        location: "Clinic",
        organizer: "me@x.com",
      }),
    );
    expect(recurring["Summary"]).toBe("(no title)");
    expect(recurring["Recurrence"]).toBe("RECURRING: this deletes the whole series (FREQ=WEEKLY)");
    expect(recurring["Attendees"]).toBe("(none)");
    expect(recurring["Location"]).toBe("Clinic");
    expect(recurring["Organizer"]).toBe("me@x.com");
  });
});

// ---- identity fields and replies ----------------------------------------------------------------

describe("D1 selectors throw (so the write is refused) when the reply names no target", () => {
  const EMPTY_REPLY_ROWS = [...OFFERED, ...READER_NEVER_OFFERED] as const;

  test("an empty object, a string, null and an MCP error all throw, for every reader", () => {
    for (const id of EMPTY_REPLY_ROWS) {
      for (const reply of [
        {},
        "nope",
        null,
        mcp("not json at all"),
        { content: [], isError: true },
      ]) {
        expect(
          () => selectOf(id, reply, { version: "1" }),
          `${id} ${JSON.stringify(reply)}`,
        ).toThrow();
      }
    }
  });

  test("through the runner a reader that cannot read refuses before any prompt, with the one fixed reason", async () => {
    for (const id of EMPTY_REPLY_ROWS) {
      const { out } = await readThrough(id, { ...MIN_INPUT[id] }, mcp({}));
      if (out?.status === "refused") {
        expect(typeof out.reason, id).toBe("string");
      } else {
        throw new Error(`${id}: an empty reply was not refused`);
      }
    }
    // an unguarded row's reason is the generic one
    const plain = await readThrough("jenkins_build_trigger", { jobName: "j" }, mcp({}));
    expect(plain.out).toEqual({ status: "refused", reason: WAVE4_BEFORE_REFUSAL });
  });

  test("long values are capped by excerptHead", () => {
    const long = "n".repeat(5000);
    expect(selectOf("github_pr_merge", { title: long })["Title"]).toContain(
      "more characters not shown",
    );
    expect(selectOf("jenkins_build_trigger", { name: long })["Job"]).toContain(
      "more characters not shown",
    );
    expect(
      selectOf("flux_kustomization_reconcile", { metadata: { name: long } })["Resource"],
    ).toContain("more characters not shown");
  });
});
