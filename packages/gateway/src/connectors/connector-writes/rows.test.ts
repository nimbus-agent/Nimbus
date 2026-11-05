// packages/gateway/src/connectors/connector-writes/rows.test.ts
import { describe, expect, test } from "bun:test";
import { CHATOPS_POST_TOOL_IDS } from "../../chatops/transport/connector-post.ts";
import { HITL_REQUIRED } from "../../engine/executor.ts";
import { serviceOf } from "../../engine/service-of.ts";
import { isReadOnlyToolId } from "../../share/read-tool-registry.ts";
import { TRIBAL_KB_WRITE_TOOL_IDS } from "../../tribal/tribal-write-gate.ts";
import {
  CONNECTOR_WRITES,
  connectorWriteRowByToolId,
  isConnectorWriteToolId,
} from "../connector-write-registry.ts";
import { ACTION_PROPOSABILITY } from "../proposable-actions.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import { isModelOfferableRow } from "./model-offerable.ts";

const TODAYS_WRITE_ROWS: readonly string[] = [
  "snowflake.tag.set snowflake_tag_set snowflake",
  "snowflake.comment.set snowflake_comment_set snowflake",
  "tableau.datasource.refresh tableau_datasource_refresh tableau",
  "tableau.workbook.refresh tableau_workbook_refresh tableau",
  "looker.datagroup.trigger looker_datagroup_trigger looker",
  "looker.schedule.run_once looker_schedule_run_once looker",
  "powerbi.dataset.refresh powerbi_dataset_refresh powerbi",
  "powerbi.dataflow.refresh powerbi_dataflow_refresh powerbi",
  "montecarlo.incident.acknowledge montecarlo_incident_acknowledge montecarlo",
  "montecarlo.incident.resolve montecarlo_incident_resolve montecarlo",
  "bigeye.issue.acknowledge bigeye_issue_acknowledge bigeye",
  "bigeye.issue.resolve bigeye_issue_resolve bigeye",
  "argocd.app.sync argocd_app_sync argocd",
  "argocd.app.rollback argocd_app_rollback argocd",
  "flux.kustomization.reconcile flux_kustomization_reconcile flux",
  "flux.helmrelease.reconcile flux_helmrelease_reconcile flux",
  "mlflow.model.promote mlflow_model_promote mlflow",
  "mlflow.model.transition_stage mlflow_model_transition_stage mlflow",
];

/** Every id the I26 predicate refused before A1 (the old MIGRATED set), spelled out. */
const REFUSED_BEFORE_A1: readonly string[] = [
  "github_pr_merge",
  "github_pr_close",
  "github_issue_create",
  "github_branch_delete",
  "github_tag_create",
  "bitbucket_pr_merge",
  "gitlab_mr_merge",
  "gitlab_pipeline_retry",
  "gitlab_pipeline_cancel",
  "jenkins_build_trigger",
  "jenkins_build_abort",
  "iac_terraform_apply",
  "iac_terraform_destroy",
  "iac_cloudformation_deploy",
  "iac_pulumi_up",
  "gha_run_trigger",
  "gha_run_cancel",
  "circleci_pipeline_trigger",
  "circleci_job_cancel",
  "slack_message_post",
  "teams_message_post",
  "notion_page_create",
  "notion_page_update",
  "notion_block_append",
  "notion_comment_create",
  "confluence_page_create",
  "confluence_page_update",
  "confluence_comment_add",
  "obsidian_append_to_daily_note",
  "jira_issue_create",
  "jira_issue_update",
  "jira_comment_add",
  "linear_issue_create",
  "linear_issue_update",
  "linear_comment_create",
  "pd_incident_acknowledge",
  "pd_incident_resolve",
  "pd_incident_escalate",
  "gmail_draft_create",
  "gmail_draft_send",
  "gmail_message_send",
  "outlook_mail_send",
  "outlook_calendar_create",
  "outlook_calendar_delete",
  "fastmail_mail_send",
  "imap_mail_send",
  "protonmail_mail_send",
  "apple_mail_send",
  "apple_mail_draft_create",
  "apple_calendar_event_create",
  "apple_calendar_event_delete",
  "gdrive_file_create",
  "gdrive_file_move",
  "gdrive_file_rename",
  "onedrive_item_delete",
  "onedrive_item_move",
  "aws_ecs_service_update",
  "aws_lambda_invoke",
  "azure_app_service_restart",
  "azure_aks_node_pool_scale",
  "gcp_cloud_run_deploy",
  "gcp_gke_workload_restart",
  "k8s_rollout_restart",
  "k8s_deployment_scale",
  "k8s_pod_delete",
  "aws_ec2_instance_stop",
  "aws_ec2_instance_start",
  "slack_message_post_dm",
  "teams_message_post_chat",
  "gdrive_file_trash",
  ...TODAYS_WRITE_ROWS.map((s) => s.split(" ")[1] ?? ""),
];

