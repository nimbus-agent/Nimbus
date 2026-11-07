// packages/gateway/src/connectors/connector-writes/vcs-ci-readers.ts
// The before-state readers of the Wave 4 VCS and CI writes (Phase 9.7 D1, group A): the merges, the
// branch delete, the tag create, the Jenkins, GitHub Actions, CircleCI and GitLab pipeline writes.
// Each reply shape is the one the installed connector produces (GitHub, GitLab and Bitbucket reads
// return the service's own JSON; the CircleCI job and the GitHub commit are the connector's own
// projections). Imported BY `vcs-ci.ts`, so it imports nothing from the row table.
import {
  arrayAt,
  beforeReplyJson,
  boolAt,
  excerptHead,
  nonEmptyString,
  positiveIntegerArg,
  presentFields,
  requiredStringAt,
  stringAt,
  yesNo,
} from "./before-select.ts";
import type { BeforeStateField, BeforeStateGuard } from "./types.ts";

type Picked = Readonly<Record<string, unknown>>;
type Input = Readonly<Record<string, unknown>>;

const SHA_40 = /^[0-9a-f]{40}$/i;
const SHA_PREFIX = /^[0-9a-f]{7,40}$/i;

function shown(v: string | undefined): string | undefined {
  return v === undefined ? undefined : excerptHead(v);
}

/** `head -> base` from two optional names, else `undefined`. */
function arrow(from: string | undefined, to: string | undefined): string | undefined {
  return from === undefined || to === undefined ? undefined : excerptHead(`${from} -> ${to}`);
}

/** `github_pr_get` input from a PR write: string owner and repo, a positive pull number; else no read. */
export function githubPrReadArgs(input: Input): Record<string, unknown> | undefined {
  const owner = nonEmptyString(input["owner"]);
  const repo = nonEmptyString(input["repo"]);
  const pullNumber = positiveIntegerArg(input["pullNumber"]);
  return owner === undefined || repo === undefined || pullNumber === undefined
    ? undefined
    : { owner, repo, pullNumber };
}

/** The changes line of a pull request: only the numbers the reply carries. */
function prChanges(j: unknown): string | undefined {
  const commits = stringAt(j, ["commits"]);
  const files = stringAt(j, ["changed_files"]);
  const adds = stringAt(j, ["additions"]);
  const dels = stringAt(j, ["deletions"]);
  const parts: string[] = [];
  if (commits !== undefined) parts.push(`${commits} commits`);
  if (files !== undefined) parts.push(`${files} files`);
  if (adds !== undefined || dels !== undefined) {
    parts.push(`+${adds ?? "?"} -${dels ?? "?"}`);
  }
  return parts.length === 0 ? undefined : parts.join(", ");
}

/**
 * GitHub `github_pr_get` (before-state) for a merge: title, state (a merged or closed pull request
 * says so), the branches, the head commit the merge would take (the model's `sha` must equal it:
 * the guard), draft, mergeable state, changes and author. Never the body.
 */
export function selectGithubPrMerge(reply: unknown): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  const title = requiredStringAt(j, ["title"]);
  const state = stringAt(j, ["state"]);
  let shownState = state;
  if (boolAt(j, ["merged"]) === true) shownState = "merged: it is already merged";
  else if (state === "closed") shownState = "closed: it is not open";
  return [
    { label: "Title", value: excerptHead(title) },
    ...presentFields([
      ["State", shown(shownState)],
      ["Branches", arrow(stringAt(j, ["head", "ref"]), stringAt(j, ["base", "ref"]))],
      ["Head commit", shown(stringAt(j, ["head", "sha"]))],
      ["Draft", yesNo(boolAt(j, ["draft"]))],
      ["Mergeable", shown(stringAt(j, ["mergeable_state"]))],
      ["Changes", shown(prChanges(j))],
      ["Author", shown(stringAt(j, ["user", "login"]))],
    ]),
  ];
}

/**
 * The GitHub merge guard (round-1 fix 1): the model must send `sha`, and the pull request's head
 * must be exactly that commit. Case-sensitive: the connector validates `sha` as 40 lowercase hex
 * and GitHub reports lowercase. An absent or unreadable `sha` or head refuses.
 */
