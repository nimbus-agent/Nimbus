// I53: the census of the production rows with a before-state reader, split by wave. Moved out of
// `i53-model-write-door.test.ts` (whose size is locked by `audit:file-size`), unchanged except
// for the connectors 0.19.0, 0.20.0 and 0.22.0 rows.
import { describe, expect, test } from "bun:test";

import { CONNECTOR_WRITE_ROWS } from "../connectors/connector-writes/index.ts";

describe("I53 — the production before-state readers (census)", () => {
  test("the production rows with a before reader are B1's seven comment rows, B2's nine issue writes, B3's five page writes, B4a's Drive create, B4b's Obsidian append (all wave 2), C1's eight wave-3 file, pull request and incident writes, C2's four wave-3 branch, pull request and merge request writes and C3's five wave-3 flag and alert writes and the three wave-3 Unleash and Split writes of connectors 0.22.0, D1's 28 wave-4 rows (27 offered, plus the never-offered Bitbucket merge) and D3b's seven deploy and mobile-release rows and D3c's two Kubernetes rows and SA2's Gmail thread archive, and the wave-2 Bitbucket pull request comment, and the ten wave-2 writes of connectors 0.19.0, and the Google Calendar update (wave 2) and delete (wave 4) of connectors 0.20.0", () => {
    const withReader = CONNECTOR_WRITE_ROWS.filter((r) => r.before !== undefined);
    const D1_WAVE4 = [
      "apple_calendar_event_delete",
      "argocd_app_rollback",
      "argocd_app_sync",
      "aws_ec2_instance_start",
      "aws_ec2_instance_stop",
      "aws_ecs_service_update",
      "aws_lambda_invoke",
      "bitbucket_pr_merge",
      "bitrise_build_trigger",
      "circleci_job_cancel",
      "circleci_pipeline_trigger",
      "codemagic_build_trigger",
      "firebase_app_distribution_distribute",
      "flux_helmrelease_reconcile",
      "flux_kustomization_reconcile",
      "gcal_event_delete",
      "gha_run_cancel",
      "gha_run_trigger",
      "github_branch_delete",
      "github_pr_merge",
      "github_tag_create",
      "gitlab_mr_merge",
      "gitlab_pipeline_cancel",
      "gitlab_pipeline_retry",
      "jenkins_build_abort",
      "jenkins_build_trigger",
      "k8s_deployment_scale",
      "k8s_rollout_restart",
      "mlflow_model_promote",
      "mlflow_model_transition_stage",
      "netlify_build_trigger",
      "onedrive_item_delete",
      "outlook_calendar_delete",
      "snowflake_comment_set",
      "snowflake_tag_set",
      "testflight_build_distribute",
      "vercel_deployment_promote",
      "vercel_deployment_redeploy",
    ];
    expect(
      withReader
        .filter((r) => r.wave === 4)
        .map((r) => r.toolId)
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual(D1_WAVE4);
    for (const r of withReader.filter((x) => x.wave === 4))
      expect(r.confirm, r.toolId).toBeDefined();
    expect(
      withReader
        .filter((r) => r.wave !== 4)
        .map((r) => r.toolId)
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual([
      "bitbucket_pr_comment_create",
      "confluence_comment_add",
      "confluence_page_append",
      "confluence_page_update",
      "flagsmith_feature_state_set",
      "gcal_event_update",
      "gdrive_file_create",
      "gdrive_file_move",
      "gdrive_file_rename",
      "gdrive_file_trash",
      "github_branch_create",
      "github_issue_assignees_add",
      "github_issue_assignees_remove",
      "github_issue_comment_create",
      "github_issue_labels_add",
      "github_issue_labels_remove",
      "github_issue_state_set",
      "github_issue_update",
      "github_pr_close",
      "github_pr_create",
      "github_pr_review_create",
      "github_pr_update",
      "gitlab_issue_assignees_add",
      "gitlab_issue_assignees_remove",
      "gitlab_issue_labels_add",
      "gitlab_issue_labels_remove",
      "gitlab_issue_note_create",
      "gitlab_issue_state_set",
      "gitlab_issue_update",
      "gitlab_mr_note_create",
      "gitlab_mr_update",
      "gmail_thread_archive",
      "jira_comment_add",
      "jira_issue_assign",
      "jira_issue_transition",
      "jira_issue_update",
      "jira_ops_alert_acknowledge",
      "jira_ops_alert_close",
      "launchdarkly_flag_rollout_set",
      "launchdarkly_flag_toggle",
      "linear_comment_create",
      "linear_issue_labels_add",
      "linear_issue_labels_remove",
      "linear_issue_update",
      "notion_block_append",
      "notion_comment_create",
      "notion_page_create",
      "notion_page_update",
      "obsidian_append_to_daily_note",
      "onedrive_item_move",
      "pd_incident_acknowledge",
      "pd_incident_escalate",
      "pd_incident_resolve",
      "split_kill",
      "split_restore",
      "unleash_feature_toggle",
    ]);
    expect(
      withReader
        .filter((r) => r.wave === 3)
        .map((r) => r.toolId)
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual([
      "flagsmith_feature_state_set",
      "gdrive_file_move",
      "gdrive_file_rename",
      "gdrive_file_trash",
      "github_branch_create",
      "github_pr_close",
      "github_pr_create",
      "github_pr_update",
      "gitlab_mr_update",
      "jira_ops_alert_acknowledge",
      "jira_ops_alert_close",
      "launchdarkly_flag_rollout_set",
      "launchdarkly_flag_toggle",
      "onedrive_item_move",
      "pd_incident_acknowledge",
      "pd_incident_escalate",
      "pd_incident_resolve",
      "split_kill",
      "split_restore",
      "unleash_feature_toggle",
    ]);
  });
});