describe("connector write rows", () => {
  test("102 rows, unique tool ids", () => {
    expect(CONNECTOR_WRITE_ROWS).toHaveLength(102);
    expect(new Set(CONNECTOR_WRITE_ROWS.map((r) => r.toolId)).size).toBe(102);
  });

  test("every row's action type is in the HITL frozen set", () => {
    expect(CONNECTOR_WRITE_ROWS.filter((r) => !HITL_REQUIRED.has(r.actionType))).toEqual([]);
  });

  test("write-transport rows are exactly today's 18, unchanged", () => {
    expect(
      CONNECTOR_WRITES.map((w) => `${w.actionType} ${w.toolId} ${w.service}`).sort((a, b) =>
        a.localeCompare(b),
      ),
    ).toEqual([...TODAYS_WRITE_ROWS].sort((a, b) => a.localeCompare(b)));
  });

  test("action types are unique among write rows", () => {
    const types = CONNECTOR_WRITES.map((w) => w.actionType);
    expect(new Set(types).size).toBe(types.length);
  });

  test("every row is refused, bare and namespaced", () => {
    for (const r of CONNECTOR_WRITE_ROWS) {
      expect(isConnectorWriteToolId(r.toolId)).toBe(true);
      expect(isConnectorWriteToolId(`${serviceOf(r.actionType)}_${r.toolId}`)).toBe(true);
    }
    expect(isConnectorWriteToolId("aws_aws_ec2_instance_stop")).toBe(true);
    expect(isConnectorWriteToolId("github_actions_gha_run_trigger")).toBe(true);
  });

  test("gate-confined ids stay refused through their gates", () => {
    const rowIds = new Set(CONNECTOR_WRITE_ROWS.map((r) => r.toolId));
    for (const ids of [CHATOPS_POST_TOOL_IDS, TRIBAL_KB_WRITE_TOOL_IDS]) {
      for (const id of ids) {
        expect(isConnectorWriteToolId(id)).toBe(true);
        expect(rowIds.has(id)).toBe(false);
      }
    }
  });

  test("gdrive_file_trash is a read-registered write", () => {
    expect(connectorWriteRowByToolId("gdrive_file_trash")).toEqual({
      toolId: "gdrive_file_trash",
      actionType: "google_drive.file.trash",
      transport: "mesh",
      wave: 3,
      registeredAs: "read",
    });
    expect(HITL_REQUIRED.has("google_drive.file.trash")).toBe(true);
  });

  test("no behaviour change: every id refused before A1 is refused after", () => {
    expect(REFUSED_BEFORE_A1).toHaveLength(88);
    expect(REFUSED_BEFORE_A1.filter((id) => !isConnectorWriteToolId(id))).toEqual([]);
  });
});

describe("connector write preview templates", () => {
  test("every write-transport row has a preview template", () => {
    expect(
      CONNECTOR_WRITE_ROWS.filter((r) => r.transport === "write" && r.preview === undefined).map(
        (r) => r.toolId,
      ),
    ).toEqual([]);
  });
  // The A2 tripwire that stood here ("no proposable row has a template yet") is retired: the act
  // door now shows the typed preview under the provenance header (ipc/capture-rpc.ts
  // `actConsentDisplay`, proven in capture-rpc.test.ts with a synthetic templated proposable row).
});