export const GITHUB_MERGE_SHA_GUARD: BeforeStateGuard = {
  reason:
    "the merge must name the pull request's current head commit as sha, and it is not that commit",
  appliesTo: () => true,
  allows: (reply, picked) => {
    const sha = picked["sha"];
    const head = stringAt(beforeReplyJson(reply), ["head", "sha"]);
    return typeof sha === "string" && SHA_40.test(sha) && head !== undefined && sha === head;
  },
};

/** `github_ref_get` input for a branch delete: the branch as `heads/<branch>`, so `kind` is a branch. */
export function githubBranchDeleteReadArgs(input: Input): Record<string, unknown> | undefined {
  const owner = nonEmptyString(input["owner"]);
  const repo = nonEmptyString(input["repo"]);
  const branch = nonEmptyString(input["branch"]);
  return owner === undefined || repo === undefined || branch === undefined
    ? undefined
    : { owner, repo, ref: `heads/${branch}` };
}

/** GitHub `github_ref_get` (before-state) for a branch delete: the commit the branch holds, which a delete loses. */
export function selectGithubBranchDelete(
  reply: unknown,
  picked: Picked,
): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  const sha = requiredStringAt(j, ["sha"]);
  if (!SHA_40.test(sha)) throw new Error("before reply: sha is not a commit id");
  const branch = picked["branch"];
  return [
    { label: "Branch", value: typeof branch === "string" ? excerptHead(branch) : "(unknown)" },
    { label: "Head commit", value: sha },
  ];
}

/** `github_commit_get` input for a tag create: `owner/repo` and the sha the tag will point at. */
export function githubCommitReadArgs(input: Input): Record<string, unknown> | undefined {
  const owner = nonEmptyString(input["owner"]);
  const repo = nonEmptyString(input["repo"]);
  const sha = nonEmptyString(input["sha"]);
  return owner === undefined || repo === undefined || sha === undefined
    ? undefined
    : { repoFull: `${owner}/${repo}`, ref: sha };
}

/**
 * GitHub `github_commit_get` (before-state) for a tag create: the FULL sha the read resolved beside
 * the sha the model named (an abbreviation resolves to the full one), the commit's first message
 * line, author and date.
 */
export function selectGithubTagCreate(reply: unknown, picked: Picked): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  const sha = requiredStringAt(j, ["sha"]);
  const requested = picked["sha"];
  return [
    { label: "Resolves to", value: sha },
    {
      label: "Requested sha",
      value: typeof requested === "string" ? excerptHead(requested) : "(not a string)",
    },
    ...presentFields([
      ["Message", shown(stringAt(j, ["message"]))],
      ["Author", shown(stringAt(j, ["authorName"]))],
      ["Authored", shown(stringAt(j, ["authorDate"]))],
    ]),
  ];
}

/**
 * The GitHub tag guard (round-1 fix 7): the commit the read resolved must START WITH the sha the
 * model named, so a branch or tag name (which the commit read also accepts) cannot stand for a sha.
 */
export const GITHUB_TAG_SHA_GUARD: BeforeStateGuard = {
  reason: "the sha is not a commit id, or it is not the commit the read resolved",
  appliesTo: () => true,
  allows: (reply, picked) => {
    const requested = picked["sha"];
    if (typeof requested !== "string" || !SHA_PREFIX.test(requested)) return false;
    const resolved = stringAt(beforeReplyJson(reply), ["sha"]);
    return resolved?.toLowerCase().startsWith(requested.toLowerCase()) === true;
  },
};

/** `gitlab_mr_get` input for a merge: a project path and a merge request iid. */
export function gitlabMrReadArgs(input: Input): Record<string, unknown> | undefined {
  const projectPath = nonEmptyString(input["projectPath"]);
  const mergeRequestIid = positiveIntegerArg(input["mergeRequestIid"]);
  return projectPath === undefined || mergeRequestIid === undefined
    ? undefined
    : { projectPath, mergeRequestIid };
}

/**
 * GitLab `gitlab_mr_get` (before-state) for a merge: title, state, branches, the head commit, draft,
 * the merge status and conflicts, the merge request's own squash and source-branch settings and the
 * size of the change. The model's `sha` (when given) is compared by the guard, not here.
 */
