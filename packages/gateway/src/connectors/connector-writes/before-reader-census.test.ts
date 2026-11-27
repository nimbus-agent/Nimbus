// The census of the production before-state readers (spec § 5.4): which rows read, which take a
// second read and which carry a guard. Moved out of `before-reader.test.ts` unchanged except for
// the connectors 0.19.0 rows, since that file's size is locked by `audit:file-size`.
import { describe, expect, test } from "bun:test";

import { beforeReaderProblems } from "./before-reader.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";

describe("BeforeStateReader (spec § 5.4): the production census", () => {
  test("the rows with readers are exactly the 89 (seven B1 comments, the Bitbucket PR comment, nine B2 issue writes, the ten 0.19.0 issue, label and review writes, five B3 page writes, the B4a Drive create, the B4b Obsidian append, the eight C1 file, PR and incident writes, the four C2 branch, PR and MR rows with a reader, the five C3 flag and alert rows, the 28 D1 Wave 4 rows, the seven D3b deploy and mobile rows, the two D3c Kubernetes rows, and the SA2 Gmail archive), and every reader passes", () => {
    const withReader = CONNECTOR_WRITE_ROWS.filter((r) => r.before !== undefined)
      .map((r) => r.toolId)
      .sort((a, b) => a.localeCompare(b));
    expect(withReader).toEqual(
      [
        "confluence_comment_add",
        "confluence_page_append",
        "confluence_page_update",
        "gdrive_file_create",
        "gdrive_file_move",
        "gdrive_file_rename",
        "gdrive_file_trash",
        "github_issue_assignees_add",
        "github_issue_comment_create",
        "github_issue_labels_add",
        "github_issue_state_set",
        "github_branch_create",
        "github_pr_close",
        "github_pr_create",
        "github_pr_update",
        "flagsmith_feature_state_set",
        "gitlab_issue_assignees_add",
        "gitlab_issue_labels_add",
        "gitlab_issue_note_create",
        "gitlab_issue_state_set",
        "gitlab_mr_note_create",
        "bitbucket_pr_comment_create",
        "gitlab_mr_update",
        "gmail_thread_archive",
        "jira_comment_add",
        "jira_issue_transition",
        "jira_issue_update",
        "jira_ops_alert_acknowledge",
        "jira_ops_alert_close",
        "k8s_deployment_scale",
        "k8s_rollout_restart",
        "launchdarkly_flag_rollout_set",
        "launchdarkly_flag_toggle",
        "linear_comment_create",
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
        // Connectors 0.19.0: the nine Wave 2 issue and label writes and the pull request review.
        "github_issue_labels_remove",
        "github_issue_assignees_remove",
        "github_issue_update",
        "github_pr_review_create",
        "gitlab_issue_labels_remove",
        "gitlab_issue_assignees_remove",
        "gitlab_issue_update",
        "jira_issue_assign",
        "linear_issue_labels_add",
        "linear_issue_labels_remove",
        // D1: the 31 Wave 4 rows (27 offerable, plus the never-offered Bitbucket merge).
        "argocd_app_rollback",
        "argocd_app_sync",
        "apple_calendar_event_delete",
        "aws_ec2_instance_start",
        "aws_ec2_instance_stop",
        "aws_ecs_service_update",
        "aws_lambda_invoke",
        "bitbucket_pr_merge",
        "circleci_job_cancel",
        "circleci_pipeline_trigger",
        "flux_helmrelease_reconcile",
        "flux_kustomization_reconcile",
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
        "mlflow_model_promote",
        "mlflow_model_transition_stage",
        "onedrive_item_delete",
        "outlook_calendar_delete",
        "snowflake_comment_set",
        "snowflake_tag_set",
        // D3b: the seven deploy-trigger and mobile-release rows.
        "vercel_deployment_redeploy",
        "vercel_deployment_promote",
        "netlify_build_trigger",
        "bitrise_build_trigger",
        "codemagic_build_trigger",
        "testflight_build_distribute",
        "firebase_app_distribution_distribute",
      ].sort((a, b) => a.localeCompare(b)),
    );
    expect(withReader).toHaveLength(89);
    for (const r of CONNECTOR_WRITE_ROWS) expect(beforeReaderProblems(r)).toEqual([]);
  });

  test("in production only the Jira transition, the two file moves (Drive, OneDrive) and three D3b rows (the Vercel promote, the Netlify build, the TestFlight distribute) take a second read, and the rows with a guard are exactly twenty (B2, B3, C2, C3, D1, D3b, and five 0.19.0 rows)", () => {
    expect(
      CONNECTOR_WRITE_ROWS.filter((r) => r.before?.also !== undefined).map((r) => r.toolId),
    ).toEqual([
      "jira_issue_transition",
      "gdrive_file_move",
      "onedrive_item_move",
      "vercel_deployment_promote",
      "netlify_build_trigger",
      "testflight_build_distribute",
    ]);
    const guarded = CONNECTOR_WRITE_ROWS.filter((r) => r.before?.guard !== undefined);
    expect(guarded.map((r) => r.toolId).sort((a, b) => a.localeCompare(b))).toEqual([
      "argocd_app_rollback",
      "circleci_pipeline_trigger",
      "confluence_page_append",
      "confluence_page_update",
      "github_issue_update",
      "github_pr_merge",
      "github_pr_review_create",
      "github_pr_update",
      "github_tag_create",
      "gitlab_issue_assignees_remove",
      "gitlab_issue_update",
      "gitlab_mr_merge",
      "gitlab_mr_update",
      "jira_issue_assign",
      "launchdarkly_flag_rollout_set",
      "linear_issue_update",
      "netlify_build_trigger",
      "notion_block_append",
      "notion_page_update",
      "testflight_build_distribute",
    ]);
    for (const r of guarded) {
      const reason = r.before?.guard?.reason ?? "";
      expect(reason.trim(), r.toolId).not.toBe("");
      expect(/\{\w+\}/.test(reason), r.toolId).toBe(false);
    }
  });
});
