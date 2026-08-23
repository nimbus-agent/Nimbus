/**
 * Write tool ids routed through the connector consent kit but NOT dispatchable from the gateway.
 *
 * Deliberately separate from `CONNECTOR_WRITES`. That registry is a 1:1 `actionType` ↔ `toolId` map
 * driving `connector-write-dispatch.ts`; these tools have no dispatch path, and inventing rows for
 * them would put fictional routing into a real routing table. I26's predicate asks only "is this
 * tool id a write?", which a set answers exactly.
 *
 * Grows one wave at a time as connectors migrate to `registerWriteTool`. When a tool gains a
 * dispatch path it graduates to a `ConnectorWrite` row and leaves this set — the registry test
 * asserts the two never overlap.
 */
export const MIGRATED_WRITE_TOOL_IDS: ReadonlySet<string> = new Set([
  // github — Part 1 (#1318)
  "github_pr_merge",
  "github_pr_close",
  "github_issue_create",
  "github_branch_delete",
  "github_tag_create",

  // Wave 3 — repos + CI
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

  // Wave 4 — comms. FOUR ids are deliberately ABSENT, each already confined by a stricter,
  // purpose-built gate that a generic write-id set would only duplicate:
  //   notion_kb_append, confluence_kb_append — static D19 confines them to tribal-write-gate.ts
  //     and their own connectors; I25 pins their destination to config, not to a caller.
  //   slack_chat_post, teams_chat_post — static D17 confines them to the ChatOps reply
  //     dispatcher; I23 derives their destination server-side so it is never caller-supplied.
  // All four are still routed through the consent kit IN THEIR CONNECTOR, which is what makes
  // them safe standalone; only the gateway-side id set omits them.
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

  // Wave 5 — tickets
  "jira_issue_create",
  "jira_issue_update",
  "jira_comment_add",
  "linear_issue_create",
  "linear_issue_update",
  "linear_comment_create",
  "pd_incident_acknowledge",
  "pd_incident_resolve",
  "pd_incident_escalate",

  // Wave 6 — mail + calendar
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

  // Wave 7 — files + cloud
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
]);
