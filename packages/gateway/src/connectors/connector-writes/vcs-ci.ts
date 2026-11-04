// packages/gateway/src/connectors/connector-writes/vcs-ci.ts
import { type ConnectorWriteRow, row } from "./types.ts";

export const VCS_CI_ROWS: readonly ConnectorWriteRow[] = [
  row("github_pr_merge", "github.pr.merge", "mesh", 3),
  row("github_pr_close", "github.pr.close", "mesh", 3),
  row("github_branch_delete", "github.branch.delete", "mesh", 3),
  row("github_tag_create", "github.tag.create", "mesh", 3),
  row("gitlab_mr_merge", "gitlab.mr.merge", "mesh", 3),
  row("bitbucket_pr_merge", "bitbucket.pr.merge", "mesh", 3),
  row("jenkins_build_trigger", "jenkins.build.trigger", "mesh", 4),
  row("jenkins_build_abort", "jenkins.build.abort", "mesh", 4),
  row("gha_run_trigger", "github_actions.run.trigger", "mesh", 4),
  row("gha_run_cancel", "github_actions.run.cancel", "mesh", 4),
  row("circleci_pipeline_trigger", "circleci.pipeline.trigger", "mesh", 4),
  row("circleci_job_cancel", "circleci.job.cancel", "mesh", 4),
  row("gitlab_pipeline_retry", "gitlab.pipeline.retry", "mesh", 4),
  row("gitlab_pipeline_cancel", "gitlab.pipeline.cancel", "mesh", 4),
];
