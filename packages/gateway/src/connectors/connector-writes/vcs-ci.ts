// packages/gateway/src/connectors/connector-writes/vcs-ci.ts
import {
  beforeReplyJson,
  excerptHead,
  presentFields,
  requiredStringAt,
  stringAt,
} from "./before-select.ts";
import { gitlabTitleIsDraftExact, gitlabTitleLooksDraft } from "./gitlab-draft.ts";
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
function positiveIntegerArg(v: unknown): number | undefined {
  const n = typeof v === "string" && /^[0-9]+$/.test(v) ? Number(v) : v;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 1 ? n : undefined;
}

/** `github_pr_get` input from a PR write: string owner and repo, a positive pull number; else no read. */
function githubPrReadArgs(
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  const owner = input["owner"];
  const repo = input["repo"];
  const pullNumber = positiveIntegerArg(input["pullNumber"]);
  if (typeof owner !== "string" || owner === "" || typeof repo !== "string" || repo === "") {
    return undefined;
  }
  return pullNumber === undefined ? undefined : { owner, repo, pullNumber };
}

/** The GitHub `github_pr_get` reply's boolean `draft`, else `undefined`. */
function draftOf(j: unknown): boolean | undefined {
  const d = typeof j === "object" && j !== null ? (j as { draft?: unknown }).draft : undefined;
  return typeof d === "boolean" ? d : undefined;
}

/** A non-empty string input, else `undefined`. */
function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
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
      ["Draft", draft === undefined ? undefined : draft ? "yes" : "no"],
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
