// packages/gateway/src/connectors/connector-writes/vcs-ci.ts
import {
  beforeReplyJson,
  excerptHead,
  presentFields,
  requiredStringAt,
  stringAt,
} from "./before-select.ts";
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

/**
 * GitHub `github_pr_get` (before-state), for closing a pull request: `Title` (required), `State`
 * (a merged or already closed pull request says so: closing it does nothing), `Branches`
 * (`head -> base`), `Draft` and `Author`. Never the body (the same rule as the GitLab selector).
 */
export function selectGithubPrIdentity(reply: unknown): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  const title = requiredStringAt(j, ["title"]);
  const state = stringAt(j, ["state"]);
  const merged = typeof j === "object" && j !== null && (j as { merged?: unknown }).merged === true;
  const head = stringAt(j, ["head", "ref"]);
  const base = stringAt(j, ["base", "ref"]);
  const draft = typeof j === "object" && j !== null ? (j as { draft?: unknown }).draft : undefined;
  let shownState = state;
  if (merged) shownState = "merged: closing it does nothing";
  else if (state === "closed") shownState = "closed: it is already closed";
  return [
    { label: "Title", value: excerptHead(title) },
    ...presentFields([
      ["State", shownState === undefined ? undefined : excerptHead(shownState)],
      [
        "Branches",
        head === undefined || base === undefined ? undefined : excerptHead(`${head} -> ${base}`),
      ],
      ["Draft", typeof draft === "boolean" ? (draft ? "yes" : "no") : undefined],
      ["Author", excerptOpt(stringAt(j, ["user", "login"]))],
    ]),
  ];
}

/** A positive integer given as a number or a string of digits, else `undefined`. */
function pullNumberArg(v: unknown): number | undefined {
  const n = typeof v === "string" && /^[0-9]+$/.test(v) ? Number(v) : v;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 1 ? n : undefined;
}

/** `github_pr_get` input from a PR write: string owner and repo, a positive pull number; else no read. */
function githubPrReadArgs(
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  const owner = input["owner"];
  const repo = input["repo"];
  const pullNumber = pullNumberArg(input["pullNumber"]);
  if (typeof owner !== "string" || owner === "" || typeof repo !== "string" || repo === "") {
    return undefined;
  }
  return pullNumber === undefined ? undefined : { owner, repo, pullNumber };
}

function excerptOpt(v: string | undefined): string | undefined {
  return v === undefined ? undefined : excerptHead(v);
}

export const VCS_CI_ROWS: readonly ConnectorWriteRow[] = [
  // Spec § 15, OR-W34-3: merges, branch delete and tag create are irreversible, so wave 4 (always
  // prompts, needs a before-state and type-to-confirm, never auto-fires).
  row("github_pr_merge", "github.pr.merge", "mesh", 4),
  // Close without merging (PATCH `state: closed`); recoverable, the pull request can be reopened.
  withBefore(
    withPreview(row("github_pr_close", "github.pr.close", "mesh", 3), {
      target: "{owner}/{repo}#{pullNumber}",
      summary: "Close GitHub pull request {owner}/{repo}#{pullNumber} without merging",
      fields: [
        textField("owner"),
        textField("repo"),
        textField("pullNumber", "Pull request number"),
      ],
    }),
    {
      tool: "github_pr_get",
      argKeys: ["owner", "repo", "pullNumber"],
      args: githubPrReadArgs,
      select: selectGithubPrIdentity,
    },
  ),
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
