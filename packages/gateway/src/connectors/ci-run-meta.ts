/**
 * The `ci_run` metadata contract shared by every CI writer (GitHub Actions, CircleCI, GitLab,
 * Jenkins). Readers read ONLY the canonical keys this module writes; each provider's own keys stay
 * on the row beside them for display.
 *
 * Rules (index lane contract spec, §3.1):
 * - A field the provider cannot honestly supply is OMITTED, never guessed. Absent means unknown.
 * - Normalization is an exact-match lookup; an unlisted value maps to `unknown`, never to
 *   `success`. A guessed success is exactly how preflight came to pass red builds.
 * - `buildCiRunMetadata` strips every canonical key from the raw record before writing its own,
 *   so a raw key that shares a canonical name (GitHub Actions `conclusion`, CircleCI `branch`) can
 *   never leak its provider value under the canonical name.
 *
 * Mirrors `ticket-depth.ts` (Jira/Linear `status_category`).
 */

/** Bump when a mapper starts writing a key consumers may rely on. Drives `rebody` eligibility. */
export const CI_RUN_META_VERSION = 1;

export type CiRunService = "github_actions" | "circleci" | "gitlab" | "jenkins";

export type CiConclusion = "success" | "failure" | "cancelled" | "running" | "unknown";

export type CanonicalCiRunKey =
  | "conclusion"
  | "conclusion_raw"
  | "branch"
  | "repo"
  | "workflow_name"
  | "head_sha"
  | "meta_v";

export const CANONICAL_CI_RUN_KEYS: readonly CanonicalCiRunKey[] = [
  "conclusion",
  "conclusion_raw",
  "branch",
  "repo",
  "workflow_name",
  "head_sha",
  "meta_v",
];

const CANONICAL_SET: ReadonlySet<string> = new Set(CANONICAL_CI_RUN_KEYS);

/**
 * Which canonical keys each provider CAN emit. `conclusion` and `meta_v` are always written; the
 * rest only when the provider supplies them. Read by reader gap disclosures (PR A2) and the lane
 * census (PR A3). `lane-contract-drift.test.ts` drives each real mapper and fails when this table
 * and the code disagree.
 */
export const CI_RUN_EMITTED_KEYS: Readonly<Record<CiRunService, ReadonlySet<CanonicalCiRunKey>>> = {
  github_actions: new Set<CanonicalCiRunKey>([
    "conclusion",
    "conclusion_raw",
    "branch",
    "repo",
    "workflow_name",
    "head_sha",
    "meta_v",
  ]),
  circleci: new Set<CanonicalCiRunKey>([
    "conclusion",
    "conclusion_raw",
    "branch",
    "repo",
    "head_sha",
    "meta_v",
  ]),
  gitlab: new Set<CanonicalCiRunKey>([
    "conclusion",
    "conclusion_raw",
    "branch",
    "repo",
    "head_sha",
    "meta_v",
  ]),
  jenkins: new Set<CanonicalCiRunKey>(["conclusion", "conclusion_raw", "workflow_name", "meta_v"]),
};

/**
 * Providers whose `conclusion` can never be `success` from what the sync fetches. CircleCI's
 * pipeline `state` describes pipeline CREATION (`created`/`errored`/`setup-pending`/`setup`/
 * `pending`); pass/fail lives on workflows, which the sync does not fetch. `errored` (a config
 * error, so no workflow ran) is reported as `failure`; nothing is ever `success`. Readers that need
 * pass/fail disclose these as "cannot evaluate" (PR A2).
 */
export const CI_RUN_NO_SUCCESS_SIGNAL: ReadonlySet<CiRunService> = new Set<CiRunService>([
  "circleci",
]);

export type CiRunFields = {
  readonly conclusion: CiConclusion;
  readonly conclusionRaw?: string | undefined;
  readonly branch?: string | undefined;
  readonly repo?: string | undefined;
  readonly workflowName?: string | undefined;
  readonly headSha?: string | undefined;
};

function lookup(
  table: Readonly<Record<string, CiConclusion>>,
  raw: string | undefined,
): CiConclusion {
  if (raw === undefined || raw === "") {
    return "unknown";
  }
  // `Object.hasOwn`, not `table[raw] ?? …`: a vendor value of "constructor" would otherwise
  // resolve to `Object.prototype.constructor` — a function, not `unknown`.
  return Object.hasOwn(table, raw) ? (table[raw] as CiConclusion) : "unknown";
}

const GITHUB_ACTIONS_CONCLUSION: Readonly<Record<string, CiConclusion>> = {
  success: "success",
  failure: "failure",
  timed_out: "failure",
  startup_failure: "failure",
  cancelled: "cancelled",
};

/** Any `status` other than `completed` means the run has not concluded yet. */
export function normalizeGithubActionsConclusion(
  status: string | undefined,
  conclusion: string | undefined,
): CiConclusion {
  if (status !== undefined && status !== "" && status !== "completed") {
    return "running";
  }
  return lookup(GITHUB_ACTIONS_CONCLUSION, conclusion);
}

const CIRCLECI_PIPELINE_STATE: Readonly<Record<string, CiConclusion>> = {
  errored: "failure",
};

export function normalizeCircleciPipelineState(state: string | undefined): CiConclusion {
  return lookup(CIRCLECI_PIPELINE_STATE, state);
}

const GITLAB_PIPELINE_STATUS: Readonly<Record<string, CiConclusion>> = {
  success: "success",
  failed: "failure",
  canceled: "cancelled",
  canceling: "cancelled",
  created: "running",
  waiting_for_resource: "running",
  preparing: "running",
  pending: "running",
  running: "running",
  scheduled: "running",
  manual: "running",
};

export function normalizeGitlabPipelineStatus(status: string | undefined): CiConclusion {
  return lookup(GITLAB_PIPELINE_STATUS, status);
}

const JENKINS_RESULT: Readonly<Record<string, CiConclusion>> = {
  SUCCESS: "success",
  FAILURE: "failure",
  UNSTABLE: "failure",
  ABORTED: "cancelled",
};

export function normalizeJenkinsResult(
  result: string | undefined,
  building: boolean,
): CiConclusion {
  if (building) {
    return "running";
  }
  return lookup(JENKINS_RESULT, result);
}

/**
 * `unknown`, not `string | undefined`: this is the contract boundary, and a caller that passes a
 * raw vendor field (which can be `null` or a number) must still get omission, never `{ key: null }`.
 */
function setIfPresent(out: Record<string, unknown>, key: string, value: unknown): void {
  if (typeof value === "string" && value !== "") {
    out[key] = value;
  }
}

export function buildCiRunMetadata(
  raw: Readonly<Record<string, unknown>>,
  fields: CiRunFields,
): Record<string, unknown> {
  const out: Record<string, unknown> = Object.fromEntries(
    Object.entries(raw).filter(([k]) => !CANONICAL_SET.has(k)),
  );
  out["conclusion"] = fields.conclusion;
  setIfPresent(out, "conclusion_raw", fields.conclusionRaw);
  setIfPresent(out, "branch", fields.branch);
  setIfPresent(out, "repo", fields.repo);
  setIfPresent(out, "workflow_name", fields.workflowName);
  setIfPresent(out, "head_sha", fields.headSha);
  out["meta_v"] = CI_RUN_META_VERSION;
  return out;
}
