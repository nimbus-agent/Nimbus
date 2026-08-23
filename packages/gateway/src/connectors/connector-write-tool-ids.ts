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
]);