export function selectGitlabMrMerge(reply: unknown): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  const title = requiredStringAt(j, ["title"]);
  return [
    { label: "Title", value: excerptHead(title) },
    ...presentFields([
      ["State", shown(stringAt(j, ["state"]))],
      ["Branches", arrow(stringAt(j, ["source_branch"]), stringAt(j, ["target_branch"]))],
      ["Head commit", shown(stringAt(j, ["sha"]))],
      ["Draft", yesNo(boolAt(j, ["draft"]))],
      [
        "Merge status",
        shown(stringAt(j, ["detailed_merge_status"]) ?? stringAt(j, ["merge_status"])),
      ],
      ["Conflicts", yesNo(boolAt(j, ["has_conflicts"]))],
      ["Squash (the merge request's own setting)", yesNo(boolAt(j, ["squash"]))],
      [
        "Removes source branch (the merge request's own setting)",
        yesNo(boolAt(j, ["force_remove_source_branch"])),
      ],
      ["Changes", shown(stringAt(j, ["changes_count"]))],
    ]),
  ];
}

/**
 * The GitLab merge guard: applies only when the model pinned a `sha`; allows only when it equals the
 * merge request's current head commit (case-insensitive; GitLab accepts either case).
 */
export const GITLAB_MERGE_SHA_GUARD: BeforeStateGuard = {
  reason: "the pinned sha is not the merge request's current head commit",
  appliesTo: (picked) => picked["sha"] !== undefined && picked["sha"] !== null,
  allows: (reply, picked) => {
    const sha = picked["sha"];
    const head = stringAt(beforeReplyJson(reply), ["sha"]);
    return (
      typeof sha === "string" &&
      sha !== "" &&
      head !== undefined &&
      sha.toLowerCase() === head.toLowerCase()
    );
  },
};

/** `bitbucket_pr_get` input for a merge: a `workspace/repo` and a pull request id. */
export function bitbucketPrReadArgs(input: Input): Record<string, unknown> | undefined {
  const repoFull = nonEmptyString(input["repoFull"]);
  const pullRequestId = positiveIntegerArg(input["pullRequestId"]);
  return repoFull === undefined || pullRequestId === undefined
    ? undefined
    : { repoFull, pullRequestId };
}

/** Bitbucket `bitbucket_pr_get` (before-state) for a merge: title, state, branches, source commit, author. */
export function selectBitbucketPrMerge(reply: unknown): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  const title = requiredStringAt(j, ["title"]);
  return [
    { label: "Title", value: excerptHead(title) },
    ...presentFields([
      ["State", shown(stringAt(j, ["state"]))],
      [
        "Branches",
        arrow(
          stringAt(j, ["source", "branch", "name"]),
          stringAt(j, ["destination", "branch", "name"]),
        ),
      ],
      ["Source commit", shown(stringAt(j, ["source", "commit", "hash"]))],
      ["Author", shown(stringAt(j, ["author", "display_name"]))],
      ["Closes source branch", yesNo(boolAt(j, ["close_source_branch"]))],
    ]),
  ];
}

/** `jenkins_job_get` / `jenkins_build_get` input: the job name, and the build number when given. */
export function jenkinsReadArgs(
  input: Input,
  withBuild: boolean,
): Record<string, unknown> | undefined {
  const jobName = nonEmptyString(input["jobName"]);
  if (jobName === undefined) return undefined;
  if (!withBuild) return { jobName };
  const buildNumber = positiveIntegerArg(input["buildNumber"]);
  return buildNumber === undefined ? undefined : { jobName, buildNumber };
}

/** The build number inside a Jenkins `lastBuild`-style reference. */
function buildRef(j: unknown, key: string): string | undefined {
  const n = stringAt(j, [key, "number"]);
  return n === undefined ? undefined : `#${n}`;
}

/** Jenkins `jenkins_job_get` (before-state) for a trigger: the job and its recent builds. */
export function selectJenkinsJob(reply: unknown): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  const name = stringAt(j, ["fullName"]) ?? requiredStringAt(j, ["name"]);
  return [
    { label: "Job", value: excerptHead(name) },
    ...presentFields([
      ["Buildable", yesNo(boolAt(j, ["buildable"]))],
      ["In queue", yesNo(boolAt(j, ["inQueue"]))],
      ["Last build", buildRef(j, "lastBuild")],
      ["Last successful", buildRef(j, "lastSuccessfulBuild")],
      ["Last failed", buildRef(j, "lastFailedBuild")],
      ["Status", shown(stringAt(j, ["color"]))],
    ]),
  ];
}

