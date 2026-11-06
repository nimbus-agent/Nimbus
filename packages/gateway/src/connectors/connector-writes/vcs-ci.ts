// packages/gateway/src/connectors/connector-writes/vcs-ci.ts
import { beforeReplyJson, presentFields, requiredStringAt, stringAt } from "./before-select.ts";
import {
  type BeforeStateField,
  type ConnectorWriteRow,
  row,
  textField,
  withBefore,
  withPreview,
} from "./types.ts";

/** GitLab `gitlab_mr_get` (before-state, spec 5.4): title, state and the branches; never the body. */
export function selectGitlabMrIdentity(reply: unknown): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  const title = requiredStringAt(j, ["title"]);
  const source = stringAt(j, ["source_branch"]);
  const target = stringAt(j, ["target_branch"]);
  const branches =
    source === undefined || target === undefined ? undefined : `${source} -> ${target}`;
  return [
    { label: "Title", value: title },
    ...presentFields([
      ["State", stringAt(j, ["state"])],
      ["Branches", branches],
    ]),
  ];
}

export const VCS_CI_ROWS: readonly ConnectorWriteRow[] = [
  // Spec § 15, OR-W34-3: merges, branch delete and tag create are irreversible, so wave 4 (always
  // prompts, needs a before-state and type-to-confirm, never auto-fires).
  row("github_pr_merge", "github.pr.merge", "mesh", 4),
  row("github_pr_close", "github.pr.close", "mesh", 3),
  // Connectors 0.6.0 (spec 15.3, OR-W34-6): branch, PR and MR create/update, all wave 3. The
  // create writes are recoverable (the branch/PR/MR can be deleted or closed), the updates are not.
  // Untemplated and not offered in C1; C2 templates them behind new act-door refusals.
  row("github_branch_create", "github.branch.create", "mesh", 3),
  row("github_pr_create", "github.pr.create", "mesh", 3),
  row("github_pr_update", "github.pr.update", "mesh", 3),
  row("gitlab_branch_create", "gitlab.branch.create", "mesh", 3),
  row("gitlab_mr_create", "gitlab.mr.create", "mesh", 3),
  row("gitlab_mr_update", "gitlab.mr.update", "mesh", 3),
  row("github_branch_delete", "github.branch.delete", "mesh", 4),
  row("github_tag_create", "github.tag.create", "mesh", 4),
  row("gitlab_mr_merge", "gitlab.mr.merge", "mesh", 4),
  withBefore(
    withPreview(row("gitlab_mr_note_create", "gitlab.mr.note.create", "mesh", 2), {
      target: "{projectPath}!{mergeRequestIid}",
      summary: "Comment on GitLab merge request {projectPath}!{mergeRequestIid}",
      fields: [textField("body", "Comment")],
    }),
    {
      tool: "gitlab_mr_get",
      argKeys: ["projectPath", "mergeRequestIid"],
      args: (input) => ({
        projectPath: input["projectPath"],
        mergeRequestIid: input["mergeRequestIid"],
      }),
      select: selectGitlabMrIdentity,
    },
  ),
  row("bitbucket_pr_merge", "bitbucket.pr.merge", "mesh", 4),
  row("jenkins_build_trigger", "jenkins.build.trigger", "mesh", 4),
  row("jenkins_build_abort", "jenkins.build.abort", "mesh", 4),
  row("gha_run_trigger", "github_actions.run.trigger", "mesh", 4),
  row("gha_run_cancel", "github_actions.run.cancel", "mesh", 4),
  row("circleci_pipeline_trigger", "circleci.pipeline.trigger", "mesh", 4),
  row("circleci_job_cancel", "circleci.job.cancel", "mesh", 4),
  row("gitlab_pipeline_retry", "gitlab.pipeline.retry", "mesh", 4),
  row("gitlab_pipeline_cancel", "gitlab.pipeline.cancel", "mesh", 4),
];
