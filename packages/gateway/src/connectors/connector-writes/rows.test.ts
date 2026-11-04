// packages/gateway/src/connectors/connector-writes/rows.test.ts
import { describe, expect, test } from "bun:test";
import { CHATOPS_POST_TOOL_IDS } from "../../chatops/transport/connector-post.ts";
import { HITL_REQUIRED } from "../../engine/executor.ts";
import { serviceOf } from "../../engine/service-of.ts";
import { TRIBAL_KB_WRITE_TOOL_IDS } from "../../tribal/tribal-write-gate.ts";
import {
  CONNECTOR_WRITES,
  connectorWriteRowByToolId,
  isConnectorWriteToolId,
} from "../connector-write-registry.ts";
import { PROPOSABLE_WRITE_TOOLS } from "../proposable-actions.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";

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
  test("88 rows, unique tool ids", () => {
    expect(CONNECTOR_WRITE_ROWS).toHaveLength(88);
    expect(new Set(CONNECTOR_WRITE_ROWS.map((r) => r.toolId)).size).toBe(88);
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

  test("no proposable row has a template yet (the MCP sink replaces the executor prompt)", () => {
    const proposable = new Set(Object.values(PROPOSABLE_WRITE_TOOLS));
    expect(
      CONNECTOR_WRITE_ROWS.filter((r) => proposable.has(r.toolId) && r.preview !== undefined).map(
        (r) => r.toolId,
      ),
      "extend ipc/capture-rpc.ts provenanceConsent to show the typed preview first",
    ).toEqual([]);
  });
});