/** An ISO time from a millisecond timestamp, else `undefined`. */
function isoOfMillis(ms: string | undefined): string | undefined {
  if (ms === undefined) return undefined;
  const d = new Date(Number(ms));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Jenkins `jenkins_build_get` (before-state) for an abort: whether the build is running at all. */
export function selectJenkinsBuild(reply: unknown): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  const name = requiredStringAt(j, ["fullDisplayName"]);
  const building = boolAt(j, ["building"]);
  let buildingValue: string | undefined;
  if (building === true) buildingValue = "yes";
  else if (building === false) buildingValue = "no: it is not running, so aborting does nothing";
  const duration = stringAt(j, ["duration"]);
  return [
    { label: "Build", value: excerptHead(name) },
    ...presentFields([
      ["Building", buildingValue],
      ["Result", shown(stringAt(j, ["result"]))],
      ["Started", isoOfMillis(stringAt(j, ["timestamp"]))],
      ["Duration", duration === undefined ? undefined : `${duration} ms`],
    ]),
  ];
}

/** `gha_run_list` input for a workflow dispatch: the latest run on the branch the dispatch will use. */
export function ghaLatestRunReadArgs(input: Input): Record<string, unknown> | undefined {
  const owner = nonEmptyString(input["owner"]);
  const repo = nonEmptyString(input["repo"]);
  if (owner === undefined || repo === undefined) return undefined;
  const ref = input["ref"];
  // Unset: the connector dispatches on `main`. Present but not a non-empty string: no read.
  const branch = ref === undefined ? "main" : nonEmptyString(ref);
  return branch === undefined ? undefined : { owner, repo, branch, perPage: 1 };
}

/** GitHub Actions `gha_run_list` (before-state) for a dispatch: the latest run on the branch, ANY workflow. */
export function selectGhaLatestRun(reply: unknown, picked: Picked): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  const runs = arrayAt(j, ["workflow_runs"]);
  if (runs === undefined) throw new Error("before reply: no workflow_runs");
  const ref = picked["ref"];
  const branch = typeof ref === "string" ? ref : "main";
  const branchField: BeforeStateField = {
    label: "Branch (latest run of ANY workflow)",
    value: excerptHead(branch),
  };
  const run: unknown = runs[0];
  if (run === undefined) {
    return [branchField, { label: "Latest run", value: "(none on this branch)" }];
  }
  return [
    branchField,
    ...presentFields([
      ["Workflow", shown(stringAt(run, ["name"]))],
      ["Run number", stringAt(run, ["run_number"])],
      ["Status", shown(stringAt(run, ["status"]))],
      ["Conclusion", shown(stringAt(run, ["conclusion"]))],
      ["Event", shown(stringAt(run, ["event"]))],
      ["Commit", shown(stringAt(run, ["head_sha"]))],
      ["Started", shown(stringAt(run, ["run_started_at"]))],
      ["Actor", shown(stringAt(run, ["actor", "login"]))],
    ]),
  ];
}

/** `gha_run_get` input for a cancel. */
export function ghaRunReadArgs(input: Input): Record<string, unknown> | undefined {
  const owner = nonEmptyString(input["owner"]);
  const repo = nonEmptyString(input["repo"]);
  const runId = positiveIntegerArg(input["runId"]);
  return owner === undefined || repo === undefined || runId === undefined
    ? undefined
    : { owner, repo, runId };
}

/** GitHub Actions `gha_run_get` (before-state) for a cancel; a completed run says cancelling does nothing. */
export function selectGhaRun(reply: unknown): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  const name = stringAt(j, ["name"]) ?? requiredStringAt(j, ["display_title"]);
  const status = stringAt(j, ["status"]);
  const shownStatus =
    status === "completed"
      ? "completed: it has already finished, so cancelling does nothing"
      : status;
  return [
    { label: "Workflow", value: excerptHead(name) },
    ...presentFields([
      ["Run number", stringAt(j, ["run_number"])],
      ["Branch", shown(stringAt(j, ["head_branch"]))],
      ["Status", shown(shownStatus)],
      ["Conclusion", shown(stringAt(j, ["conclusion"]))],
      ["Event", shown(stringAt(j, ["event"]))],
      ["Commit", shown(stringAt(j, ["head_sha"]))],
    ]),
  ];
}