/** The 14 writes `@nimbus-dev/connectors` 0.4.0 added (Phase 9.7 B-X), spelled out. */
const CONNECTORS_0_4_0_WRITES: readonly string[] = [
  "github_issue_comment_create",
  "github_issue_labels_add",
  "github_issue_assignees_add",
  "github_issue_state_set",
  "gitlab_issue_create",
  "gitlab_issue_note_create",
  "gitlab_mr_note_create",
  "gitlab_issue_labels_add",
  "gitlab_issue_assignees_add",
  "gitlab_issue_state_set",
  "jira_issue_transition",
  "outlook_draft_create",
  "discord_message_post",
  "confluence_page_append",
];

/** The 0.4.0 writes B1 templates (message and comment posts). */
const B1_OFFERED_0_4_0: readonly string[] = [
  "github_issue_comment_create",
  "gitlab_issue_note_create",
  "gitlab_mr_note_create",
  "discord_message_post",
];

/** The 0.4.0 writes B2 templates (issue writes). */
const B2_OFFERED_0_4_0: readonly string[] = [
  "github_issue_labels_add",
  "github_issue_assignees_add",
  "github_issue_state_set",
  "gitlab_issue_create",
  "gitlab_issue_labels_add",
  "gitlab_issue_assignees_add",
  "gitlab_issue_state_set",
  "jira_issue_transition",
];

/** The 0.4.0 writes B3 templates (the Outlook draft and the Confluence append). */
const B3_OFFERED_0_4_0: readonly string[] = ["outlook_draft_create", "confluence_page_append"];

const OFFERED_0_4_0: readonly string[] = [
  ...B1_OFFERED_0_4_0,
  ...B2_OFFERED_0_4_0,
  ...B3_OFFERED_0_4_0,
];

describe("connectors 0.4.0 writes (B-X)", () => {
  test("each is a wave-2 mesh row whose action type is its tool id dotted, in the frozen set", () => {
    expect(CONNECTORS_0_4_0_WRITES).toHaveLength(14);
    for (const id of CONNECTORS_0_4_0_WRITES) {
      const r = connectorWriteRowByToolId(id);
      const core =
        r === undefined
          ? undefined
          : { toolId: r.toolId, actionType: r.actionType, transport: r.transport, wave: r.wave };
      expect(core, id).toEqual({
        toolId: id,
        actionType: id.replaceAll("_", "."),
        transport: "mesh",
        wave: 2,
      });
      expect(HITL_REQUIRED.has(id.replaceAll("_", ".")), id).toBe(true);
      expect(isConnectorWriteToolId(id), id).toBe(true);
    }
  });

  test("all fourteen are offered to the model (typed preview, wave 2): four B1, eight B2, two B3", () => {
    expect(OFFERED_0_4_0).toHaveLength(14);
    expect([...OFFERED_0_4_0].sort((x, y) => x.localeCompare(y))).toEqual(
      [...CONNECTORS_0_4_0_WRITES].sort((x, y) => x.localeCompare(y)),
    );
    for (const id of OFFERED_0_4_0) {
      const r = connectorWriteRowByToolId(id);
      expect(r?.preview, id).toBeDefined();
      expect(r?.wave, id).toBe(2);
      expect(r !== undefined && isModelOfferableRow(r), id).toBe(true);
    }
  });

  test("no 0.4.0 write is left untemplated", () => {
    const rows = CONNECTOR_WRITE_ROWS.filter(
      (r) => CONNECTORS_0_4_0_WRITES.includes(r.toolId) && r.preview === undefined,
    );
    expect(rows.map((r) => r.toolId)).toEqual([]);
  });

  test("thirteen are proposable over MCP; only the Jira transition stays not_yet_offered", () => {
    const withheld = ["jira_issue_transition"];
    for (const id of CONNECTORS_0_4_0_WRITES) {
      expect(ACTION_PROPOSABILITY[id.replaceAll("_", ".")], id).toEqual(
        withheld.includes(id)
          ? { kind: "denied", class: "not_yet_offered" }
          : { kind: "proposable" },
      );
    }
    expect(CONNECTORS_0_4_0_WRITES.filter((id) => !withheld.includes(id))).toHaveLength(13);
  });

  test("the new read jira_issue_transitions_list is not a write and is read-only", () => {
    expect(isReadOnlyToolId("jira_issue_transitions_list")).toBe(true);
    expect(isConnectorWriteToolId("jira_issue_transitions_list")).toBe(false);
    expect(connectorWriteRowByToolId("jira_issue_transitions_list")).toBeUndefined();
  });
});
