// packages/gateway/src/connectors/connector-writes/vcs-ci.ts
import {
  beforeReplyJson,
  excerptHead,
  nonEmptyString,
  positiveIntegerArg,
  presentFields,
  requiredStringAt,
  stringAt,
} from "./before-select.ts";
import { GITHUB_COMMIT_BOUND, GITLAB_COMMIT_BOUND } from "./commit-bound.ts";
import { gitlabTitleIsDraftExact, gitlabTitleLooksDraft } from "./gitlab-draft.ts";
import {
  type BeforeStateField,
  type ConnectorWriteRow,
  row,
  textField,
  withBefore,
  withBound,
  withConfirm,
  withPreview,
} from "./types.ts";
import {
  bitbucketPrReadArgs,
  CIRCLECI_BRANCH_AND_TAG_GUARD,
  circleciJobReadArgs,
  circleciPipelineReadArgs,
  GITHUB_MERGE_SHA_GUARD,
  GITHUB_TAG_SHA_GUARD,
  GITLAB_MERGE_SHA_GUARD,
  ghaLatestRunReadArgs,
  ghaRunReadArgs,
  githubBranchDeleteReadArgs,
  githubCommitReadArgs,
  githubPrReadArgs,
  gitlabMrReadArgs,
  gitlabPipelineReadArgs,
  jenkinsReadArgs,
  selectBitbucketPrMerge,
  selectCircleciJob,
  selectCircleciLatestPipeline,
  selectGhaLatestRun,
  selectGhaRun,
  selectGithubBranchDelete,
  selectGithubPrMerge,
  selectGithubTagCreate,
  selectGitlabMrMerge,
  selectGitlabPipelineCancel,
  selectGitlabPipelineRetry,
  selectJenkinsBuild,
  selectJenkinsJob,
} from "./vcs-ci-readers.ts";

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
      ["Draft", yesNo(typeof draft === "boolean" ? draft : undefined)],
      ["Author", excerptOpt(stringAt(j, ["user", "login"]))],
    ]),
  ];
}

/** `yes` or `no` for a boolean, else `undefined` (the line is then left out). */
function yesNo(value: boolean | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value ? "yes" : "no";
}

/** The GitHub `github_pr_get` reply's boolean `draft`, else `undefined`. */
function draftOf(j: unknown): boolean | undefined {
  const d = typeof j === "object" && j !== null ? (j as { draft?: unknown }).draft : undefined;
  return typeof d === "boolean" ? d : undefined;
}

const SHA_40 = /^[0-9a-f]{40}$/i;

/** `github_ref_get`'s reply: the 40-hex `sha` (required) and the `kind`, if any. */
function refReply(reply: unknown): { readonly sha: string; readonly kind: string | undefined } {
  const j = beforeReplyJson(reply);
  const sha = requiredStringAt(j, ["sha"]);
  if (!SHA_40.test(sha)) throw new Error("before reply: sha is not a commit id");
  return { sha, kind: stringAt(j, ["kind"]) };
}

/** `github_ref_get` input from a branch or pull request write: owner, repo and the named ref key. */
function githubRefReadArgs(
  input: Readonly<Record<string, unknown>>,
  refKey: string,
): Record<string, unknown> | undefined {
  const owner = nonEmptyString(input["owner"]);
  const repo = nonEmptyString(input["repo"]);
  const ref = nonEmptyString(input[refKey]);
  return owner === undefined || repo === undefined || ref === undefined
    ? undefined
    : { owner, repo, ref };
}

/**
 * GitHub branch create (before-state): what `fromRef` resolves to NOW, and whether the model's
 * `expectedSha` still matches. The window between this read and the dispatch is a stated bound
 * (`expectedSha` is shown, not injected; the create is recoverable and pushes no commit).
 */