/** `circleci_pipeline_list` input for a trigger: the project slug (the list cannot filter by branch). */
export function circleciPipelineReadArgs(input: Input): Record<string, unknown> | undefined {
  const projectSlug = nonEmptyString(input["projectSlug"]);
  return projectSlug === undefined ? undefined : { projectSlug };
}

/** CircleCI `circleci_pipeline_list` (before-state) for a trigger: the latest pipeline of the project, ANY branch. */
export function selectCircleciLatestPipeline(reply: unknown): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  const items = arrayAt(j, ["items"]);
  if (items === undefined) throw new Error("before reply: no items");
  const latest: unknown = items[0];
  if (latest === undefined) {
    return [{ label: "Latest pipeline (ANY branch)", value: "(none)" }];
  }
  const ref = stringAt(latest, ["vcs", "tag"]) ?? stringAt(latest, ["vcs", "branch"]);
  return [
    { label: "Latest pipeline (ANY branch)", value: `#${requiredStringAt(latest, ["number"])}` },
    ...presentFields([
      ["State", shown(stringAt(latest, ["state"]))],
      ["Branch or tag", shown(ref)],
      ["Trigger", shown(stringAt(latest, ["trigger", "type"]))],
      ["Created", shown(stringAt(latest, ["created_at"]))],
    ]),
  ];
}

/** `circleci_job_get` input for a cancel. */
export function circleciJobReadArgs(input: Input): Record<string, unknown> | undefined {
  const projectSlug = nonEmptyString(input["projectSlug"]);
  const jobNumber = positiveIntegerArg(input["jobNumber"]);
  return projectSlug === undefined || jobNumber === undefined
    ? undefined
    : { projectSlug, jobNumber };
}

/** CircleCI `circleci_job_get` (before-state) for a cancel; a stopped job says cancelling does nothing. */
export function selectCircleciJob(reply: unknown): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  const name = stringAt(j, ["name"]) ?? `job ${requiredStringAt(j, ["number"])}`;
  const status = stringAt(j, ["status"]);
  const stopped = stringAt(j, ["stoppedAt"]);
  const shownStatus =
    status !== undefined && stopped !== undefined
      ? `${status}: it has already finished, so cancelling does nothing`
      : status;
  return [
    { label: "Name", value: excerptHead(name) },
    ...presentFields([
      ["Status", shown(shownStatus)],
      ["Started", shown(stringAt(j, ["startedAt"]))],
      ["Stopped", shown(stopped)],
      ["Pipeline id", shown(stringAt(j, ["pipelineId"]))],
    ]),
  ];
}

/** `gitlab_pipeline_get` input for a retry or cancel. */
export function gitlabPipelineReadArgs(input: Input): Record<string, unknown> | undefined {
  const projectPath = nonEmptyString(input["projectPath"]);
  const pipelineId = positiveIntegerArg(input["pipelineId"]);
  return projectPath === undefined || pipelineId === undefined
    ? undefined
    : { projectPath, pipelineId };
}

/** The GitLab pipeline statuses in which a cancel still has something to cancel. */
const GITLAB_PIPELINE_ACTIVE = new Set([
  "created",
  "waiting_for_resource",
  "preparing",
  "pending",
  "running",
  "scheduled",
]);

function gitlabPipelineFields(j: unknown, status: string | undefined): BeforeStateField[] {
  return presentFields([
    ["Status", shown(status)],
    ["Ref", shown(stringAt(j, ["ref"]))],
    ["Commit", shown(stringAt(j, ["sha"]))],
    ["Source", shown(stringAt(j, ["source"]))],
    ["Created", shown(stringAt(j, ["created_at"]))],
    ["Finished", shown(stringAt(j, ["finished_at"]))],
    ["User", shown(stringAt(j, ["user", "username"]) ?? stringAt(j, ["user", "name"]))],
  ]);
}

/** GitLab `gitlab_pipeline_get` (before-state) for a retry. */
export function selectGitlabPipelineRetry(reply: unknown): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  return gitlabPipelineFields(j, requiredStringAt(j, ["status"]));
}

/** GitLab `gitlab_pipeline_get` (before-state) for a cancel; a pipeline that is not running says so. */
export function selectGitlabPipelineCancel(reply: unknown): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  const status = requiredStringAt(j, ["status"]);
  const note = GITLAB_PIPELINE_ACTIVE.has(status)
    ? status
    : `${status}: it is not running, so cancelling does nothing`;
  return gitlabPipelineFields(j, note);
}
