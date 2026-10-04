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
 * asserts the two never overlap. `connector-write-sync.test.ts` derives every write the INSTALLED
 * connectors package registers and fails on one `isConnectorWriteToolId` does not refuse, so a
 * connectors bump that adds a write cannot land unclassified.
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

  // Wave 4 — comms. FOUR comms writes are not listed here because static rules forbid naming their
  // literals outside their own gates:
  //   notion_kb_append, confluence_kb_append — D19 confines them to tribal-write-gate.ts;
  //   slack_chat_post, teams_chat_post — D17 confines them to the ChatOps reply surface.
  // They are NOT exempt from I26. Those gates pin the destination only when the GATEWAY calls the
  // tool (I25 / I23); a federated invoke carries the peer's own arguments. So each gate exports its
  // ids as a set, and `isConnectorWriteToolId` refuses them through it
  // (connector-write-registry.ts `GATE_CONFINED_WRITE_TOOL_IDS`).
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

  // Classified 2026-10-04: real mutations the I26 predicate let a federated peer name.
  //   - Registered as plain READ tools in @nimbus-dev/connectors 0.2.1 and moved to the consent
  //     kit's write registrar in 0.2.2, where the sync guard (`connector-write-sync.test.ts`)
  //     derives them:
  "aws_ec2_instance_stop",
  "aws_ec2_instance_start",
  "slack_message_post_dm",
  "teams_message_post_chat",
  //   - STILL registered as a read in 0.2.2 (`registerDriveTool`), though it PATCHes
  //     `trashed: true`. The guard derives write REGISTRATIONS only, so it cannot see this one,
  //     which is listed by hand. google_drive has no team-injectable secret today, so no federated
  //     invoke can reach it yet; classified now so it is refused the day one can.
  "gdrive_file_trash",
]);