export function selectGithubRefSha(
  reply: unknown,
  picked: Readonly<Record<string, unknown>>,
): readonly BeforeStateField[] {
  const { sha, kind } = refReply(reply);
  const expected = picked["expectedSha"];
  let check: string | undefined;
  if (expected !== undefined && expected !== null) {
    check =
      typeof expected === "string" && expected.toLowerCase() === sha.toLowerCase()
        ? "matches"
        : "DIFFERS: the write will fail";
  }
  return [
    {
      label: "fromRef resolves to",
      value: kind === undefined ? sha : `${sha} (${excerptHead(kind)})`,
    },
    ...presentFields([["expectedSha", check]]),
  ];
}

/**
 * GitHub pull request create (before-state): the BASE branch exists at a commit. The head is not
 * read (a fork head `user:branch` would make the state unavailable), and the preview says so.
 */
export function selectGithubPrBase(reply: unknown): readonly BeforeStateField[] {
  const { sha } = refReply(reply);
  return [
    { label: "Head branch", value: "not checked" },
    { label: "Base branch", value: `exists at ${sha.slice(0, 7)}` },
  ];
}

/** The current branch name against the picked one: `main`, `unchanged (main)` or a RETARGETS arrow. */
function retargetValue(current: string | undefined, picked: unknown): string {
  const shownCurrent = current === undefined ? undefined : excerptHead(current);
  if (picked === undefined || picked === null) return shownCurrent ?? "(unknown)";
  if (typeof picked === "string" && picked === current) return `unchanged (${shownCurrent})`;
  const next = typeof picked === "string" ? excerptHead(picked) : "(not a branch name)";
  return `${shownCurrent ?? "(unknown)"} -> ${next} (RETARGETS)`;
}

/**
 * GitHub pull request update (before-state): title, state, the base (a changed base reads
 * `RETARGETS`) and draft; never the body.
 */
export function selectGithubPrUpdate(
  reply: unknown,
  picked: Readonly<Record<string, unknown>>,
): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  const title = requiredStringAt(j, ["title"]);
  const state = stringAt(j, ["state"]);
  const merged = typeof j === "object" && j !== null && (j as { merged?: unknown }).merged === true;
  let shownState = state;
  if (merged) shownState = "merged: it is already merged";
  else if (state === "closed") shownState = "closed: it is already closed";
  const draft = draftOf(j);
  return [
    { label: "Title", value: excerptHead(title) },
    ...presentFields([
      ["State", shownState === undefined ? undefined : excerptHead(shownState)],
      ["Base", retargetValue(stringAt(j, ["base", "ref"]), picked["base"])],
      ["Draft", yesNo(draft)],
    ]),
  ];
}

/** The draft-state line of a GitLab merge request edit (see `gitlab-draft.ts`; display only). */
function gitlabDraftLine(currentDraft: boolean, newTitle: unknown): string {
  const now = currentDraft ? "draft" : "ready";
  if (typeof newTitle !== "string") return `unchanged (${now})`;
  const exact = gitlabTitleIsDraftExact(newTitle);
  if (exact !== gitlabTitleLooksDraft(newTitle)) {
    return "UNCERTAIN: the new title may or may not mark this merge request as draft";
  }
  if (exact === currentDraft) return `unchanged (${now})`;
  return currentDraft
    ? "MARKS READY: the new title drops its draft prefix"
    : "MARKS AS DRAFT: the new title adds a draft prefix";
}

/**
 * GitLab merge request update (before-state): title, state, the target branch (a changed one
 * reads `RETARGETS`) and the draft state; never the description.
 */
export function selectGitlabMrUpdate(
  reply: unknown,
  picked: Readonly<Record<string, unknown>>,
): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  const title = requiredStringAt(j, ["title"]);
  const draft = draftOf(j) ?? gitlabTitleLooksDraft(title);
  return [
    { label: "Title", value: excerptHead(title) },
    ...presentFields([
      ["State", excerptOpt(stringAt(j, ["state"]))],
      ["Target branch", retargetValue(stringAt(j, ["target_branch"]), picked["targetBranch"])],
    ]),
    { label: "Draft state", value: gitlabDraftLine(draft, picked["title"]) },
  ];
}

/** A before guard for an update the connector would throw on: none of `keys` is set. */
function emptyUpdateGuard(keys: readonly string[], reason: string) {
  return {
    reason,
    appliesTo: (picked: Readonly<Record<string, unknown>>) =>
      keys.every((k) => picked[k] === undefined || picked[k] === null),
    allows: () => false,
  };
}

function excerptOpt(v: string | undefined): string | undefined {
  return v === undefined ? undefined : excerptHead(v);
}

export const VCS_CI_ROWS: readonly ConnectorWriteRow[] = [
  // Spec § 15, OR-W34-3: merges, branch delete and tag create are irreversible, so wave 4 (always
  // prompts, needs a before-state and type-to-confirm, never auto-fires).
  // D1: the merge is shown beside the pull request it will merge. The model must send `sha` (the
  // head commit it saw); the reader's guard refuses unless the head is exactly that commit, and
  // GitHub enforces the same pin at merge time with a 409 (round-1 fix 1). `commitTitle` is shown
  // in full and not scanned (see the free-text table in d1-templates.test.ts).
  withConfirm(
    withBefore(
      withPreview(row("github_pr_merge", "github.pr.merge", "mesh", 4), {
        target: "{owner}/{repo}#{pullNumber}",
        summary:
          "Merge GitHub pull request {owner}/{repo}#{pullNumber}; Nimbus cannot undo a merge",
        fields: [
          textField("owner"),
          textField("repo"),
          textField("pullNumber", "Pull request number"),
          textField(
            "sha",
            "Head commit that must match",
            "(not set: NOT PINNED, the merge uses whatever the head is when it runs)",
          ),
          textField("mergeMethod", "Merge method", "(not set: a merge commit)"),
          textField("commitTitle", "Commit title", "(not set: GitHub's default title)"),
        ],
      }),
      {
        tool: "github_pr_get",
        // `sha` is declared for the select and the guard, never sent to the read.
        argKeys: ["owner", "repo", "pullNumber", "sha"],
        args: githubPrReadArgs,
        select: selectGithubPrMerge,
        guard: GITHUB_MERGE_SHA_GUARD,
      },
    ),
    { template: "merge {owner}/{repo}#{pullNumber}" },
  ),
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
  // create writes are recoverable (the branch/PR/MR can be deleted or closed), the updates are not
  // (the connector captures the old text first). C2 templates all six; the four creates are also
  // proposable over MCP behind the same refusals, the two updates are not (no act-door before-state).
  // `expectedSha` is SHOWN, not injected (bound: a ref can move between the read and the dispatch).
  withBefore(
    withPreview(row("github_branch_create", "github.branch.create", "mesh", 3), {
      target: "{owner}/{repo}:{branch}",
      summary: "Create GitHub branch {branch} in {owner}/{repo} from {fromRef}",
      fields: [
        textField("owner"),
        textField("repo"),
        textField("branch", "Branch to create"),
        textField("fromRef", "Create it from (branch, tag or commit)"),
        textField(
          "expectedSha",
          "Expected commit",
          "(not set: the branch is created from whatever fromRef is when you approve)",
        ),
      ],
    }),
    {
      tool: "github_ref_get",
      argKeys: ["owner", "repo", "fromRef", "expectedSha"],
      args: (input) => githubRefReadArgs(input, "fromRef"),
      select: selectGithubRefSha,
    },
  ),
  // The head is not read (a fork head `user:branch` has no ref on the base repository).
  withBefore(
    withPreview(row("github_pr_create", "github.pr.create", "mesh", 3), {
      target: "{owner}/{repo}",
      summary: "Open GitHub pull request {head} -> {base} in {owner}/{repo}",
      fields: [
        textField("owner"),
        textField("repo"),
        textField("head", "Head (branch, or user:branch for a fork)"),
        textField("base", "Base branch"),
        textField("title", "Title"),
        textField("body", "Description", "(not set: no description)"),
        textField("draft", "Draft", "(not set: opened ready for review)"),
      ],
    }),
    {
      tool: "github_ref_get",
      argKeys: ["owner", "repo", "base"],
      args: (input) => githubRefReadArgs(input, "base"),
      select: selectGithubPrBase,
    },
  ),
  withBefore(
    withPreview(row("github_pr_update", "github.pr.update", "mesh", 3), {
      target: "{owner}/{repo}#{pullNumber}",
      summary: "Update GitHub pull request {owner}/{repo}#{pullNumber}",
      fields: [
        textField("owner"),
        textField("repo"),
        textField("pullNumber", "Pull request number"),
        textField("title", "New title", "(not set: unchanged)"),
        textField(
          "body",
          "New description (replaces the whole description)",
          "(not set: unchanged)",
        ),
        textField("base", "New base branch", "(not set: unchanged)"),
      ],
    }),
    {
      tool: "github_pr_get",
      // `title`, `body` and `base` are declared for the select and the guard, never sent to the read.
      argKeys: ["owner", "repo", "pullNumber", "title", "body", "base"],
      args: githubPrReadArgs,
      select: selectGithubPrUpdate,
      guard: emptyUpdateGuard(["title", "body", "base"], "set at least one of title, body, base"),
    },
  ),
  withPreview(row("gitlab_branch_create", "gitlab.branch.create", "mesh", 3), {
    target: "{projectPath}:{branch}",
    summary: "Create GitLab branch {branch} in {projectPath} from {fromRef}",
    fields: [
      textField("projectPath"),
      textField("branch", "Branch to create"),
      textField("fromRef", "Create it from (branch, tag or commit)"),
      textField(
        "expectedSha",
        "Expected commit",
        "(not set: the branch is created from whatever fromRef is when you approve)",
      ),
    ],
  }),
  withPreview(row("gitlab_mr_create", "gitlab.mr.create", "mesh", 3), {
    target: "{projectPath}",
    summary: "Open GitLab merge request {sourceBranch} -> {targetBranch} in {projectPath}",
    fields: [
      textField("projectPath"),
      textField("sourceBranch", "Source branch"),
      textField("targetBranch", "Target branch"),
      textField("title", "Title (a Draft: or [Draft] prefix opens it as a draft)"),
      textField("description", "Description", "(not set: no description)"),
    ],
  }),
  withBefore(
    withPreview(row("gitlab_mr_update", "gitlab.mr.update", "mesh", 3), {
      target: "{projectPath}!{mergeRequestIid}",
      summary: "Update GitLab merge request {projectPath}!{mergeRequestIid}",
      fields: [
        textField("projectPath"),
        textField("mergeRequestIid", "Merge request number"),
        textField("title", "New title", "(not set: unchanged)"),
        textField(
          "description",
          "New description (replaces the whole description)",
          "(not set: unchanged)",
        ),
        textField("targetBranch", "New target branch", "(not set: unchanged)"),
      ],
    }),
    {
      tool: "gitlab_mr_get",
      // `title`, `description` and `targetBranch` are declared for the select and the guard,
      // never sent to the read.
      argKeys: ["projectPath", "mergeRequestIid", "title", "description", "targetBranch"],
      args: (input) => {
        const projectPath = nonEmptyString(input["projectPath"]);
        const mergeRequestIid = positiveIntegerArg(input["mergeRequestIid"]);
        return projectPath === undefined || mergeRequestIid === undefined
          ? undefined
          : { projectPath, mergeRequestIid };
      },
      select: selectGitlabMrUpdate,
      guard: emptyUpdateGuard(
        ["title", "description", "targetBranch"],
        "set at least one of title, description, targetBranch",
      ),
    },
  ),
  withConfirm(
    withBefore(
      withPreview(row("github_branch_delete", "github.branch.delete", "mesh", 4), {
        target: "{owner}/{repo}@{branch}",
        summary:
          "Delete GitHub branch {branch} from {owner}/{repo}; the commits only it holds become unreachable",
        fields: [textField("owner"), textField("repo"), textField("branch")],
      }),
      {
        tool: "github_ref_get",
        argKeys: ["owner", "repo", "branch"],
        args: githubBranchDeleteReadArgs,
        select: selectGithubBranchDelete,
      },
    ),
    { template: "delete {owner}/{repo}@{branch}" },
  ),
  // D1 (round-1 fix 7): the commit read resolves `sha` (7 to 40 characters) and the guard refuses
  // unless the resolved commit starts with it, so a branch or tag name cannot stand for a sha.
  withConfirm(
    withBefore(
      withPreview(row("github_tag_create", "github.tag.create", "mesh", 4), {
        target: "{owner}/{repo}@{tag}",
        summary: "Create GitHub tag {tag} in {owner}/{repo} pointing at commit {sha}",
        fields: [
          textField("owner"),
          textField("repo"),
          textField("tag"),
          textField("sha", "Commit sha"),
        ],
      }),
      {
        tool: "github_commit_get",
        argKeys: ["owner", "repo", "sha"],
        args: githubCommitReadArgs,
        select: selectGithubTagCreate,
        guard: GITHUB_TAG_SHA_GUARD,
      },
    ),
    { template: "create {owner}/{repo}@{tag}" },
  ),
  // D1: `sha` is optional on GitLab. When the model sends one the guard refuses a mismatch with the
  // merge request's head; without one the preview says NOT PINNED and GitLab merges whatever the
  // head is. `mergeCommitMessage` is shown in full and not scanned.
  withConfirm(
    withBefore(
      withPreview(row("gitlab_mr_merge", "gitlab.mr.merge", "mesh", 4), {
        target: "{projectPath}!{mergeRequestIid}",
        summary:
          "Merge GitLab merge request {projectPath}!{mergeRequestIid}; Nimbus cannot undo a merge",
        fields: [
          textField("projectPath"),
          textField("mergeRequestIid", "Merge request number"),
          textField(
            "sha",
            "Pinned head commit",
            "(not set: NOT PINNED, the merge uses whatever the head is when it runs)",
          ),
          textField("squash", "Squash", "(not set: the merge request's own setting)"),
          textField(
            "shouldRemoveSourceBranch",
            "Delete the source branch",
            "(not set: the merge request's own setting)",
          ),
          textField("mergeCommitMessage", "Merge commit message", "(not set: GitLab's default)"),
        ],
      }),
      {
        tool: "gitlab_mr_get",
        // `sha` is declared for the guard, never sent to the read.
        argKeys: ["projectPath", "mergeRequestIid", "sha"],
        args: gitlabMrReadArgs,
        select: selectGitlabMrMerge,
        guard: GITLAB_MERGE_SHA_GUARD,
      },
    ),
    { template: "merge {projectPath}!{mergeRequestIid}" },
  ),
  // The multi-file commit writes (connectors 0.8, Project D; bound and previewed in D1c). Each is
  // BOUND to the branch head its prepare tool read (`expectedHeadSha`, injected by the gateway, never
  // the caller's) and shows the owner the whole change as a unified diff the gateway renders from
  // the caller's text and the prepare reply (`commit-bound.ts`, `diff.ts`). `message` and the file
  // text are shown in full and are not scanned for remote content: file text is code (spec § 15.3).
  // The act door denies both (class vcs): its consent display has no diff (`proposable-actions.ts`).
  withConfirm(
    withBound(
      withPreview(row("github_file_commit", "github.file.commit", "mesh", 4), {
        target: "{owner}/{repo}@{branch}",
        summary: "Commit to branch {branch} of {owner}/{repo} as ONE commit (full diff below)",
        fields: [
          textField("owner", "Owner"),
          textField("repo", "Repository"),
          textField("branch", "Branch"),
          textField("message", "Commit message"),
          { key: "files", label: "Files", kind: "diff" },
        ],
      }),
      GITHUB_COMMIT_BOUND,
    ),
    { template: "commit {owner}/{repo}@{branch}" },
  ),
  withConfirm(
    withBound(
      withPreview(row("gitlab_commit_create", "gitlab.commit.create", "mesh", 4), {
        target: "{projectPath}@{branch}",
        summary: "Commit to branch {branch} of {projectPath} as ONE commit (full diff below)",
        fields: [
          textField("projectPath", "Project"),
          textField("branch", "Branch"),
          textField("message", "Commit message"),
          { key: "files", label: "Files", kind: "diff" },
        ],
      }),
      GITLAB_COMMIT_BOUND,
    ),
    { template: "commit {projectPath}@{branch}" },
  ),
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
  // The Bitbucket merge has no head precondition the connector can send, so it is NEVER offered to
  // the model (`MODEL_NEVER_OFFERED_TOOL_IDS`, round-1 fix 8). It keeps its preview and its
  // reader for the owner's own doors. `message` is shown in full and not scanned.
  withConfirm(
    withBefore(
      withPreview(row("bitbucket_pr_merge", "bitbucket.pr.merge", "mesh", 4), {
        target: "{repoFull}#{pullRequestId}",
        summary:
          "Merge Bitbucket pull request {repoFull}#{pullRequestId}; Nimbus cannot undo a merge",
        fields: [
          textField("repoFull", "Repository"),
          textField("pullRequestId", "Pull request number"),
          textField(
            "mergeStrategy",
            "Merge strategy",
            "(not set: the repository's default strategy)",
          ),
          textField("message", "Merge commit message", "(not set: Bitbucket's default message)"),
        ],
      }),
      {
        tool: "bitbucket_pr_get",
        argKeys: ["repoFull", "pullRequestId"],
        args: bitbucketPrReadArgs,
        select: selectBitbucketPrMerge,
      },
    ),
    { template: "merge {repoFull}#{pullRequestId}" },
  ),
  withConfirm(
    withBefore(
      withPreview(row("jenkins_build_trigger", "jenkins.build.trigger", "mesh", 4), {
        target: "{jobName}",
        summary:
          "Start a new build of Jenkins job {jobName}; the connector sends no build parameters",
        fields: [textField("jobName", "Job")],
      }),
      {
        tool: "jenkins_job_get",
        argKeys: ["jobName"],
        args: (input) => jenkinsReadArgs(input, false),
        select: selectJenkinsJob,
      },
    ),
    { template: "trigger {jobName}" },
  ),
  withConfirm(
    withBefore(
      withPreview(row("jenkins_build_abort", "jenkins.build.abort", "mesh", 4), {
        target: "{jobName}#{buildNumber}",
        summary: "Abort build {buildNumber} of Jenkins job {jobName}",
        fields: [textField("jobName", "Job"), textField("buildNumber", "Build number")],
      }),
      {
        tool: "jenkins_build_get",
        argKeys: ["jobName", "buildNumber"],
        args: (input) => jenkinsReadArgs(input, true),
        select: selectJenkinsBuild,
      },
    ),
    { template: "abort {jobName}#{buildNumber}" },
  ),
  // `inputs` is shown in full and not scanned; the read shows the latest run on the branch the
  // dispatch will use (any workflow), the nearest the connector's reads come to "what is running".
  withConfirm(
    withBefore(
      withPreview(row("gha_run_trigger", "github_actions.run.trigger", "mesh", 4), {
        target: "{owner}/{repo}:{workflowId}",
        summary: "Dispatch GitHub Actions workflow {workflowId} in {owner}/{repo}",
        fields: [
          textField("owner"),
          textField("repo"),
          textField("workflowId", "Workflow (id or file name)"),
          textField("ref", "Branch or tag", "(not set: main)"),
          textField("inputs", "Workflow inputs", "(not set: none)"),
        ],
      }),
      {
        tool: "gha_run_list",
        // `ref` is read for the branch the dispatch uses (the connector defaults it to main).
        argKeys: ["owner", "repo", "ref"],
        args: ghaLatestRunReadArgs,
        select: selectGhaLatestRun,
      },
    ),
    { template: "trigger {owner}/{repo}:{workflowId}" },
  ),
  withConfirm(
    withBefore(
      withPreview(row("gha_run_cancel", "github_actions.run.cancel", "mesh", 4), {
        target: "{owner}/{repo}#{runId}",
        summary: "Cancel GitHub Actions run {runId} in {owner}/{repo}",
        fields: [textField("owner"), textField("repo"), textField("runId", "Run id")],
      }),
      {
        tool: "gha_run_get",
        argKeys: ["owner", "repo", "runId"],
        args: ghaRunReadArgs,
        select: selectGhaRun,
      },
    ),
    { template: "cancel {owner}/{repo}#{runId}" },
  ),
  // The connector sends `tag` when one is set and `branch` (default main) otherwise; `parameters`
  // is shown in full and not scanned.
  withConfirm(
    withBefore(
      withPreview(row("circleci_pipeline_trigger", "circleci.pipeline.trigger", "mesh", 4), {
        target: "{projectSlug}",
        summary: "Start a CircleCI pipeline on project {projectSlug}",
        fields: [
          textField("projectSlug", "Project"),
          textField("branch", "Branch", "(not set: main, unless a tag is given)"),
          textField("tag", "Tag", "(not set: none)"),
          textField("parameters", "Pipeline parameters", "(not set: none)"),
        ],
      }),
      {
        tool: "circleci_pipeline_list",
        // `branch` and `tag` are declared for the guard, never sent to the read.
        argKeys: ["projectSlug", "branch", "tag"],
        args: circleciPipelineReadArgs,
        select: selectCircleciLatestPipeline,
        guard: CIRCLECI_BRANCH_AND_TAG_GUARD,
      },
    ),
    { template: "trigger {projectSlug}" },
  ),
  withConfirm(
    withBefore(
      withPreview(row("circleci_job_cancel", "circleci.job.cancel", "mesh", 4), {
        target: "{projectSlug}#{jobNumber}",
        summary: "Cancel job {jobNumber} of CircleCI project {projectSlug}",
        fields: [textField("projectSlug", "Project"), textField("jobNumber", "Job number")],
      }),
      {
        tool: "circleci_job_get",
        argKeys: ["projectSlug", "jobNumber"],
        args: circleciJobReadArgs,
        select: selectCircleciJob,
      },
    ),
    { template: "cancel {projectSlug}#{jobNumber}" },
  ),
  withConfirm(
    withBefore(
      withPreview(row("gitlab_pipeline_retry", "gitlab.pipeline.retry", "mesh", 4), {
        target: "{projectPath}#{pipelineId}",
        summary: "Retry the failed jobs of GitLab pipeline {pipelineId} in {projectPath}",
        fields: [textField("projectPath"), textField("pipelineId", "Pipeline id")],
      }),
      {
        tool: "gitlab_pipeline_get",
        argKeys: ["projectPath", "pipelineId"],
        args: gitlabPipelineReadArgs,
        select: selectGitlabPipelineRetry,
      },
    ),
    { template: "retry {projectPath}#{pipelineId}" },
  ),
  withConfirm(
    withBefore(
      withPreview(row("gitlab_pipeline_cancel", "gitlab.pipeline.cancel", "mesh", 4), {
        target: "{projectPath}#{pipelineId}",
        summary: "Cancel GitLab pipeline {pipelineId} in {projectPath}",
        fields: [textField("projectPath"), textField("pipelineId", "Pipeline id")],
      }),
      {
        tool: "gitlab_pipeline_get",
        argKeys: ["projectPath", "pipelineId"],
        args: gitlabPipelineReadArgs,
        select: selectGitlabPipelineCancel,
      },
    ),
    { template: "cancel {projectPath}#{pipelineId}" },
  ),
];
