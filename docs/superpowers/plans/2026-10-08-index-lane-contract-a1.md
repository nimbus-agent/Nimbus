# Index Lane Contract — PR A1 (contract + writers) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every CI-run, pull-request and git-commit writer emits one canonical, versioned metadata shape (built by a shared builder), so the readers fixed in PR A2 have something real to read.

**Architecture:** Three small contract modules under `packages/gateway/src/connectors/` (`ci-run-meta.ts`, `pr-meta.ts`, `git-commit-meta.ts`), modelled on `ticket-depth.ts`. Each exports a version constant, exact-match normalizers, a pure builder that strips colliding raw keys and stamps `meta_v`, and a typed per-service emitted-keys table. Each writer's metadata assembly is extracted into an exported pure mapper (input: the provider's API object) that calls the builder — those mappers are what A2's fixtures and A1's drift test drive. Rebody eligibility becomes a type-scoped target list so the new versions are recoverable.

**Tech Stack:** Bun 1.3, TypeScript strict (no `any`), `bun:test`, `bun:sqlite`, Biome.

**Spec:** `docs/superpowers/specs/2026-10-08-index-lane-contract-design.md` (§2, §3 are this PR; §4 is A2, §5 is A3 — each gets its own plan after the previous PR lands, so it is written against real interfaces).

## Global Constraints

- Canonical keys are snake_case; raw provider keys stay on the row **except** where they share a canonical name (§3.1.1), in which case the builder drops the raw one and the provider value moves to `*_raw`.
- A field the provider cannot honestly supply is **omitted** — never `null`, never `""`, never guessed.
- Normalization is an exact-match lookup via `Object.hasOwn`; any unlisted value → `unknown`. Never default to `success` / `open` / `merged`.
- Canonical `*_at` / `*_ms` values are integer epoch-millisecond `number`s; absent/unparseable → omitted (never `NaN`, `0`, or a string).
- Identifiers verbatim (Jenkins `job.fullName` with folder slashes; no trim/case-fold).
- Every row written through a builder carries `meta_v` = that module's version constant (`1`).
- No `any`; external data as `unknown` + `asRecord` / `stringField` / `numberField` (`connectors/unknown-record.ts`).
- All SQL bound-parameter (I9); index writes only through `ctx.upsertItem` (I14 — unchanged here).
- Spawns keep `windowsHide: true` (D25); child env via `extensionProcessEnv` (I1).
- No reader code changes in A1 (readers are A2), with ONE exception: Task 12b fixes preflight's two latent CI defects, because A1 itself brings that lane to life (Ruling R7). Reader *results* that change because of §3.1.1 collisions are pinned by Task 12.
- Commit with `git commit -F <file>` (backticks in `-m` are eaten by the shell). Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Run commands from the worktree root `C:\gitrep\Nimbus\.claude\worktrees\index-lane-contract`. Verify `git rev-parse --abbrev-ref HEAD` is `dev/asaf/index-lane-contract` before every commit.

## Vendor facts this plan relies on (verified 2026-10-08)

- **CircleCI** `GET /project/{slug}/pipeline` items carry a pipeline `state` ∈ `created | errored | setup-pending | setup | pending`. That is not pass/fail (pass/fail is on workflows, not fetched). So CircleCI maps `errored → failure`, everything else → `unknown`, and `CI_RUN_NO_SUCCESS_SIGNAL` names it.
- **GitHub Actions** `workflow_run.status` ∈ `queued | in_progress | completed | waiting | requested | pending`; `conclusion` ∈ `success | failure | neutral | cancelled | skipped | timed_out | action_required | stale | startup_failure | null`.
- **GitLab** pipeline `status` ∈ `created | waiting_for_resource | preparing | pending | running | success | failed | canceling | canceled | skipped | manual | scheduled`. The pipeline **list** endpoint does not return `tag` (only `GET /pipelines/:id` does) — so the tag rule fires only when `tag === true` is present, and the residual is stated in the mapper's doc comment.
- **Jenkins** build `result` ∈ `SUCCESS | UNSTABLE | FAILURE | NOT_BUILT | ABORTED | null`; `building: true` while running.
- **GitLab events** are fetched `sort=asc`; MR events have `target_type: "MergeRequest"` and `action_name` ∈ `opened | closed | reopened | accepted | approved | updated | …`. `accepted` is the merge. An event's `created_at` is the time of that action.
- **Bitbucket** PR `state` ∈ `OPEN | MERGED | DECLINED | SUPERSEDED`; `created_on` exists; no merge timestamp exists.
- `upsertIndexedItem` **replaces** `metadata` wholesale on conflict (`index/item-store.ts`, `metadata = excluded.metadata`). `ctx.itemMetadata(itemId)` returns the stored JSON string or `null`.

## Review Focus

1. **A prototype-named vendor value** (`"constructor"`, `"__proto__"`, `"toString"` as a status) must normalize to `unknown`, not to a function — pinned in Task 1 and Task 2 (`Object.hasOwn` lookup).
2. **A GitHub events-feed PR payload with no `created_at`** (trimmed event payloads) must not erase an `opened_at_ms` written earlier by a full fetch — pinned in Task 7 (carry-forward).
3. **A GitLab MR row with no stored metadata receiving a non-transition event** (`approved`) must leave `state` absent (unknown), not `open` — pinned in Task 9.
4. **A commit whose author email is empty or resolves to no person** must write no `author_email` key and `authorId: null`, and must not throw — pinned in Task 10.
5. **A GitLab `issue` row** must never become rebody-eligible because of the `pr` contract, and overlapping targets must not double-count — pinned in Task 11.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/gateway/src/connectors/ci-run-meta.ts` (new) | `ci_run` contract: version, types, normalizers, builder, emitted-keys table |
| `packages/gateway/src/connectors/pr-meta.ts` (new) | `pr` contract: version, types, normalizers, GitLab event transitions, epoch helper, builder, emitted-keys table |
| `packages/gateway/src/connectors/git-commit-meta.ts` (new) | `git_commit` contract: version + builder |
| `connectors/github-actions-sync.ts` | export `githubActionsRunMetadata`, use it |
| `connectors/circleci-sync.ts` | export `circleciPipelineMetadata`, use it |
| `connectors/_lib/gitlab/pipelines.ts` | export `gitlabPipelineMetadata`, use it |
| `connectors/jenkins-sync.ts` | export `jenkinsBuildMetadata`, use it |
| `connectors/github-sync.ts` | `extractPrMetadataForIndex` goes through `buildPrMetadata`; carry-forward gains `opened_at_ms` |
| `connectors/bitbucket-sync.ts` | export `bitbucketPrMetadata`, use it |
| `connectors/_lib/gitlab/events.ts` + `connectors/gitlab-sync.ts` | export `gitlabMrMetadata` (transition + carry-forward + fetchOne fields) |
| `connectors/filesystem-v2-sync.ts` | `gitLogRecords` gains author email/name; commit rows resolve `authorId` |
| `ipc/index-rebody-rpc.ts` | `REBODY_REQUIRED_META_VERSION` map → `REBODY_META_TARGETS` type-scoped list |
| `demo/corpus/acme.ts` | `ci_run` / `pr` metadata built through the contract builders |
| `connectors/lane-contract-drift.test.ts` (new) | drives every mapper; asserts emitted keys == table |
| `connectors/lane-contract-collisions.test.ts` (new) | pins the reader results §3.1.1 changes |

---

### Task 1: `ci-run-meta.ts` — the CI-run contract

**Files:**
- Create: `packages/gateway/src/connectors/ci-run-meta.ts`
- Test: `packages/gateway/src/connectors/ci-run-meta.test.ts`

**Interfaces:**
- Produces:
  - `CI_RUN_META_VERSION: 1`
  - `type CiRunService = "github_actions" | "circleci" | "gitlab" | "jenkins"`
  - `type CiConclusion = "success" | "failure" | "cancelled" | "running" | "unknown"`
  - `type CanonicalCiRunKey = "conclusion" | "conclusion_raw" | "branch" | "repo" | "workflow_name" | "head_sha" | "meta_v"`
  - `CANONICAL_CI_RUN_KEYS: readonly CanonicalCiRunKey[]`
  - `CI_RUN_EMITTED_KEYS: Readonly<Record<CiRunService, ReadonlySet<CanonicalCiRunKey>>>`
  - `CI_RUN_NO_SUCCESS_SIGNAL: ReadonlySet<CiRunService>`
  - `type CiRunFields = { conclusion: CiConclusion; conclusionRaw?; branch?; repo?; workflowName?; headSha? }` (all optional fields `string | undefined`)
  - `normalizeGithubActionsConclusion(status: string | undefined, conclusion: string | undefined): CiConclusion`
  - `normalizeCircleciPipelineState(state: string | undefined): CiConclusion`
  - `normalizeGitlabPipelineStatus(status: string | undefined): CiConclusion`
  - `normalizeJenkinsResult(result: string | undefined, building: boolean): CiConclusion`
  - `buildCiRunMetadata(raw: Readonly<Record<string, unknown>>, fields: CiRunFields): Record<string, unknown>`

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/connectors/ci-run-meta.test.ts
import { describe, expect, test } from "bun:test";

import {
  buildCiRunMetadata,
  CI_RUN_EMITTED_KEYS,
  CI_RUN_META_VERSION,
  CI_RUN_NO_SUCCESS_SIGNAL,
  normalizeCircleciPipelineState,
  normalizeGithubActionsConclusion,
  normalizeGitlabPipelineStatus,
  normalizeJenkinsResult,
} from "./ci-run-meta.ts";

describe("normalizeGithubActionsConclusion", () => {
  test.each([
    ["completed", "success", "success"],
    ["completed", "failure", "failure"],
    ["completed", "timed_out", "failure"],
    ["completed", "startup_failure", "failure"],
    ["completed", "cancelled", "cancelled"],
    ["completed", "skipped", "unknown"],
    ["completed", "neutral", "unknown"],
    ["completed", "action_required", "unknown"],
    ["completed", "stale", "unknown"],
    ["completed", undefined, "unknown"],
    ["in_progress", undefined, "running"],
    ["queued", undefined, "running"],
    ["waiting", "failure", "running"],
    [undefined, "success", "success"],
    [undefined, undefined, "unknown"],
  ] as const)("status=%p conclusion=%p -> %p", (status, conclusion, want) => {
    expect(normalizeGithubActionsConclusion(status, conclusion)).toBe(want);
  });
});

describe("normalizeCircleciPipelineState", () => {
  test("a pipeline state is never a success signal", () => {
    expect(normalizeCircleciPipelineState("errored")).toBe("failure");
    for (const s of ["created", "setup-pending", "setup", "pending", undefined, ""]) {
      expect(normalizeCircleciPipelineState(s)).toBe("unknown");
    }
    expect(CI_RUN_NO_SUCCESS_SIGNAL.has("circleci")).toBe(true);
  });
});

describe("normalizeGitlabPipelineStatus", () => {
  test.each([
    ["success", "success"],
    ["failed", "failure"],
    ["canceled", "cancelled"],
    ["canceling", "cancelled"],
    ["created", "running"],
    ["waiting_for_resource", "running"],
    ["preparing", "running"],
    ["pending", "running"],
    ["running", "running"],
    ["scheduled", "running"],
    ["manual", "running"],
    ["skipped", "unknown"],
    ["brand_new_status", "unknown"],
  ] as const)("%p -> %p", (status, want) => {
    expect(normalizeGitlabPipelineStatus(status)).toBe(want);
  });
});

describe("normalizeJenkinsResult", () => {
  test("building wins over any result", () => {
    expect(normalizeJenkinsResult("FAILURE", true)).toBe("running");
  });
  test.each([
    ["SUCCESS", "success"],
    ["FAILURE", "failure"],
    ["UNSTABLE", "failure"],
    ["ABORTED", "cancelled"],
    ["NOT_BUILT", "unknown"],
    ["success", "unknown"], // case-sensitive: Jenkins only ever sends upper case
  ] as const)("%p -> %p", (result, want) => {
    expect(normalizeJenkinsResult(result, false)).toBe(want);
  });
});

describe("prototype-named vendor values", () => {
  test("never resolve to an inherited Object member", () => {
    for (const v of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(normalizeGithubActionsConclusion("completed", v)).toBe("unknown");
      expect(normalizeCircleciPipelineState(v)).toBe("unknown");
      expect(normalizeGitlabPipelineStatus(v)).toBe("unknown");
      expect(normalizeJenkinsResult(v, false)).toBe("unknown");
    }
  });
});

describe("buildCiRunMetadata", () => {
  test("drops colliding raw keys and writes canonical ones, stamping meta_v", () => {
    const out = buildCiRunMetadata(
      { conclusion: "timed_out", branch: "v1.0.0", runId: 7 },
      { conclusion: "failure", conclusionRaw: "timed_out", repo: "acme/app" },
    );
    expect(out).toEqual({
      runId: 7,
      conclusion: "failure",
      conclusion_raw: "timed_out",
      repo: "acme/app",
      meta_v: CI_RUN_META_VERSION,
    });
    expect("branch" in out).toBe(false);
  });

  test("omits empty and undefined optional fields rather than writing null or empty string", () => {
    const out = buildCiRunMetadata(
      {},
      { conclusion: "unknown", conclusionRaw: "", branch: undefined, headSha: "" },
    );
    expect(out).toEqual({ conclusion: "unknown", meta_v: CI_RUN_META_VERSION });
  });

  test("a raw vendor null smuggled past the types is omitted, not written as null", () => {
    const fields = { conclusion: "unknown", branch: null, repo: 42 } as unknown as Parameters<
      typeof buildCiRunMetadata
    >[1];
    expect(buildCiRunMetadata({}, fields)).toEqual({ conclusion: "unknown", meta_v: CI_RUN_META_VERSION });
  });

  test("keeps identifiers verbatim", () => {
    const out = buildCiRunMetadata(
      {},
      { conclusion: "success", workflowName: "folder/sub/Deploy Prod " },
    );
    expect(out["workflow_name"]).toBe("folder/sub/Deploy Prod ");
  });

  test("the emitted-keys table always includes conclusion and meta_v", () => {
    for (const keys of Object.values(CI_RUN_EMITTED_KEYS)) {
      expect(keys.has("conclusion")).toBe(true);
      expect(keys.has("meta_v")).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/connectors/ci-run-meta.test.ts`
Expected: FAIL — `Cannot find module './ci-run-meta.ts'`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/gateway/src/connectors/ci-run-meta.ts
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
export const CI_RUN_EMITTED_KEYS: Readonly<Record<CiRunService, ReadonlySet<CanonicalCiRunKey>>> =
  {
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

export function normalizeJenkinsResult(result: string | undefined, building: boolean): CiConclusion {
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/connectors/ci-run-meta.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Lint and commit**

```bash
bunx biome check packages/gateway/src/connectors/ci-run-meta.ts packages/gateway/src/connectors/ci-run-meta.test.ts
git rev-parse --abbrev-ref HEAD   # must print dev/asaf/index-lane-contract
git add packages/gateway/src/connectors/ci-run-meta.ts packages/gateway/src/connectors/ci-run-meta.test.ts
printf 'feat(index): add the ci_run metadata contract\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n' > "$TEMP/msg.txt"
git commit -F "$TEMP/msg.txt"
```

---

### Task 2: `pr-meta.ts` and `git-commit-meta.ts`

**Files:**
- Create: `packages/gateway/src/connectors/pr-meta.ts`
- Create: `packages/gateway/src/connectors/git-commit-meta.ts`
- Test: `packages/gateway/src/connectors/pr-meta.test.ts`
- Test: `packages/gateway/src/connectors/git-commit-meta.test.ts`

**Interfaces:**
- Produces (`pr-meta.ts`):
  - `PR_META_VERSION: 1`
  - `type PrService = "github" | "bitbucket" | "gitlab"`
  - `type PrState = "open" | "merged" | "closed" | "unknown"`
  - `type CanonicalPrKey = "state" | "state_raw" | "merged" | "opened_at_ms" | "merged_at" | "repo" | "meta_v"`
  - `CANONICAL_PR_KEYS: readonly CanonicalPrKey[]`
  - `PR_EMITTED_KEYS: Readonly<Record<PrService, ReadonlySet<CanonicalPrKey>>>`
  - `type PrFields = { state?: PrState; stateRaw?: string; openedAtMs?: number; mergedAtMs?: number; repo?: string }` (each also `| undefined`)
  - `normalizeGithubPrState(state: string | undefined, merged: boolean): PrState | undefined`
  - `normalizeBitbucketPrState(state: string | undefined): PrState | undefined`
  - `normalizeGitlabMrState(state: string | undefined): PrState | undefined`
  - `gitlabEventTransition(actionName: string | undefined): PrState | null`
  - `canonicalEpochMs(value: unknown): number | undefined`
  - `buildPrMetadata(raw: Readonly<Record<string, unknown>>, fields: PrFields): Record<string, unknown>`
- Produces (`git-commit-meta.ts`):
  - `GIT_COMMIT_META_VERSION: 1`
  - `buildGitCommitMetadata(raw: Readonly<Record<string, unknown>>, fields: { authorEmail?: string | undefined }): Record<string, unknown>`

Normalizers return `undefined` (not `"unknown"`) when the raw value is **absent**, so a writer omits `state` and carry-forward can fill it; an unrecognized **present** value is `"unknown"`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/gateway/src/connectors/pr-meta.test.ts
import { describe, expect, test } from "bun:test";

import {
  buildPrMetadata,
  canonicalEpochMs,
  gitlabEventTransition,
  normalizeBitbucketPrState,
  normalizeGithubPrState,
  normalizeGitlabMrState,
  PR_EMITTED_KEYS,
  PR_META_VERSION,
} from "./pr-meta.ts";

describe("normalizers", () => {
  test("github: merged wins over state", () => {
    expect(normalizeGithubPrState("closed", true)).toBe("merged");
    expect(normalizeGithubPrState("closed", false)).toBe("closed");
    expect(normalizeGithubPrState("open", false)).toBe("open");
    expect(normalizeGithubPrState(undefined, false)).toBeUndefined();
    expect(normalizeGithubPrState("draft-ish", false)).toBe("unknown");
  });
  test("bitbucket: upper-case vocabulary", () => {
    expect(normalizeBitbucketPrState("OPEN")).toBe("open");
    expect(normalizeBitbucketPrState("MERGED")).toBe("merged");
    expect(normalizeBitbucketPrState("DECLINED")).toBe("closed");
    expect(normalizeBitbucketPrState("SUPERSEDED")).toBe("closed");
    expect(normalizeBitbucketPrState("merged")).toBe("unknown");
    expect(normalizeBitbucketPrState(undefined)).toBeUndefined();
  });
  test("gitlab MR state (fetchOne)", () => {
    expect(normalizeGitlabMrState("opened")).toBe("open");
    expect(normalizeGitlabMrState("merged")).toBe("merged");
    expect(normalizeGitlabMrState("closed")).toBe("closed");
    expect(normalizeGitlabMrState("locked")).toBe("closed");
    expect(normalizeGitlabMrState(undefined)).toBeUndefined();
  });
  test("gitlab event transitions: only state-changing actions", () => {
    expect(gitlabEventTransition("accepted")).toBe("merged");
    expect(gitlabEventTransition("merged")).toBe("merged");
    expect(gitlabEventTransition("opened")).toBe("open");
    expect(gitlabEventTransition("reopened")).toBe("open");
    expect(gitlabEventTransition("closed")).toBe("closed");
    expect(gitlabEventTransition("approved")).toBeNull();
    expect(gitlabEventTransition("commented on")).toBeNull();
    expect(gitlabEventTransition(undefined)).toBeNull();
  });
  test("prototype-named values never resolve to Object members", () => {
    for (const v of ["constructor", "__proto__", "toString"]) {
      expect(normalizeBitbucketPrState(v)).toBe("unknown");
      expect(normalizeGitlabMrState(v)).toBe("unknown");
      expect(normalizeGithubPrState(v, false)).toBe("unknown");
      expect(gitlabEventTransition(v)).toBeNull();
    }
  });
});

describe("canonicalEpochMs", () => {
  test("accepts positive integers and parseable ISO strings only", () => {
    expect(canonicalEpochMs(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(canonicalEpochMs("2026-10-08T12:00:00Z")).toBe(Date.parse("2026-10-08T12:00:00Z"));
    expect(canonicalEpochMs(0)).toBeUndefined();
    expect(canonicalEpochMs(-5)).toBeUndefined();
    expect(canonicalEpochMs(1.5)).toBeUndefined();
    expect(canonicalEpochMs(Number.NaN)).toBeUndefined();
    expect(canonicalEpochMs("not a date")).toBeUndefined();
    expect(canonicalEpochMs("")).toBeUndefined();
    expect(canonicalEpochMs(undefined)).toBeUndefined();
    expect(canonicalEpochMs(null)).toBeUndefined();
  });
});

describe("buildPrMetadata", () => {
  test("derives merged from state, strips colliding raw keys, stamps meta_v", () => {
    const out = buildPrMetadata(
      { state: "MERGED", merged: false, merged_at: "bogus", id: 4 },
      { state: "merged", stateRaw: "MERGED", openedAtMs: 1_000, repo: "acme/app" },
    );
    expect(out).toEqual({
      id: 4,
      state: "merged",
      state_raw: "MERGED",
      merged: true,
      opened_at_ms: 1_000,
      repo: "acme/app",
      meta_v: PR_META_VERSION,
    });
  });
  test("absent state writes neither state nor merged", () => {
    const out = buildPrMetadata({}, { repo: "acme/app" });
    expect("state" in out).toBe(false);
    expect("merged" in out).toBe(false);
  });
  test("merged_at is dropped when the state is not merged", () => {
    const out = buildPrMetadata({}, { state: "open", mergedAtMs: 5_000 });
    expect("merged_at" in out).toBe(false);
  });
  test("merged_at is kept when merged, and when state is unknown", () => {
    expect(buildPrMetadata({}, { state: "merged", mergedAtMs: 5_000 })["merged_at"]).toBe(5_000);
    expect(buildPrMetadata({}, { mergedAtMs: 5_000 })["merged_at"]).toBe(5_000);
  });
  test("bitbucket's table omits merged_at", () => {
    expect(PR_EMITTED_KEYS.bitbucket.has("merged_at")).toBe(false);
    expect(PR_EMITTED_KEYS.github.has("merged_at")).toBe(true);
  });
});
```

```ts
// packages/gateway/src/connectors/git-commit-meta.test.ts
import { expect, test } from "bun:test";

import { buildGitCommitMetadata, GIT_COMMIT_META_VERSION } from "./git-commit-meta.ts";

test("writes author_email verbatim and stamps meta_v", () => {
  expect(buildGitCommitMetadata({ sha: "a" }, { authorEmail: "Ada@Example.com" })).toEqual({
    sha: "a",
    author_email: "Ada@Example.com",
    meta_v: GIT_COMMIT_META_VERSION,
  });
});

test("an empty or missing email is omitted, never written as empty", () => {
  expect(buildGitCommitMetadata({}, { authorEmail: "" })).toEqual({ meta_v: 1 });
  expect(buildGitCommitMetadata({}, {})).toEqual({ meta_v: 1 });
});

test("a raw author_email cannot survive the builder", () => {
  expect(buildGitCommitMetadata({ author_email: "x@y" }, {})).toEqual({ meta_v: 1 });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/gateway/src/connectors/pr-meta.test.ts packages/gateway/src/connectors/git-commit-meta.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the implementations**

```ts
// packages/gateway/src/connectors/pr-meta.ts
/**
 * The `pr` metadata contract shared by every forge writer (GitHub, Bitbucket, GitLab). Same rules
 * as `ci-run-meta.ts`: canonical keys only for readers, omission over guessing, exact-match
 * normalization, colliding raw keys stripped by the builder.
 *
 * Normalizers return `undefined` when the provider sent NO value (so the writer omits `state` and
 * a carry-forward can fill it from the stored row) and `"unknown"` when it sent one this module
 * does not recognise.
 */

/** Bump when a mapper starts writing a key consumers may rely on. Drives `rebody` eligibility. */
export const PR_META_VERSION = 1;

export type PrService = "github" | "bitbucket" | "gitlab";

export type PrState = "open" | "merged" | "closed" | "unknown";

export type CanonicalPrKey =
  | "state"
  | "state_raw"
  | "merged"
  | "opened_at_ms"
  | "merged_at"
  | "repo"
  | "meta_v";

export const CANONICAL_PR_KEYS: readonly CanonicalPrKey[] = [
  "state",
  "state_raw",
  "merged",
  "opened_at_ms",
  "merged_at",
  "repo",
  "meta_v",
];

const CANONICAL_SET: ReadonlySet<string> = new Set(CANONICAL_PR_KEYS);

/**
 * Which canonical keys each forge CAN emit (see `ci-run-meta.ts`'s `CI_RUN_EMITTED_KEYS`).
 * Bitbucket's PR resource has no merge timestamp, and `updated_on` is not one. GitLab emits both
 * timestamps from its `opened`/`accepted` transition events and from `fetchOne`; an MR whose
 * opening predates the sync window simply lacks the key on its row (per-row absence = unknown).
 */
export const PR_EMITTED_KEYS: Readonly<Record<PrService, ReadonlySet<CanonicalPrKey>>> = {
  github: new Set<CanonicalPrKey>(CANONICAL_PR_KEYS),
  bitbucket: new Set<CanonicalPrKey>([
    "state",
    "state_raw",
    "merged",
    "opened_at_ms",
    "repo",
    "meta_v",
  ]),
  gitlab: new Set<CanonicalPrKey>(CANONICAL_PR_KEYS),
};

export type PrFields = {
  readonly state?: PrState | undefined;
  readonly stateRaw?: string | undefined;
  readonly openedAtMs?: number | undefined;
  readonly mergedAtMs?: number | undefined;
  readonly repo?: string | undefined;
};

function lookup(
  table: Readonly<Record<string, PrState>>,
  raw: string | undefined,
): PrState | undefined {
  if (raw === undefined || raw === "") {
    return undefined;
  }
  return Object.hasOwn(table, raw) ? (table[raw] as PrState) : "unknown";
}

const GITHUB_STATE: Readonly<Record<string, PrState>> = { open: "open", closed: "closed" };

/** GitHub reports a merged PR as `state: "closed"` with `merged: true`. */
export function normalizeGithubPrState(
  state: string | undefined,
  merged: boolean,
): PrState | undefined {
  return merged ? "merged" : lookup(GITHUB_STATE, state);
}

const BITBUCKET_STATE: Readonly<Record<string, PrState>> = {
  OPEN: "open",
  MERGED: "merged",
  DECLINED: "closed",
  SUPERSEDED: "closed",
};

export function normalizeBitbucketPrState(state: string | undefined): PrState | undefined {
  return lookup(BITBUCKET_STATE, state);
}

const GITLAB_MR_STATE: Readonly<Record<string, PrState>> = {
  opened: "open",
  merged: "merged",
  closed: "closed",
  locked: "closed",
};

/** The MR resource's own `state` (the `fetchOne` path). */
export function normalizeGitlabMrState(state: string | undefined): PrState | undefined {
  return lookup(GITLAB_MR_STATE, state);
}

const GITLAB_EVENT_TRANSITION: Readonly<Record<string, PrState>> = {
  accepted: "merged",
  merged: "merged",
  opened: "open",
  reopened: "open",
  closed: "closed",
};

/**
 * The state an events-API `action_name` moves an MR to, or `null` when the action does not change
 * state (`approved`, `updated`, comments...). A `null` means "carry the stored state forward".
 */
export function gitlabEventTransition(actionName: string | undefined): PrState | null {
  if (actionName === undefined || !Object.hasOwn(GITLAB_EVENT_TRANSITION, actionName)) {
    return null;
  }
  return GITLAB_EVENT_TRANSITION[actionName] as PrState;
}

/**
 * Integer epoch milliseconds from a number or an ISO-8601 string, or `undefined`. Never `NaN`,
 * never `0`, never a fraction: a consumer must be able to tell "no timestamp" from a real one.
 */
export function canonicalEpochMs(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isInteger(value) && value > 0 ? value : undefined;
  }
  if (typeof value === "string" && value !== "") {
    const ms = Date.parse(value);
    return Number.isInteger(ms) && ms > 0 ? ms : undefined;
  }
  return undefined;
}

export function buildPrMetadata(
  raw: Readonly<Record<string, unknown>>,
  fields: PrFields,
): Record<string, unknown> {
  const out: Record<string, unknown> = Object.fromEntries(
    Object.entries(raw).filter(([k]) => !CANONICAL_SET.has(k)),
  );
  if (fields.state !== undefined) {
    out["state"] = fields.state;
    out["merged"] = fields.state === "merged";
  }
  // `typeof` guards, not `!== undefined`: a raw vendor `null` must be omitted, not written.
  if (typeof fields.stateRaw === "string" && fields.stateRaw !== "") {
    out["state_raw"] = fields.stateRaw;
  }
  const opened = canonicalEpochMs(fields.openedAtMs);
  if (opened !== undefined) {
    out["opened_at_ms"] = opened;
  }
  const mergedAt = canonicalEpochMs(fields.mergedAtMs);
  // A merge time on a PR known NOT to be merged (reopened after close, say) would be a lie.
  if (mergedAt !== undefined && (fields.state === undefined || fields.state === "merged")) {
    out["merged_at"] = mergedAt;
  }
  if (typeof fields.repo === "string" && fields.repo !== "") {
    out["repo"] = fields.repo;
  }
  out["meta_v"] = PR_META_VERSION;
  return out;
}
```

```ts
// packages/gateway/src/connectors/git-commit-meta.ts
/**
 * The `git_commit` metadata contract (filesystem connector). Adds the author email that lets
 * `expert`'s commit-authorship lane attribute a commit (PR A2). Same omission rule as the other
 * contract modules: an empty email is omitted, never written as `""`.
 */

/** Bump when the mapper starts writing a key consumers may rely on. Drives `rebody` eligibility. */
export const GIT_COMMIT_META_VERSION = 1;

export function buildGitCommitMetadata(
  raw: Readonly<Record<string, unknown>>,
  fields: { readonly authorEmail?: string | undefined },
): Record<string, unknown> {
  const out: Record<string, unknown> = Object.fromEntries(
    Object.entries(raw).filter(([k]) => k !== "author_email" && k !== "meta_v"),
  );
  if (fields.authorEmail !== undefined && fields.authorEmail !== "") {
    out["author_email"] = fields.authorEmail;
  }
  out["meta_v"] = GIT_COMMIT_META_VERSION;
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gateway/src/connectors/pr-meta.test.ts packages/gateway/src/connectors/git-commit-meta.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

```bash
bunx biome check packages/gateway/src/connectors/pr-meta.ts packages/gateway/src/connectors/pr-meta.test.ts packages/gateway/src/connectors/git-commit-meta.ts packages/gateway/src/connectors/git-commit-meta.test.ts
git rev-parse --abbrev-ref HEAD
git add packages/gateway/src/connectors/pr-meta.ts packages/gateway/src/connectors/pr-meta.test.ts packages/gateway/src/connectors/git-commit-meta.ts packages/gateway/src/connectors/git-commit-meta.test.ts
printf 'feat(index): add the pr and git_commit metadata contracts\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n' > "$TEMP/msg.txt"
git commit -F "$TEMP/msg.txt"
```

---

### Task 3: GitHub Actions writer

**Files:**
- Modify: `packages/gateway/src/connectors/github-actions-sync.ts` (`tryUpsertGithubActionsRun`, lines ~85–147)
- Test: `packages/gateway/test/unit/connectors/github-actions-sync.test.ts` (append)

**Interfaces:**
- Consumes: `buildCiRunMetadata`, `normalizeGithubActionsConclusion` (Task 1).
- Produces: `export function githubActionsRunMetadata(repoFull: string, run: Record<string, unknown>, now: number): Record<string, unknown>` — the full row metadata for one `workflow_run` object.

The raw keys stay (`workflowName`, `runId`, `event`, `headSha`, `headBranch`, `durationMs`, `status`); raw `conclusion` collides and moves to `conclusion_raw`. **New:** `repo` (the repo full name, which today is only in `externalId`).

- [ ] **Step 1: Write the failing test** (append to `test/unit/connectors/github-actions-sync.test.ts`; add `githubActionsRunMetadata` to the existing import from `../../../src/connectors/github-actions-sync.ts`, and `CI_RUN_EMITTED_KEYS` from `../../../src/connectors/ci-run-meta.ts`)

```ts
describe("githubActionsRunMetadata (ci_run contract)", () => {
  const NOW = Date.parse("2026-10-08T12:00:00Z");
  const run = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 99,
    name: "Deploy production",
    status: "completed",
    conclusion: "timed_out",
    event: "push",
    head_branch: "main",
    head_sha: "abc123",
    run_started_at: "2026-10-08T11:00:00Z",
    updated_at: "2026-10-08T11:10:00Z",
    ...o,
  });

  test("writes canonical keys from the real API shape, including the new repo", () => {
    const m = githubActionsRunMetadata("acme/repo-a", run(), NOW);
    expect(m["conclusion"]).toBe("failure");
    expect(m["conclusion_raw"]).toBe("timed_out");
    expect(m["branch"]).toBe("main");
    expect(m["repo"]).toBe("acme/repo-a");
    expect(m["workflow_name"]).toBe("Deploy production");
    expect(m["head_sha"]).toBe("abc123");
    expect(m["meta_v"]).toBe(1);
    // raw keys survive for display
    expect(m["headBranch"]).toBe("main");
    expect(m["durationMs"]).toBe(10 * 60 * 1000);
  });

  test("an in-progress run is running with no conclusion_raw", () => {
    const m = githubActionsRunMetadata(
      "acme/repo-a",
      run({ status: "in_progress", conclusion: null }),
      NOW,
    );
    expect(m["conclusion"]).toBe("running");
    expect(m["conclusion_raw"]).toBe("in_progress");
  });

  test("emits exactly the keys the contract table declares", () => {
    const m = githubActionsRunMetadata("acme/repo-a", run({ conclusion: "success" }), NOW);
    const canonical = Object.keys(m).filter((k) => CI_RUN_EMITTED_KEYS.github_actions.has(k as never));
    expect(new Set(canonical)).toEqual(new Set(CI_RUN_EMITTED_KEYS.github_actions));
  });
});
```

`conclusion_raw` is the raw `conclusion` when present, else the raw `status` (spec §3.2 "raw `conclusion` ?? `status`").

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/test/unit/connectors/github-actions-sync.test.ts`
Expected: FAIL — `githubActionsRunMetadata` is not exported.

- [ ] **Step 3: Implement** — in `github-actions-sync.ts`, add the import and the exported mapper, and replace the inline `meta` literal in `tryUpsertGithubActionsRun` with a call to it.

```ts
import { buildCiRunMetadata, normalizeGithubActionsConclusion } from "./ci-run-meta.ts";

/**
 * The full `ci_run` metadata for one GitHub Actions `workflow_run`. Raw keys keep their historical
 * camelCase names for display; readers read only the canonical keys `buildCiRunMetadata` adds.
 * `repo` is new: before the contract the repo full name lived only in `externalId`, which is why
 * DORA's deploy lane could never match a GitHub Actions run.
 */
export function githubActionsRunMetadata(
  repoFull: string,
  run: Record<string, unknown>,
  now: number,
): Record<string, unknown> {
  const conclusion = stringField(run, "conclusion");
  const status = stringField(run, "status");
  const name = stringField(run, "name");
  const headBranch = stringField(run, "head_branch");
  const headSha = stringField(run, "head_sha");
  const runStarted = stringField(run, "run_started_at");
  const updatedAt = stringField(run, "updated_at");
  const tEnd = updatedAt === undefined ? now : Date.parse(updatedAt);
  const tStart = runStarted === undefined ? tEnd : Date.parse(runStarted);
  const durationMs =
    Number.isFinite(tEnd) && Number.isFinite(tStart) && tEnd >= tStart ? tEnd - tStart : null;
  const raw: Record<string, unknown> = {
    workflowName: name ?? null,
    runId: numberField(run, "id") ?? null,
    event: stringField(run, "event") ?? null,
    headSha: headSha ?? null,
    headBranch: headBranch ?? null,
    durationMs,
    status: status ?? null,
  };
  return buildCiRunMetadata(raw, {
    conclusion: normalizeGithubActionsConclusion(status, conclusion),
    conclusionRaw: conclusion ?? status,
    branch: headBranch,
    repo: repoFull,
    workflowName: name,
    headSha,
  });
}
```

In `tryUpsertGithubActionsRun`: delete the local `event`, `headBranch`, `headSha`, `runStarted`, `updatedAt`, `tEnd`, `tStart`, `durationMs` computations and the `const meta: Record<string, unknown> = { … }` literal; keep `conclusion`/`status`/`name`/`display` (still used by `buildGithubActionsRunTitle`), and pass `metadata: githubActionsRunMetadata(full, run, now)` to `ctx.upsertItem`. Run `bun run typecheck` to catch any now-unused local.

- [ ] **Step 4: Run tests**

Run: `bun test packages/gateway/test/unit/connectors/github-actions-sync.test.ts`
Expected: PASS. If an existing assertion reads raw `meta.conclusion` expecting a vendor value (`"timed_out"`, `null`), change it to `conclusion_raw` — that is the §3.1.1 collision, not a regression; note it in the commit body.

- [ ] **Step 5: Commit**

```bash
bunx biome check packages/gateway/src/connectors/github-actions-sync.ts packages/gateway/test/unit/connectors/github-actions-sync.test.ts
bun run typecheck
git rev-parse --abbrev-ref HEAD
git add packages/gateway/src/connectors/github-actions-sync.ts packages/gateway/test/unit/connectors/github-actions-sync.test.ts
printf 'feat(index): GitHub Actions runs write the ci_run contract (adds repo)\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n' > "$TEMP/msg.txt"
git commit -F "$TEMP/msg.txt"
```

---

### Task 4: CircleCI writer

**Files:**
- Modify: `packages/gateway/src/connectors/circleci-sync.ts` (`tryUpsertCircleciPipeline`, lines ~87–156)
- Test: `packages/gateway/src/connectors/circleci-sync.coverage.test.ts` (modify two assertions, append a describe)

**Interfaces:**
- Consumes: `buildCiRunMetadata`, `normalizeCircleciPipelineState` (Task 1).
- Produces: `export function circleciPipelineMetadata(githubRepoFull: string, projectSlug: string, row: Record<string, unknown>): Record<string, unknown>`

Raw keys stay (`projectSlug`, `pipelineNumber`, `pipelineId`, `state`, `revision`, `githubRepo`). Raw `branch` collides: it used to hold `vcs.branch ?? vcs.tag`; now canonical `branch` is `vcs.branch` only and a tag is **omitted**. The tag survives as a new raw key `tag` for display.

- [ ] **Step 1: Update existing assertions and write the failing tests**

In the `"a non-numeric counter is dropped…"` test, replace `expect(meta["branch"]).toBeNull();` with `expect("branch" in meta).toBe(false);` and keep `expect(meta["revision"]).toBeNull();` (raw key unchanged).

Append (add `circleciPipelineMetadata` to the import from `./circleci-sync.ts`, and `CI_RUN_EMITTED_KEYS` from `./ci-run-meta.ts`):

```ts
describe("circleciPipelineMetadata (ci_run contract)", () => {
  const row = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
    number: 12,
    id: "p12",
    state: "created",
    vcs: { branch: "main", revision: "def456" },
    ...o,
  });

  test("a created pipeline is NOT a success — CircleCI has no pass/fail here", () => {
    const m = circleciPipelineMetadata("acme/app", "gh/acme/app", row());
    expect(m["conclusion"]).toBe("unknown");
    expect(m["conclusion_raw"]).toBe("created");
    expect(m["branch"]).toBe("main");
    expect(m["repo"]).toBe("acme/app");
    expect(m["head_sha"]).toBe("def456");
    expect(m["meta_v"]).toBe(1);
  });

  test("an errored pipeline is a failure", () => {
    expect(circleciPipelineMetadata("acme/app", "gh/acme/app", row({ state: "errored" }))["conclusion"]).toBe(
      "failure",
    );
  });

  test("a tag pipeline has no branch; the tag is kept as raw display data", () => {
    const m = circleciPipelineMetadata("acme/app", "gh/acme/app", row({ vcs: { tag: "v1.0.0" } }));
    expect("branch" in m).toBe(false);
    expect(m["tag"]).toBe("v1.0.0");
  });

  test("emits exactly the keys the contract table declares", () => {
    const m = circleciPipelineMetadata("acme/app", "gh/acme/app", row());
    const canonical = Object.keys(m).filter((k) => CI_RUN_EMITTED_KEYS.circleci.has(k as never));
    expect(new Set(canonical)).toEqual(new Set(CI_RUN_EMITTED_KEYS.circleci));
  });
});
```

Also update the `"a repo whose owner is blank…"` test if it asserts `meta["branch"] === "v1.0.0"` for its tag pipeline: assert `meta["tag"]` instead.

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/gateway/src/connectors/circleci-sync.coverage.test.ts packages/gateway/test/unit/connectors/circleci-sync.test.ts`
Expected: FAIL — mapper not exported; `branch` assertion fails.

- [ ] **Step 3: Implement** in `circleci-sync.ts`:

```ts
import { buildCiRunMetadata, normalizeCircleciPipelineState } from "./ci-run-meta.ts";

/**
 * The full `ci_run` metadata for one CircleCI pipeline. The pipeline `state` is a CREATION state,
 * not pass/fail (see `CI_RUN_NO_SUCCESS_SIGNAL`), so `conclusion` is `failure` for `errored` and
 * `unknown` otherwise. A tag pipeline has no branch: `vcs.tag` is kept as raw `tag` for display and
 * canonical `branch` is omitted (before the contract the tag was written AS the branch).
 */
export function circleciPipelineMetadata(
  githubRepoFull: string,
  projectSlug: string,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const state = stringField(row, "state");
  const vcs = asRecord(row["vcs"]);
  const branch = vcs === undefined ? undefined : stringField(vcs, "branch");
  const tag = vcs === undefined ? undefined : stringField(vcs, "tag");
  const revision = vcs === undefined ? undefined : stringField(vcs, "revision");
  const raw: Record<string, unknown> = {
    projectSlug,
    pipelineNumber: numberField(row, "number") ?? null,
    pipelineId: stringField(row, "id") ?? null,
    state: state ?? null,
    revision: revision ?? null,
    githubRepo: githubRepoFull,
    ...(tag === undefined || tag === "" ? {} : { tag }),
  };
  return buildCiRunMetadata(raw, {
    conclusion: normalizeCircleciPipelineState(state),
    conclusionRaw: state,
    branch,
    repo: githubRepoFull,
    headSha: revision,
  });
}
```

In `tryUpsertCircleciPipeline`: remove the `vcs`/`branch`/`revision` block and the `meta` literal; keep `state` (used by the title); pass `metadata: circleciPipelineMetadata(full, slug, row)`.

- [ ] **Step 4: Run tests**

Run: `bun test packages/gateway/src/connectors/circleci-sync.coverage.test.ts packages/gateway/test/unit/connectors/circleci-sync.test.ts`
Expected: PASS. Any remaining assertion on raw `branch` holding a tag is the §3.1.1 collision — move it to `tag`.

- [ ] **Step 5: Commit**

```bash
bunx biome check packages/gateway/src/connectors/circleci-sync.ts packages/gateway/src/connectors/circleci-sync.coverage.test.ts
bun run typecheck
git rev-parse --abbrev-ref HEAD
git add packages/gateway/src/connectors/circleci-sync.ts packages/gateway/src/connectors/circleci-sync.coverage.test.ts packages/gateway/test/unit/connectors/circleci-sync.test.ts
printf 'feat(index): CircleCI pipelines write the ci_run contract (a tag is not a branch)\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n' > "$TEMP/msg.txt"
git commit -F "$TEMP/msg.txt"
```

---

### Task 5: GitLab pipeline writer

**Files:**
- Modify: `packages/gateway/src/connectors/_lib/gitlab/pipelines.ts` (`tryUpsertGitlabPipelineItem`, lines ~12–75)
- Test: `packages/gateway/src/connectors/_lib/gitlab/pipelines.test.ts` (append)

**Interfaces:**
- Consumes: `buildCiRunMetadata`, `normalizeGitlabPipelineStatus` (Task 1).
- Produces: `export function gitlabPipelineMetadata(projectPath: string, row: Record<string, unknown>): Record<string, unknown>`

Raw keys stay (`project`, `pipelineId`, `status`, `ref`, `duration`, `sha`); no collisions.

- [ ] **Step 1: Write the failing test** (add `gitlabPipelineMetadata` to the import from `./pipelines.ts`, and `CI_RUN_EMITTED_KEYS` from `../../ci-run-meta.ts`)

```ts
describe("gitlabPipelineMetadata (ci_run contract)", () => {
  const row = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 501,
    status: "failed",
    ref: "main",
    sha: "9f9f",
    duration: 120,
    ...o,
  });

  test("writes canonical keys from the list-endpoint shape", () => {
    const m = gitlabPipelineMetadata("acme/app", row());
    expect(m["conclusion"]).toBe("failure");
    expect(m["conclusion_raw"]).toBe("failed");
    expect(m["branch"]).toBe("main");
    expect(m["repo"]).toBe("acme/app");
    expect(m["head_sha"]).toBe("9f9f");
    expect(m["meta_v"]).toBe(1);
    expect(m["ref"]).toBe("main");
  });

  test("a pipeline the API marks as a tag pipeline has no branch", () => {
    expect("branch" in gitlabPipelineMetadata("acme/app", row({ ref: "v2.0.0", tag: true }))).toBe(
      false,
    );
  });

  test("emits exactly the keys the contract table declares", () => {
    const m = gitlabPipelineMetadata("acme/app", row());
    const canonical = Object.keys(m).filter((k) => CI_RUN_EMITTED_KEYS.gitlab.has(k as never));
    expect(new Set(canonical)).toEqual(new Set(CI_RUN_EMITTED_KEYS.gitlab));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/gateway/src/connectors/_lib/gitlab/pipelines.test.ts`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement** in `pipelines.ts`:

```ts
import { buildCiRunMetadata, normalizeGitlabPipelineStatus } from "../../ci-run-meta.ts";

/**
 * The full `ci_run` metadata for one GitLab pipeline. `ref` is a branch OR a tag name; the
 * pipeline LIST endpoint (what the periodic sync reads) does not say which — only
 * `GET /projects/:id/pipelines/:id` returns `tag`. So canonical `branch` is omitted only when
 * `tag === true` is present. Stated residual: a tag pipeline read from the list endpoint carries
 * its tag name as `branch`; a reader filtering on a real branch name (`main`) never matches it.
 */
export function gitlabPipelineMetadata(
  projectPath: string,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const status = stringField(row, "status");
  const ref = stringField(row, "ref");
  const sha = stringField(row, "sha");
  const raw: Record<string, unknown> = {
    project: projectPath,
    pipelineId: numberField(row, "id") ?? null,
    status: status ?? null,
    ref: ref ?? null,
    duration: numberField(row, "duration") ?? null,
    sha: sha ?? null,
  };
  return buildCiRunMetadata(raw, {
    conclusion: normalizeGitlabPipelineStatus(status),
    conclusionRaw: status,
    branch: row["tag"] === true ? undefined : ref,
    repo: projectPath,
    headSha: sha,
  });
}
```

In `tryUpsertGitlabPipelineItem`: remove the `duration`/`sha` locals and the `meta` literal (keep `status`/`ref` for the title); pass `metadata: gitlabPipelineMetadata(path, row)`.

- [ ] **Step 4: Run tests**

Run: `bun test packages/gateway/src/connectors/_lib/gitlab/pipelines.test.ts packages/gateway/src/connectors/gitlab-sync.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bunx biome check packages/gateway/src/connectors/_lib/gitlab/pipelines.ts packages/gateway/src/connectors/_lib/gitlab/pipelines.test.ts
bun run typecheck
git rev-parse --abbrev-ref HEAD
git add packages/gateway/src/connectors/_lib/gitlab/pipelines.ts packages/gateway/src/connectors/_lib/gitlab/pipelines.test.ts
printf 'feat(index): GitLab pipelines write the ci_run contract\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n' > "$TEMP/msg.txt"
git commit -F "$TEMP/msg.txt"
```

---

### Task 6: Jenkins writer

**Files:**
- Modify: `packages/gateway/src/connectors/jenkins-sync.ts` (`upsertJenkinsBuildRowIfNew`, lines ~123–187)
- Test: `packages/gateway/src/connectors/jenkins-sync.test.ts` (append)

**Interfaces:**
- Consumes: `buildCiRunMetadata`, `normalizeJenkinsResult` (Task 1).
- Produces: `export function jenkinsBuildMetadata(jobFullName: string, build: Record<string, unknown>): Record<string, unknown>`

Raw keys stay (`jobName`, `buildNumber`, `result`, `building`, `duration_ms`). Jenkins has no branch, repo or sha.

- [ ] **Step 1: Write the failing test** (import `jenkinsBuildMetadata` from `./jenkins-sync.ts`, `CI_RUN_EMITTED_KEYS` from `./ci-run-meta.ts`; add `describe` to the `bun:test` import)

```ts
describe("jenkinsBuildMetadata (ci_run contract)", () => {
  test("folder-qualified job name is kept verbatim as workflow_name", () => {
    const m = jenkinsBuildMetadata("platform/deploys/Deploy Prod", {
      number: 7,
      result: "UNSTABLE",
      building: false,
      duration: 900,
    });
    expect(m["workflow_name"]).toBe("platform/deploys/Deploy Prod");
    expect(m["conclusion"]).toBe("failure");
    expect(m["conclusion_raw"]).toBe("UNSTABLE");
    expect(m["jobName"]).toBe("platform/deploys/Deploy Prod");
    expect("branch" in m).toBe(false);
    expect("repo" in m).toBe(false);
  });

  test("a running build is running even with a stale result", () => {
    expect(jenkinsBuildMetadata("j", { number: 8, result: null, building: true })["conclusion"]).toBe(
      "running",
    );
  });

  test("emits exactly the keys the contract table declares", () => {
    const m = jenkinsBuildMetadata("j", { number: 9, result: "SUCCESS", building: false });
    const canonical = Object.keys(m).filter((k) => CI_RUN_EMITTED_KEYS.jenkins.has(k as never));
    expect(new Set(canonical)).toEqual(new Set(CI_RUN_EMITTED_KEYS.jenkins));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/gateway/src/connectors/jenkins-sync.test.ts`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement** in `jenkins-sync.ts`:

```ts
import { buildCiRunMetadata, normalizeJenkinsResult } from "./ci-run-meta.ts";

/**
 * The full `ci_run` metadata for one Jenkins build. `workflow_name` is the job's `fullName`
 * VERBATIM, folder slashes included, so DORA/preflight URN matching on `jobName` stays exact.
 * Jenkins supplies no branch, repo or sha; those canonical keys are omitted, and readers that need
 * them disclose Jenkins as "cannot evaluate" (PR A2).
 */
export function jenkinsBuildMetadata(
  jobFullName: string,
  build: Record<string, unknown>,
): Record<string, unknown> {
  const result = stringField(build, "result");
  const building = build["building"] === true;
  const raw: Record<string, unknown> = {
    jobName: jobFullName,
    buildNumber: numberField(build, "number") ?? null,
    result: result ?? null,
    building,
    duration_ms: numberField(build, "duration") ?? null,
  };
  return buildCiRunMetadata(raw, {
    conclusion: normalizeJenkinsResult(result, building),
    conclusionRaw: result,
    workflowName: jobFullName,
  });
}
```

In `upsertJenkinsBuildRowIfNew`: remove the `duration` local and the `meta` literal (keep `result`/`building` for `buildTitle`); pass `metadata: jenkinsBuildMetadata(job.fullName, b)`.

- [ ] **Step 4: Run tests**

Run: `bun test packages/gateway/src/connectors/jenkins-sync.test.ts packages/gateway/src/connectors/jenkins-sync.coverage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bunx biome check packages/gateway/src/connectors/jenkins-sync.ts packages/gateway/src/connectors/jenkins-sync.test.ts
bun run typecheck
git rev-parse --abbrev-ref HEAD
git add packages/gateway/src/connectors/jenkins-sync.ts packages/gateway/src/connectors/jenkins-sync.test.ts
printf 'feat(index): Jenkins builds write the ci_run contract\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n' > "$TEMP/msg.txt"
git commit -F "$TEMP/msg.txt"
```

---

### Task 7: GitHub PR writer

**Files:**
- Modify: `packages/gateway/src/connectors/github-sync.ts` (`applyMergeFields` ~86–98, `extractPrMetadataForIndex` ~100–136, `PR_STAT_KEYS` + `mergeForwardPrStats` ~215–285)
- Test: `packages/gateway/src/connectors/github-sync.test.ts` (append)

**Interfaces:**
- Consumes: `buildPrMetadata`, `normalizeGithubPrState`, `canonicalEpochMs` (Task 2).
- Produces: `extractPrMetadataForIndex(repoFull, pr, nowMs?)` — same exported signature, now contract-shaped (adds `opened_at_ms`, `state_raw`, `meta_v`; `state` canonical).

Collision: raw `state` (`open`/`closed`) becomes canonical (`open`/`merged`/`closed`), raw value in `state_raw`. `merged` and `merged_at` keep their names and meaning (now produced by the builder). The carry-forward that already exists for size stats also carries `opened_at_ms` (events-feed payloads can omit `created_at`).

- [ ] **Step 1: Write the failing tests** (append; `PR_EMITTED_KEYS` from `./pr-meta.ts`)

```ts
describe("extractPrMetadataForIndex (pr contract)", () => {
  test("a merged PR reads state=merged, keeps the raw state and gains opened_at_ms", () => {
    const m = extractPrMetadataForIndex(
      "acme/app",
      prPayload({
        state: "closed",
        merged: true,
        created_at: "2026-10-01T09:00:00Z",
        merged_at: "2026-10-02T09:00:00Z",
        merge_commit_sha: "m1",
      }),
    );
    expect(m["state"]).toBe("merged");
    expect(m["state_raw"]).toBe("closed");
    expect(m["merged"]).toBe(true);
    expect(m["opened_at_ms"]).toBe(Date.parse("2026-10-01T09:00:00Z"));
    expect(m["merged_at"]).toBe(Date.parse("2026-10-02T09:00:00Z"));
    expect(m["merge_commit_sha"]).toBe("m1");
    expect(m["repo"]).toBe("acme/app");
    expect(m["meta_v"]).toBe(1);
  });

  test("an unparseable created_at is omitted, never NaN", () => {
    const m = extractPrMetadataForIndex("acme/app", prPayload({ created_at: "garbage" }));
    expect("opened_at_ms" in m).toBe(false);
  });

  test("emits exactly the keys the contract table declares (merged PR)", () => {
    const m = extractPrMetadataForIndex(
      "acme/app",
      prPayload({
        state: "closed",
        merged: true,
        created_at: "2026-10-01T09:00:00Z",
        merged_at: "2026-10-02T09:00:00Z",
      }),
    );
    const canonical = Object.keys(m).filter((k) => PR_EMITTED_KEYS.github.has(k as never));
    expect(new Set(canonical)).toEqual(new Set(PR_EMITTED_KEYS.github));
  });
});

test("upsertPr carries opened_at_ms forward when an events payload omits created_at", () => {
  const db = createMemoryIndexDb();
  const ctx = ctxWithPat(db, "pat") as unknown as Parameters<typeof upsertPr>[0];
  upsertPr(ctx, "acme/app", prPayload({ created_at: "2026-10-01T09:00:00Z" }), Date.now());
  // An events-feed payload with no `created_at` (`stringField` reads `undefined` as absent).
  upsertPr(ctx, "acme/app", prPayload({ created_at: undefined }), Date.now());
  const row = db.query("SELECT metadata FROM item WHERE service = 'github' AND type = 'pr'").get() as {
    metadata: string;
  };
  expect((JSON.parse(row.metadata) as Record<string, unknown>)["opened_at_ms"]).toBe(
    Date.parse("2026-10-01T09:00:00Z"),
  );
  db.close();
});
```

Before writing the second test, read how the existing tests in this file call `upsertPr` (search `upsertPr(`) and copy that exact context construction instead of the cast above if one exists. Overriding with `created_at: undefined` (rather than `delete`) keeps the test clear of Biome's `noDelete`.

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/gateway/src/connectors/github-sync.test.ts`
Expected: FAIL — `state` is `"closed"`, no `opened_at_ms`/`meta_v`.

- [ ] **Step 3: Implement** in `github-sync.ts`:

```ts
import { buildPrMetadata, canonicalEpochMs, normalizeGithubPrState } from "./pr-meta.ts";
```

Replace `applyMergeFields` and `extractPrMetadataForIndex` with:

```ts
/**
 * The merged-only raw field: `merge_commit_sha` exists solely on a merged PR. `merged_at` is a
 * canonical contract key now, produced by `buildPrMetadata`.
 */
function applyMergeCommitSha(out: Record<string, unknown>, pr: Record<string, unknown>): void {
  const sha = stringField(pr, "merge_commit_sha");
  if (sha !== undefined && sha.length > 0) {
    out["merge_commit_sha"] = sha;
  }
}

export function extractPrMetadataForIndex(
  repoFull: string,
  pr: Record<string, unknown>,
  nowMs: number = Date.now(),
): Record<string, unknown> {
  const merged = pr["merged"] === true;
  const rawState = stringField(pr, "state");
  const user = asRecord(pr["user"]);
  const login = user === undefined ? undefined : stringField(user, "login");
  const out: Record<string, unknown> = {
    number: numberField(pr, "number"),
    draft: pr["draft"] === true,
    user: login,
    labels: extractLabelNames(pr["labels"]),
  };
  const mergeable = pr["mergeable"];
  if (typeof mergeable === "boolean") {
    out["mergeable"] = mergeable;
  }
  const mergeableState = stringField(pr, "mergeable_state");
  if (mergeableState !== undefined && mergeableState.length > 0) {
    out["mergeable_state"] = mergeableState;
    out["mergeable_state_fetched_at_ms"] = nowMs;
  }
  for (const key of ["additions", "deletions", "changed_files", "commits"] as const) {
    const v = numberField(pr, key);
    if (v !== undefined) {
      out[key] = v;
    }
  }
  if (merged) {
    applyMergeCommitSha(out, pr);
  }
  return buildPrMetadata(out, {
    state: normalizeGithubPrState(rawState, merged),
    stateRaw: rawState,
    openedAtMs: canonicalEpochMs(stringField(pr, "created_at")),
    mergedAtMs: merged ? canonicalEpochMs(stringField(pr, "merged_at")) : undefined,
    repo: repoFull,
  });
}
```

Then extend the carry-forward: find `PR_STAT_KEYS` (used by `mergeForwardPrStats`) and add a sibling constant, then use the union in the `missing` filter:

```ts
/** Contract keys an events-feed payload can lack; carried from the stored row like the stats. */
const PR_CARRIED_CONTRACT_KEYS = ["opened_at_ms"] as const;
```

```ts
  const missing = [...PR_STAT_KEYS, ...PR_CARRIED_CONTRACT_KEYS].filter((k) => meta[k] === undefined);
```

Update the function's doc comment first line to say it merges forward size stats **and `opened_at_ms`**.

- [ ] **Step 4: Run tests**

Run: `bun test packages/gateway/src/connectors/github-sync.test.ts packages/gateway/src/connectors/github-sync.coverage.test.ts packages/gateway/src/connectors/github-sync-enrich.test.ts`
Expected: PASS. An existing assertion `state === "closed"` on a merged PR is the §3.1.1 collision — change it to `state === "merged"` and `state_raw === "closed"`.

- [ ] **Step 5: Commit**

```bash
bunx biome check packages/gateway/src/connectors/github-sync.ts packages/gateway/src/connectors/github-sync.test.ts
bun run typecheck
git rev-parse --abbrev-ref HEAD
git add packages/gateway/src/connectors/github-sync.ts packages/gateway/src/connectors/github-sync.test.ts packages/gateway/src/connectors/github-sync.coverage.test.ts packages/gateway/src/connectors/github-sync-enrich.test.ts
printf 'feat(index): GitHub PRs write the pr contract (canonical state, opened_at_ms)\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n' > "$TEMP/msg.txt"
git commit -F "$TEMP/msg.txt"
```

---

### Task 8: Bitbucket PR writer

**Files:**
- Modify: `packages/gateway/src/connectors/bitbucket-sync.ts` (the PR upsert function at ~110–172; `meta` literal at ~150–155)
- Test: `packages/gateway/src/connectors/bitbucket-sync.test.ts` (append)

**Interfaces:**
- Consumes: `buildPrMetadata`, `normalizeBitbucketPrState`, `canonicalEpochMs` (Task 2).
- Produces: `export function bitbucketPrMetadata(repoFull: string, pr: Record<string, unknown>, authorDisplayName: string | undefined): Record<string, unknown>`

Raw keys stay (`id`, `author`); `repo` is already canonical-named; raw `state` collides (`MERGED` → `merged`, raw in `state_raw`). New: `opened_at_ms` from `created_on`. No `merged_at` (none exists).

- [ ] **Step 1: Write the failing test** (`describe` added to the `bun:test` import; `PR_EMITTED_KEYS` from `./pr-meta.ts`)

```ts
describe("bitbucketPrMetadata (pr contract)", () => {
  test("MERGED normalizes to merged; created_on becomes opened_at_ms; no merged_at", () => {
    const m = bitbucketPrMetadata(
      "acme/app",
      prPayload({ state: "MERGED", created_on: "2026-09-30T08:00:00Z" }),
      "Dana",
    );
    expect(m["state"]).toBe("merged");
    expect(m["state_raw"]).toBe("MERGED");
    expect(m["merged"]).toBe(true);
    expect(m["opened_at_ms"]).toBe(Date.parse("2026-09-30T08:00:00Z"));
    expect("merged_at" in m).toBe(false);
    expect(m["repo"]).toBe("acme/app");
    expect(m["author"]).toBe("Dana");
  });

  test("emits exactly the keys the contract table declares", () => {
    const m = bitbucketPrMetadata(
      "acme/app",
      prPayload({ state: "MERGED", created_on: "2026-09-30T08:00:00Z" }),
      "Dana",
    );
    const canonical = Object.keys(m).filter((k) => PR_EMITTED_KEYS.bitbucket.has(k as never));
    expect(new Set(canonical)).toEqual(new Set(PR_EMITTED_KEYS.bitbucket));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/gateway/src/connectors/bitbucket-sync.test.ts`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement** in `bitbucket-sync.ts`:

```ts
import { buildPrMetadata, canonicalEpochMs, normalizeBitbucketPrState } from "./pr-meta.ts";

/**
 * The full `pr` metadata for one Bitbucket pull request. Bitbucket's PR resource carries no merge
 * timestamp (`updated_on` is the last change of any kind, not the merge), so `merged_at` is never
 * written and readers disclose Bitbucket where they need it (PR A2).
 */
export function bitbucketPrMetadata(
  repoFull: string,
  pr: Record<string, unknown>,
  authorDisplayName: string | undefined,
): Record<string, unknown> {
  const rawState = stringField(pr, "state");
  return buildPrMetadata(
    { id: numberField(pr, "id"), author: authorDisplayName },
    {
      state: normalizeBitbucketPrState(rawState),
      stateRaw: rawState,
      openedAtMs: canonicalEpochMs(stringField(pr, "created_on")),
      repo: repoFull,
    },
  );
}
```

In the upsert function: replace the `meta` literal with `const meta = bitbucketPrMetadata(repoFull, pr, displayName);` (keep the local `state` only if still used elsewhere in the function; otherwise remove it).

- [ ] **Step 4: Run tests**

Run: `bun test packages/gateway/src/connectors/bitbucket-sync.test.ts packages/gateway/src/connectors/bitbucket-sync.coverage.test.ts`
Expected: PASS. An assertion `state === "OPEN"` is the §3.1.1 collision → `state === "open"`, `state_raw === "OPEN"`.

- [ ] **Step 5: Commit**

```bash
bunx biome check packages/gateway/src/connectors/bitbucket-sync.ts packages/gateway/src/connectors/bitbucket-sync.test.ts
bun run typecheck
git rev-parse --abbrev-ref HEAD
git add packages/gateway/src/connectors/bitbucket-sync.ts packages/gateway/src/connectors/bitbucket-sync.test.ts packages/gateway/src/connectors/bitbucket-sync.coverage.test.ts
printf 'feat(index): Bitbucket PRs write the pr contract\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n' > "$TEMP/msg.txt"
git commit -F "$TEMP/msg.txt"
```

---

### Task 9: GitLab MR writer — transitions and carry-forward

**Files:**
- Modify: `packages/gateway/src/connectors/_lib/gitlab/events.ts` (`GitlabEventUpsertFields` ~24–50, `upsertGitlabEventItem` ~74–120)
- Modify: `packages/gateway/src/connectors/gitlab-sync.ts` (`fetchOne` MR path ~130–178)
- Test: `packages/gateway/src/connectors/_lib/gitlab/events.test.ts` (append)

**Interfaces:**
- Consumes: `buildPrMetadata`, `gitlabEventTransition`, `normalizeGitlabMrState`, `canonicalEpochMs`, `type PrFields` (Task 2); `itemPrimaryKey` (`index/item-key.ts`); `ctx.itemMetadata`.
- Produces:
  - `GitlabEventUpsertFields` gains `mr?: { readonly state?: string; readonly createdAt?: string; readonly mergedAt?: string }` — set only by `fetchOne`.
  - `export function gitlabMrMetadata(f: { pathWithNamespace: string; iid: number; actionName: string; eventCreatedAt: string; mr?: GitlabEventUpsertFields["mr"] }, stored: Record<string, unknown> | null): Record<string, unknown>` — pure; `stored` is the parsed existing row metadata.

Rules (spec §3.5, §3.3):
- `fetchOne` (`mr` present): state from `normalizeGitlabMrState(mr.state)`, `opened_at_ms` from `mr.createdAt`, `merged_at` from `mr.mergedAt`.
- Event with a transition: that state; `opened` sets `opened_at_ms` = event time; `accepted`/`merged` sets `merged_at` = event time; the other timestamp is carried from `stored`.
- Event without a transition (`approved`, `updated`…): every canonical key carried from `stored`; with no stored row, `state` stays absent.
- Issue rows are untouched (no `pr` contract).
- Raw keys stay (`iid`, `project`, `action`).

- [ ] **Step 1: Write the failing tests** (append; import `gitlabMrMetadata` from `./events.ts`, `PR_EMITTED_KEYS` from `../../pr-meta.ts`)

```ts
const T_OPEN = "2026-10-01T09:00:00Z";
const T_MERGE = "2026-10-03T09:00:00Z";
const base = { pathWithNamespace: "acme/app", iid: 5 };

test("gitlabMrMetadata — an opened event sets state=open and opened_at_ms from the event time", () => {
  const m = gitlabMrMetadata({ ...base, actionName: "opened", eventCreatedAt: T_OPEN }, null);
  expect(m["state"]).toBe("open");
  expect(m["state_raw"]).toBe("opened");
  expect(m["opened_at_ms"]).toBe(Date.parse(T_OPEN));
  expect("merged_at" in m).toBe(false);
  expect(m["repo"]).toBe("acme/app");
  expect(m["meta_v"]).toBe(1);
});

test("gitlabMrMetadata — accepted after opened: merged, both timestamps", () => {
  const opened = gitlabMrMetadata({ ...base, actionName: "opened", eventCreatedAt: T_OPEN }, null);
  const merged = gitlabMrMetadata({ ...base, actionName: "accepted", eventCreatedAt: T_MERGE }, opened);
  expect(merged["state"]).toBe("merged");
  expect(merged["merged"]).toBe(true);
  expect(merged["opened_at_ms"]).toBe(Date.parse(T_OPEN));
  expect(merged["merged_at"]).toBe(Date.parse(T_MERGE));
});

test("gitlabMrMetadata — a non-transition event after a merge keeps it merged", () => {
  const opened = gitlabMrMetadata({ ...base, actionName: "opened", eventCreatedAt: T_OPEN }, null);
  const merged = gitlabMrMetadata({ ...base, actionName: "accepted", eventCreatedAt: T_MERGE }, opened);
  const approved = gitlabMrMetadata(
    { ...base, actionName: "approved", eventCreatedAt: "2026-10-04T09:00:00Z" },
    merged,
  );
  expect(approved["state"]).toBe("merged");
  expect(approved["merged_at"]).toBe(Date.parse(T_MERGE));
  expect(approved["opened_at_ms"]).toBe(Date.parse(T_OPEN));
  expect(approved["action"]).toBe("approved"); // raw key still reports the latest event
});

test("gitlabMrMetadata — a non-transition event with no stored row leaves state unknown (absent)", () => {
  const m = gitlabMrMetadata({ ...base, actionName: "approved", eventCreatedAt: T_OPEN }, null);
  expect("state" in m).toBe(false);
  expect("merged" in m).toBe(false);
});

test("gitlabMrMetadata — reopened after closed drops nothing it should keep", () => {
  const closed = gitlabMrMetadata({ ...base, actionName: "closed", eventCreatedAt: T_MERGE }, null);
  const reopened = gitlabMrMetadata({ ...base, actionName: "reopened", eventCreatedAt: T_MERGE }, closed);
  expect(reopened["state"]).toBe("open");
  expect("merged_at" in reopened).toBe(false);
});

test("gitlabMrMetadata — fetchOne uses the MR resource's own fields", () => {
  const m = gitlabMrMetadata(
    {
      ...base,
      actionName: "merged",
      eventCreatedAt: T_MERGE,
      mr: { state: "merged", createdAt: T_OPEN, mergedAt: T_MERGE },
    },
    null,
  );
  expect(m["state"]).toBe("merged");
  expect(m["opened_at_ms"]).toBe(Date.parse(T_OPEN));
  expect(m["merged_at"]).toBe(Date.parse(T_MERGE));
  const canonical = Object.keys(m).filter((k) => PR_EMITTED_KEYS.gitlab.has(k as never));
  expect(new Set(canonical)).toEqual(new Set(PR_EMITTED_KEYS.gitlab));
});

test("events sync — accepted then approved leaves the stored MR merged", async () => {
  // Drive syncGitlabEventsPages through the existing describeWithFetchRestore/syncTestContext
  // pattern used earlier in this file: one page with two MergeRequest events for the same iid,
  // ascending, action_name "accepted" then "approved". Then read the row:
  //   SELECT metadata FROM item WHERE service='gitlab' AND type='pr'
  // and assert state === "merged" and merged_at === Date.parse(<accepted event created_at>).
});
```

For the last test, copy the fetch-stub setup of the nearest existing `syncGitlabEventsPages` test in this file verbatim (same helper names, same `apiBase`), changing only the events array to:

```ts
[
  {
    target_type: "MergeRequest",
    target_iid: 5,
    target_title: "Add cache",
    action_name: "accepted",
    created_at: T_MERGE,
    author_username: "dana",
    project: { path_with_namespace: "acme/app" },
  },
  {
    target_type: "MergeRequest",
    target_iid: 5,
    target_title: "Add cache",
    action_name: "approved",
    created_at: "2026-10-04T09:00:00Z",
    author_username: "sam",
    project: { path_with_namespace: "acme/app" },
  },
]
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/gateway/src/connectors/_lib/gitlab/events.test.ts`
Expected: FAIL — `gitlabMrMetadata` not exported; the sync test sees `state` absent and `action: "approved"` only.

- [ ] **Step 3: Implement** in `events.ts`:

```ts
import { itemPrimaryKey } from "../../../index/item-key.ts";
import {
  buildPrMetadata,
  canonicalEpochMs,
  gitlabEventTransition,
  normalizeGitlabMrState,
  type PrFields,
} from "../../pr-meta.ts";
```

Add to `GitlabEventUpsertFields`:

```ts
  /**
   * The MR resource's own fields, present only on the `fetchOne` path (`gitlab-sync.ts`), where
   * the full merge request was fetched. The periodic events path has only the event.
   */
  mr?: {
    readonly state?: string | undefined;
    readonly createdAt?: string | undefined;
    readonly mergedAt?: string | undefined;
  };
```

Add the pure mapper and a stored-row reader:

```ts
function storedPrFields(stored: Record<string, unknown> | null): PrFields {
  if (stored === null) {
    return {};
  }
  const st = stored["state"];
  const state =
    st === "open" || st === "merged" || st === "closed" || st === "unknown" ? st : undefined;
  const raw = stored["state_raw"];
  return {
    state,
    stateRaw: typeof raw === "string" ? raw : undefined,
    openedAtMs: canonicalEpochMs(stored["opened_at_ms"]),
    mergedAtMs: canonicalEpochMs(stored["merged_at"]),
  };
}

/**
 * The full `pr` metadata for a GitLab MR row. `upsertIndexedItem` REPLACES metadata wholesale, so
 * every canonical key this event does not itself establish is carried from the stored row
 * (`stored`) — otherwise an `approved` event after a merge would erase the merge. An `opened`
 * event's own `created_at` IS the opening time and an `accepted`/`merged` event's IS the merge
 * time (events are fetched `sort=asc`, so a later transition always wins).
 */
export function gitlabMrMetadata(
  f: {
    readonly pathWithNamespace: string;
    readonly iid: number;
    readonly actionName: string;
    readonly eventCreatedAt: string;
    readonly mr?: GitlabEventUpsertFields["mr"];
  },
  stored: Record<string, unknown> | null,
): Record<string, unknown> {
  const raw = { iid: f.iid, project: f.pathWithNamespace, action: f.actionName };
  const prior = storedPrFields(stored);
  if (f.mr !== undefined) {
    return buildPrMetadata(raw, {
      state: normalizeGitlabMrState(f.mr.state) ?? prior.state,
      stateRaw: f.mr.state ?? prior.stateRaw,
      openedAtMs: canonicalEpochMs(f.mr.createdAt) ?? prior.openedAtMs,
      mergedAtMs: canonicalEpochMs(f.mr.mergedAt) ?? prior.mergedAtMs,
      repo: f.pathWithNamespace,
    });
  }
  const transition = gitlabEventTransition(f.actionName);
  if (transition === null) {
    return buildPrMetadata(raw, { ...prior, repo: f.pathWithNamespace });
  }
  const eventMs = canonicalEpochMs(f.eventCreatedAt);
  return buildPrMetadata(raw, {
    state: transition,
    stateRaw: f.actionName,
    openedAtMs: f.actionName === "opened" ? (eventMs ?? prior.openedAtMs) : prior.openedAtMs,
    mergedAtMs: transition === "merged" ? (eventMs ?? prior.mergedAtMs) : undefined,
    repo: f.pathWithNamespace,
  });
}

function readStoredMetadata(ctx: SyncContext, itemId: string): Record<string, unknown> | null {
  const json = ctx.itemMetadata(itemId);
  if (json === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(json) as unknown;
    return asRecord(parsed) ?? null;
  } catch {
    return null;
  }
}
```

In `upsertGitlabEventItem`, replace the `meta` literal with:

```ts
  const meta =
    shape.type === "pr"
      ? gitlabMrMetadata(
          {
            pathWithNamespace,
            iid,
            actionName,
            eventCreatedAt: createdAt,
            ...(f.mr === undefined ? {} : { mr: f.mr }),
          },
          readStoredMetadata(ctx, itemPrimaryKey(SERVICE_ID, externalId)),
        )
      : { iid, project: pathWithNamespace, action: actionName };
```

In `gitlab-sync.ts`'s `fetchOne` MR path, pass the MR resource fields into `upsertFromMergeRequestEvent({ …, mr: { state: stringField(mr, "state"), createdAt: stringField(mr, "created_at"), mergedAt: stringField(mr, "merged_at") } })`.

- [ ] **Step 4: Run tests**

Run: `bun test packages/gateway/src/connectors/_lib/gitlab/events.test.ts packages/gateway/src/connectors/gitlab-sync.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bunx biome check packages/gateway/src/connectors/_lib/gitlab/events.ts packages/gateway/src/connectors/_lib/gitlab/events.test.ts packages/gateway/src/connectors/gitlab-sync.ts
bun run typecheck
git rev-parse --abbrev-ref HEAD
git add packages/gateway/src/connectors/_lib/gitlab/events.ts packages/gateway/src/connectors/_lib/gitlab/events.test.ts packages/gateway/src/connectors/gitlab-sync.ts
printf 'feat(index): GitLab MRs write the pr contract and never lose a merge to a later event\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n' > "$TEMP/msg.txt"
git commit -F "$TEMP/msg.txt"
```

---

### Task 10: `git_commit` author

**Files:**
- Modify: `packages/gateway/src/connectors/filesystem-v2-sync.ts` (`gitLogRecords` ~90–130, `syncFilesystemGitCommits` ~218–260)
- Test: `packages/gateway/src/connectors/filesystem-v2-sync.test.ts` (modify the real-git test at ~188; append)

**Interfaces:**
- Consumes: `buildGitCommitMetadata` (Task 2); `ctx.resolvePerson(hints: PersonSyncHints)` with `canonicalEmail` / `displayName` (`people/person-types.ts`).
- Produces: `gitLogRecords(root, maxCount, spawn?)` returns `{ sha: string; ct: number; subject: string; authorEmail: string; authorName: string }[]`.

- [ ] **Step 1: Write the failing tests**

In the existing `"gitAware=true on a real git repo records git_commit items…"` test (which already sets `user.email test@example.com`, `user.name Test`), after the sync, add:

```ts
  const commit = db
    .query("SELECT author_id, metadata FROM item WHERE service = 'filesystem' AND type = 'git_commit'")
    .get() as { author_id: string | null; metadata: string };
  const meta = JSON.parse(commit.metadata) as Record<string, unknown>;
  expect(meta["author_email"]).toBe("test@example.com");
  expect(meta["meta_v"]).toBe(1);
  expect(commit.author_id).not.toBeNull();
```

(Use the test's own db variable name.) Append a unit test with an injected spawn:

```ts
test("gitLogRecords parses author email and name, tolerating an empty email", async () => {
  const out = [
    `${"a".repeat(40)}\u00001700000000\u0000first\u0000ada@example.com\u0000Ada`,
    `${"b".repeat(40)}\u00001700000100\u0000second\u0000\u0000Anon`,
  ].join("\u0000");
  const spawn = ((): unknown => ({
    exited: Promise.resolve(0),
    stdout: new Response(out).body,
    stderr: new Response("").body,
  })) as unknown as typeof Bun.spawn;
  const recs = await gitLogRecords("/repo", 40, spawn);
  expect(recs).toEqual([
    { sha: "a".repeat(40), ct: 1_700_000_000_000, subject: "first", authorEmail: "ada@example.com", authorName: "Ada" },
    { sha: "b".repeat(40), ct: 1_700_000_100_000, subject: "second", authorEmail: "", authorName: "Anon" },
  ]);
});
```

If the file's existing fake-spawn helper (near line 23) builds `stdout` differently, reuse that helper instead of the inline object.

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/gateway/src/connectors/filesystem-v2-sync.test.ts`
Expected: FAIL — no `author_email`; records lack author fields.

- [ ] **Step 3: Implement** in `filesystem-v2-sync.ts`:

```ts
import { buildGitCommitMetadata } from "./git-commit-meta.ts";
```

In `gitLogRecords`: change the return type to `{ sha: string; ct: number; subject: string; authorEmail: string; authorName: string }[]`, the format to `"--pretty=format:%H%x00%ct%x00%s%x00%ae%x00%an"`, and the parse loop to stride 5:

```ts
  for (let i = 0; i + 4 < chunks.length; i += 5) {
    const sha = chunks[i] ?? "";
    const ctRaw = chunks[i + 1] ?? "0";
    const subject = chunks[i + 2] ?? "";
    const authorEmail = chunks[i + 3] ?? "";
    const authorName = chunks[i + 4] ?? "";
    if (sha.length !== 40) {
      continue;
    }
    const ct = Number.parseInt(ctRaw, 10);
    outList.push({
      sha,
      ct: Number.isFinite(ct) ? ct * 1000 : Date.now(),
      subject,
      authorEmail,
      authorName,
    });
  }
```

**Careful:** the existing `chunks` is `out.split("\0").filter((s) => s !== "")`, which drops an empty email field and shifts every later field. Replace it with:

```ts
  const chunks = out.split("\0");
  if (chunks.at(-1) === "") {
    chunks.pop();
  }
```

so an empty field inside a record keeps its position. The empty-email unit test above is the guard.

In `syncFilesystemGitCommits`, replace the row's `authorId: null` and `metadata` with:

```ts
    const authorId =
      c.authorEmail === ""
        ? null
        : ctx.resolvePerson({
            canonicalEmail: c.authorEmail,
            ...(c.authorName === "" ? {} : { displayName: c.authorName }),
          });
```

```ts
      authorId,
      metadata: buildGitCommitMetadata(
        { repoRoot: root, sha: c.sha, subject: c.subject },
        { authorEmail: c.authorEmail },
      ),
```

- [ ] **Step 4: Run tests**

Run: `bun test packages/gateway/src/connectors/filesystem-v2-sync.test.ts packages/gateway/src/connectors/filesystem-v2-sync.coverage.test.ts packages/gateway/src/connectors/filesystem-v2-blame.test.ts`
Expected: PASS (the real-git test needs `git` on PATH, as it does today).

- [ ] **Step 5: Commit**

```bash
bunx biome check packages/gateway/src/connectors/filesystem-v2-sync.ts packages/gateway/src/connectors/filesystem-v2-sync.test.ts
bun run typecheck
git rev-parse --abbrev-ref HEAD
git add packages/gateway/src/connectors/filesystem-v2-sync.ts packages/gateway/src/connectors/filesystem-v2-sync.test.ts
printf 'feat(index): git_commit rows record and resolve their author\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n' > "$TEMP/msg.txt"
git commit -F "$TEMP/msg.txt"
```

---

### Task 11: Type-scoped rebody targets

**Files:**
- Modify: `packages/gateway/src/ipc/index-rebody-rpc.ts` (`REBODY_REQUIRED_META_VERSION` ~127–137, `computePendingMetaByService` ~412–427, `buildTargetServicesSql` ~434–451, and its doc comments)
- Modify: `packages/gateway/src/ipc/index-rebody-rpc.test.ts` (~597, ~606, ~740)
- Modify: `packages/gateway/src/connectors/pagerduty-attribution.ts:6` (doc comment naming the constant)
- Modify: every doc/skill line naming `REBODY_REQUIRED_META_VERSION` (find with the grep in Step 3)

**Interfaces:**
- Consumes: `CI_RUN_META_VERSION`, `PR_META_VERSION`, `GIT_COMMIT_META_VERSION`, `TICKET_META_VERSION`, `PAGERDUTY_INCIDENT_META_VERSION`.
- Produces:
  - `export type RebodyMetaTarget = { readonly service: string; readonly type?: string; readonly requiredMetaVersion: number }`
  - `export const REBODY_META_TARGETS: readonly RebodyMetaTarget[]`
  - `computePendingMetaByService(db): Record<string, number>` and `buildTargetServicesSql(p)` — same signatures, type-scoped semantics.

- [ ] **Step 1: Write the failing tests** — replace the `describe("REBODY_REQUIRED_META_VERSION", …)` block (~740) with:

```ts
describe("REBODY_META_TARGETS", () => {
  test("keeps the service-wide ticket and incident targets", () => {
    expect(REBODY_META_TARGETS).toContainEqual({ service: "pagerduty", requiredMetaVersion: PAGERDUTY_INCIDENT_META_VERSION });
    expect(REBODY_META_TARGETS).toContainEqual({ service: "jira", requiredMetaVersion: TICKET_META_VERSION });
  });

  test("registers the contract targets type-scoped", () => {
    expect(REBODY_META_TARGETS).toContainEqual({ service: "github", type: "pr", requiredMetaVersion: PR_META_VERSION });
    expect(REBODY_META_TARGETS).toContainEqual({ service: "github_actions", type: "ci_run", requiredMetaVersion: CI_RUN_META_VERSION });
    expect(REBODY_META_TARGETS).toContainEqual({ service: "filesystem", type: "git_commit", requiredMetaVersion: GIT_COMMIT_META_VERSION });
  });

  test("a github issue below version is NOT pending; a github pr below version is", () => {
    const db = createMemoryIndexDb();
    const ins = (id: string, type: string, meta: unknown): void => {
      db.run(
        `INSERT INTO item (id, service, type, external_id, title, url, modified_at, metadata, synced_at, body_complete)
         VALUES (?, 'github', ?, ?, ?, NULL, 1, ?, 1, 1)`,
        [id, type, id, id, JSON.stringify(meta)],
      );
    };
    ins("github:i1", "issue", {});
    ins("github:p1", "pr", {});
    ins("github:p2", "pr", { meta_v: PR_META_VERSION });
    expect(computePendingMetaByService(db)).toEqual({ github: 1 });
    db.close();
  });

  test("a row matched by two targets of one service counts once", () => {
    const db = createMemoryIndexDb();
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, url, modified_at, metadata, synced_at, body_complete)
       VALUES ('jira:1', 'jira', 'issue', 'k1', 't', NULL, 1, '{}', 1, 1)`,
    );
    expect(computePendingMetaByService(db, [
      { service: "jira", requiredMetaVersion: 1 },
      { service: "jira", type: "issue", requiredMetaVersion: 1 },
    ])).toEqual({ jira: 1 });
    db.close();
  });
});
```

Update the imports at the top of the test file: `REBODY_META_TARGETS` instead of `REBODY_REQUIRED_META_VERSION`; add `CI_RUN_META_VERSION` (`../connectors/ci-run-meta.ts`), `PR_META_VERSION` (`../connectors/pr-meta.ts`), `GIT_COMMIT_META_VERSION` (`../connectors/git-commit-meta.ts`), `TICKET_META_VERSION` (`../connectors/ticket-depth.ts`), and `createMemoryIndexDb` (`../connectors/connector-sync-test-helpers.ts`) if not already imported. Check the `item` column list against the real schema used by `createMemoryIndexDb` (copy the INSERT column list from another test in this file that inserts into `item` if it differs). Replace the `params` assertions at ~597/~606 (which flatten the old Map) with assertions derived from `REBODY_META_TARGETS`: the params must contain, per target, `service`, then `type` when present, then `requiredMetaVersion`, in target order — write that as `REBODY_META_TARGETS.flatMap((t) => t.type === undefined ? [t.service, t.requiredMetaVersion] : [t.service, t.type, t.requiredMetaVersion])`.

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/gateway/src/ipc/index-rebody-rpc.test.ts`
Expected: FAIL — `REBODY_META_TARGETS` not exported.

- [ ] **Step 3: Implement** in `index-rebody-rpc.ts` (replace the Map and the two functions):

```ts
import { CI_RUN_META_VERSION } from "../connectors/ci-run-meta.ts";
import { GIT_COMMIT_META_VERSION } from "../connectors/git-commit-meta.ts";
import { PR_META_VERSION } from "../connectors/pr-meta.ts";

export type RebodyMetaTarget = {
  readonly service: string;
  /** Absent = every item type of the service must carry the version. */
  readonly type?: string;
  readonly requiredMetaVersion: number;
};

/**
 * Rows that must carry at least `requiredMetaVersion` in `metadata.meta_v` to count as fully
 * recovered — the SECOND eligibility reason beside `body_complete = 0`. Type-scoped where a service
 * writes several item types and only one carries the contract (`github`/`gitlab` also write
 * `issue` rows, which would otherwise stay eligible forever).
 *
 * A future metadata-depth bump for any item type (`issue`, `incident`, `message`...) adds an entry
 * HERE; it does not add a mechanism or touch the RPC dispatch.
 */
export const REBODY_META_TARGETS: readonly RebodyMetaTarget[] = [
  { service: "jira", requiredMetaVersion: TICKET_META_VERSION },
  { service: "linear", requiredMetaVersion: TICKET_META_VERSION },
  // Incidents indexed before Spec B carry no actor emails. The data was never fetched, so unlike
  // Sentry this is not recoverable from stored rows — it needs a re-fetch.
  { service: "pagerduty", requiredMetaVersion: PAGERDUTY_INCIDENT_META_VERSION },
  { service: "github_actions", type: "ci_run", requiredMetaVersion: CI_RUN_META_VERSION },
  { service: "circleci", type: "ci_run", requiredMetaVersion: CI_RUN_META_VERSION },
  { service: "gitlab", type: "ci_run", requiredMetaVersion: CI_RUN_META_VERSION },
  { service: "jenkins", type: "ci_run", requiredMetaVersion: CI_RUN_META_VERSION },
  { service: "github", type: "pr", requiredMetaVersion: PR_META_VERSION },
  { service: "bitbucket", type: "pr", requiredMetaVersion: PR_META_VERSION },
  { service: "gitlab", type: "pr", requiredMetaVersion: PR_META_VERSION },
  { service: "filesystem", type: "git_commit", requiredMetaVersion: GIT_COMMIT_META_VERSION },
];

function metaTargetClause(t: RebodyMetaTarget): { sql: string; params: Array<string | number> } {
  return t.type === undefined
    ? {
        sql: `(service = ? AND COALESCE(json_extract(metadata, '$.meta_v'), 0) < ?)`,
        params: [t.service, t.requiredMetaVersion],
      }
    : {
        sql: `(service = ? AND type = ? AND COALESCE(json_extract(metadata, '$.meta_v'), 0) < ?)`,
        params: [t.service, t.type, t.requiredMetaVersion],
      };
}

/**
 * Per service, how many rows are below their required version. One query per service with that
 * service's clauses OR-joined, so a row two targets both match is counted ONCE.
 */
export function computePendingMetaByService(
  db: Database,
  targets: readonly RebodyMetaTarget[] = REBODY_META_TARGETS,
): Record<string, number> {
  const byService = new Map<string, RebodyMetaTarget[]>();
  for (const t of targets) {
    const list = byService.get(t.service) ?? [];
    list.push(t);
    byService.set(t.service, list);
  }
  const out: Record<string, number> = {};
  for (const [service, list] of byService) {
    const clauses = list.map(metaTargetClause);
    const row = db
      .query(`SELECT COUNT(*) AS pending FROM item WHERE ${clauses.map((c) => c.sql).join(" OR ")}`)
      .get(...clauses.flatMap((c) => c.params)) as { pending: number } | undefined;
    const pending = row?.pending ?? 0;
    if (pending > 0) {
      out[service] = pending;
    }
  }
  return out;
}

/**
 * A row is recoverable when its body is incomplete OR it is below a registered metadata target.
 * Bound parameters only — never interpolation (I9); the interpolated text is fixed clause shapes.
 */
export function buildTargetServicesSql(p: RebodyParams): {
  sql: string;
  params: Array<string | number>;
} {
  const clauses = REBODY_META_TARGETS.map(metaTargetClause);
  const params: Array<string | number> = clauses.flatMap((c) => c.params);
  let sql = `SELECT DISTINCT service FROM item WHERE (body_complete = 0 OR ${clauses.map((c) => c.sql).join(" OR ")})`;
  if (p.type !== undefined) {
    sql += ` AND type = ?`;
    params.push(p.type);
  }
  sql += ` ORDER BY service`;
  return { sql, params };
}
```

Then rename every remaining reference:

```bash
grep -rn "REBODY_REQUIRED_META_VERSION" packages docs .claude CLAUDE.md GEMINI.md
```

Update each hit to `REBODY_META_TARGETS` (code) or reword the prose ("`REBODY_META_TARGETS`, a type-scoped list"). The `.get(...)` spread on `db.query(...)` must type-check under `bun:sqlite`'s `SQLQueryBindings`; if it does not, build the statement once and call `.get(...(params as SQLQueryBindings[]))` the way other dynamic-clause queries in `ipc/` do (search `SQLQueryBindings` for the local idiom).

- [ ] **Step 4: Run tests**

Run: `bun test packages/gateway/src/ipc/index-rebody-rpc.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bunx biome check packages/gateway/src/ipc/index-rebody-rpc.ts packages/gateway/src/ipc/index-rebody-rpc.test.ts
bun run typecheck
bun run audit:doc-refs
git rev-parse --abbrev-ref HEAD
git add -A packages/gateway/src/ipc/index-rebody-rpc.ts packages/gateway/src/ipc/index-rebody-rpc.test.ts packages/gateway/src/connectors/pagerduty-attribution.ts docs .claude CLAUDE.md GEMINI.md
printf 'feat(index): rebody recovers the new contract versions, type-scoped\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n' > "$TEMP/msg.txt"
git commit -F "$TEMP/msg.txt"
```

---

### Task 12: Collision pins and the emitted-keys drift test

**Files:**
- Create: `packages/gateway/src/connectors/lane-contract-collisions.test.ts`
- Create: `packages/gateway/src/connectors/lane-contract-drift.test.ts`

**Interfaces:**
- Consumes: every mapper from Tasks 3–10; `nonGithubMergedPrCount` (`agents/changelog-queries.ts`, `(db, w: { fromMs; toMs; scope })`), `nonGithubMergedPrCount` + `selectActivePrs` (`agents/standup-queries.ts`, `(db, w: { fromMs; toMs }, personId)`).

These tests pin reader results that §3.1.1 changes in A1, using rows built **only** by the real mappers.

- [ ] **Step 1: Write the tests**

```ts
// packages/gateway/src/connectors/lane-contract-collisions.test.ts
/**
 * Spec §3.1.1: four canonical keys collide with raw keys writers already emitted, so these reader
 * results change in PR A1 (before any reader code changes in A2). Each change is in the direction
 * of the fix; pinning it makes it deliberate. Rows come ONLY from the real writer mappers.
 */
import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { nonGithubMergedPrCount as changelogNonGithubMerged } from "../agents/changelog-queries.ts";
import {
  nonGithubMergedPrCount as standupNonGithubMerged,
  selectActivePrs,
} from "../agents/standup-queries.ts";
import { bitbucketPrMetadata } from "./bitbucket-sync.ts";
import { createMemoryIndexDb } from "./connector-sync-test-helpers.ts";
import { gitlabMrMetadata } from "./_lib/gitlab/events.ts";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const ME = "person:me";

function insertPr(db: Database, id: string, service: string, meta: Record<string, unknown>): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, url, modified_at, author_id, metadata, synced_at)
     VALUES (?, ?, 'pr', ?, ?, NULL, ?, ?, ?, ?)`,
    [id, service, id, id, NOW - 3_600_000, ME, JSON.stringify(meta), NOW],
  );
}

function seeded(): Database {
  const db = createMemoryIndexDb();
  insertPr(db, "bitbucket:acme/app#1", "bitbucket",
    bitbucketPrMetadata("acme/app", { id: 1, state: "MERGED", created_on: "2026-10-01T00:00:00Z" }, "Me"));
  insertPr(db, "gitlab:acme/app!2", "gitlab",
    gitlabMrMetadata({ pathWithNamespace: "acme/app", iid: 2, actionName: "accepted", eventCreatedAt: "2026-10-08T10:00:00Z" }, null));
  return db;
}

describe("§3.1.1 collisions — reader results that change in A1", () => {
  test("changelog counts non-GitHub merges it used to miss (was 0)", () => {
    const db = seeded();
    expect(changelogNonGithubMerged(db, { fromMs: NOW - 86_400_000, toMs: NOW, scope: { kind: "all" } })).toBe(2);
    db.close();
  });

  test("standup counts my non-GitHub merges (was 0)", () => {
    const db = seeded();
    expect(standupNonGithubMerged(db, { fromMs: NOW - 86_400_000, toMs: NOW }, ME)).toBe(2);
    db.close();
  });

  test("standup no longer lists merged Bitbucket/GitLab PRs as active", () => {
    const db = seeded();
    expect(selectActivePrs(db, { fromMs: NOW - 86_400_000, toMs: NOW }, ME)).toEqual([]);
    db.close();
  });
});
```

Before running, check both `nonGithubMergedPrCount` implementations' windowing (`modified_at` within `[fromMs, toMs)`) and the `item` INSERT column list against `createMemoryIndexDb`'s schema (copy from `agents/standup.test.ts`'s `insertItem`). Adjust only the fixture plumbing, never the expected numbers.

```ts
// packages/gateway/src/connectors/lane-contract-drift.test.ts
/**
 * The emitted-keys tables are DATA the census (PR A3) and reader disclosures (PR A2) trust. This
 * drives every real mapper with its richest input and asserts the canonical keys it emits are
 * EXACTLY the table's row — so the table cannot claim a key the code never writes, or miss one.
 */
import { describe, expect, test } from "bun:test";

import { gitlabMrMetadata } from "./_lib/gitlab/events.ts";
import { gitlabPipelineMetadata } from "./_lib/gitlab/pipelines.ts";
import { bitbucketPrMetadata } from "./bitbucket-sync.ts";
import { CANONICAL_CI_RUN_KEYS, CI_RUN_EMITTED_KEYS } from "./ci-run-meta.ts";
import { circleciPipelineMetadata } from "./circleci-sync.ts";
import { githubActionsRunMetadata } from "./github-actions-sync.ts";
import { extractPrMetadataForIndex } from "./github-sync.ts";
import { jenkinsBuildMetadata } from "./jenkins-sync.ts";
import { CANONICAL_PR_KEYS, PR_EMITTED_KEYS } from "./pr-meta.ts";

const ciKeys = (m: Record<string, unknown>): Set<string> =>
  new Set(Object.keys(m).filter((k) => (CANONICAL_CI_RUN_KEYS as readonly string[]).includes(k)));
const prKeys = (m: Record<string, unknown>): Set<string> =>
  new Set(Object.keys(m).filter((k) => (CANONICAL_PR_KEYS as readonly string[]).includes(k)));

describe("ci_run emitted keys == table", () => {
  test("github_actions", () => {
    const m = githubActionsRunMetadata("a/b", { id: 1, name: "w", status: "completed", conclusion: "success", head_branch: "main", head_sha: "s" }, 0);
    expect(ciKeys(m)).toEqual(new Set(CI_RUN_EMITTED_KEYS.github_actions));
  });
  test("circleci", () => {
    const m = circleciPipelineMetadata("a/b", "gh/a/b", { number: 1, id: "p", state: "errored", vcs: { branch: "main", revision: "s" } });
    expect(ciKeys(m)).toEqual(new Set(CI_RUN_EMITTED_KEYS.circleci));
  });
  test("gitlab", () => {
    const m = gitlabPipelineMetadata("a/b", { id: 1, status: "success", ref: "main", sha: "s" });
    expect(ciKeys(m)).toEqual(new Set(CI_RUN_EMITTED_KEYS.gitlab));
  });
  test("jenkins", () => {
    const m = jenkinsBuildMetadata("f/j", { number: 1, result: "SUCCESS", building: false });
    expect(ciKeys(m)).toEqual(new Set(CI_RUN_EMITTED_KEYS.jenkins));
  });
});

describe("pr emitted keys == table", () => {
  test("github", () => {
    const m = extractPrMetadataForIndex("a/b", { number: 1, state: "closed", merged: true, created_at: "2026-10-01T00:00:00Z", merged_at: "2026-10-02T00:00:00Z" });
    expect(prKeys(m)).toEqual(new Set(PR_EMITTED_KEYS.github));
  });
  test("bitbucket", () => {
    const m = bitbucketPrMetadata("a/b", { id: 1, state: "MERGED", created_on: "2026-10-01T00:00:00Z" }, "x");
    expect(prKeys(m)).toEqual(new Set(PR_EMITTED_KEYS.bitbucket));
  });
  test("gitlab", () => {
    const opened = gitlabMrMetadata({ pathWithNamespace: "a/b", iid: 1, actionName: "opened", eventCreatedAt: "2026-10-01T00:00:00Z" }, null);
    const m = gitlabMrMetadata({ pathWithNamespace: "a/b", iid: 1, actionName: "accepted", eventCreatedAt: "2026-10-02T00:00:00Z" }, opened);
    expect(prKeys(m)).toEqual(new Set(PR_EMITTED_KEYS.gitlab));
  });
});
```

The per-writer "emits exactly the keys" tests in Tasks 3–9 overlap with this file by design: those live beside each writer; this one is the single place the census author (A3) reads. If Biome's formatter rewraps the long object literals, accept its formatting.

- [ ] **Step 2: Run**

Run: `bun test packages/gateway/src/connectors/lane-contract-collisions.test.ts packages/gateway/src/connectors/lane-contract-drift.test.ts`
Expected: PASS. If a collision pin fails, **stop**: either a mapper is wrong (fix it in its task's file) or the reader does something the spec did not account for (report it — do not change the expected number).

- [ ] **Step 3: Commit**

```bash
bunx biome check --write packages/gateway/src/connectors/lane-contract-collisions.test.ts packages/gateway/src/connectors/lane-contract-drift.test.ts
git rev-parse --abbrev-ref HEAD
git add packages/gateway/src/connectors/lane-contract-collisions.test.ts packages/gateway/src/connectors/lane-contract-drift.test.ts
printf 'test(index): pin the reader results the contract collisions change\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n' > "$TEMP/msg.txt"
git commit -F "$TEMP/msg.txt"
```

---

### Task 12b: preflight's two latent CI defects (added during execution — ledger Ruling R7)

**Why this is in A1:** Tasks 3–5 give GitHub Actions rows a canonical `branch` (and CircleCI `errored` a `failure` conclusion), so `preflight.ts`'s `$.branch = ? AND $.conclusion IN (…)` filter starts MATCHING in A1. Before A1 the lane was dead (fail-open). Live, it exposes two defects spec §4 already names: the failure filter sits inside the ranking CTE (a failure superseded by a newer pass still reports), and runs are not scoped to the service's repos (any repo sharing the CI service and branch name contaminates the verdict). `--mode block` would then fail deploys on stale or foreign failures. This task fixes exactly those two, nothing else in preflight.

**Files:**
- Modify: `packages/gateway/src/preflight/preflight.ts` (`selectFailingCiRuns`, ~148–206)
- Test: `packages/gateway/src/preflight/preflight.test.ts`

**Interfaces:**
- Consumes: `repoLikeMatchesUrn(metadata, externalId, urn)` (exported from `metrics/dora.ts`); `githubActionsRunMetadata(repoFull, run, now)` (Task 3) for fixtures.
- Produces: `selectFailingCiRuns` — same signature and return shape.

- [ ] **Step 1: Write the failing tests.** In `preflight.test.ts`, add a helper that inserts a `github_actions` `ci_run` row whose `metadata` is `JSON.stringify(githubActionsRunMetadata(repo, run, NOW))` and whose `external_id` is `` `${repo}#run-${id}` `` (the real writer's shape), using the file's existing item-insert idiom and `ServiceConfig` builder. Then:

```ts
test("a red GitHub Actions run on the target branch fails CI (real writer shape)", () => {
  // insert run {id: 1, name: "CI", status: "completed", conclusion: "failure", head_branch: "main", created_at T-1h} for "acme/app"
  // cfg.repos = [github URN for acme/app]; expect failing_ci_runs.count === 1
});
test("a newer passing run of the same workflow supersedes an older failure", () => {
  // insert failure at T-2h and success at T-1h, same name "CI", branch main, repo acme/app
  // expect failing_ci_runs.count === 0
});
test("a failing run in a repo outside the service's URNs is ignored", () => {
  // insert failure for "acme/other" on main; cfg.repos only acme/app
  // expect failing_ci_runs.count === 0
});
```

Write these as real tests against the file's existing entry point (the exported function the other preflight tests call), with explicit row values. Existing tests whose fixtures hand-write `{branch, conclusion}` with no `repo` will now be filtered out by repo scoping: rebuild those fixtures through `githubActionsRunMetadata` (keeping each test's intent and expected numbers), and say which ones in the report.

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/gateway/src/preflight/preflight.test.ts`
Expected: the supersede and other-repo tests FAIL (count 1, not 0).

- [ ] **Step 3: Implement** — rank over ALL runs of the target branch, filter failures OUTSIDE the CTE, and scope by repo in TypeScript with DORA's matcher:

```ts
import { repoLikeMatchesUrn } from "../metrics/dora.ts";
```

```ts
  const sql = `
    WITH ranked AS (
      SELECT
        id, external_id, title, url, modified_at, metadata,
        ROW_NUMBER() OVER (
          PARTITION BY service,
            COALESCE(json_extract(metadata, '$.repo'), ''),
            COALESCE(json_extract(metadata, '$.workflow_name'), '')
          ORDER BY modified_at DESC
        ) AS rn
      FROM item
      WHERE service IN (${servicePlaceholders})
        AND type = 'ci_run'
        AND json_valid(metadata)
        AND json_extract(metadata, '$.branch') = ?
    )
    SELECT id, external_id, title, url, modified_at, metadata FROM ranked
     WHERE rn = 1
       AND json_extract(metadata, '$.conclusion') IN (${conclusionPlaceholders})
  `;
  const params = [...ciServices, targetRef, ...FAILED_CONCLUSIONS];
  const rows = db.query(sql).all(...params) as {
    id: string;
    external_id: string;
    title: string;
    url: string | null;
    modified_at: number;
    metadata: string;
  }[];
  // Scope to THIS service's repos with the same URN matching DORA uses, so a repo that merely
  // shares the CI service and a branch name cannot fail this service's deploy gate.
  const allLatest = rows.filter((r) => {
    const meta = JSON.parse(r.metadata) as Record<string, unknown>;
    return cfg.repos.some((u) => repoLikeMatchesUrn(meta, r.external_id, u));
  });
```

Keep the rest of the function (count, findings mapping) operating on `allLatest` unchanged. A provider without `workflow_name` (CircleCI, GitLab) collapses to the latest run per repo + branch — the intended fallback (spec §4); the title is never a partition key, because it embeds the conclusion.

- [ ] **Step 4: Run tests**

Run: `bun test packages/gateway/src/preflight packages/gateway/src/ipc/preflight-rpc.test.ts`
Expected: PASS (skip the second path if that file does not exist).

- [ ] **Step 5: Commit**

```bash
bunx biome check packages/gateway/src/preflight/preflight.ts packages/gateway/src/preflight/preflight.test.ts
bun run typecheck
git rev-parse --abbrev-ref HEAD
git add packages/gateway/src/preflight/preflight.ts packages/gateway/src/preflight/preflight.test.ts
printf 'fix(preflight): a superseded or foreign-repo CI failure no longer fails the gate\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n' > "$TEMP/msg.txt"
git commit -F "$TEMP/msg.txt"
```

---

### Task 13: Demo corpus on the contract

**Files:**
- Modify: `packages/gateway/src/demo/corpus/acme.ts` (STORY_PRS ~268–300, generated PRs ~476–497, ci runs ~510–522, PR #415 ~550–566)
- Test: existing `packages/gateway/src/demo/**` tests, the demo e2e test, and `scripts/release/assert-demo-tour.ts`'s own tests

**Interfaces:**
- Consumes: `buildPrMetadata`, `buildCiRunMetadata` (Tasks 1–2).

The demo must use the same shape production writes, so it can never again pass only because it hand-writes a key.

- [ ] **Step 1: Find the demo's tests**

```bash
grep -rln "acme\|demo/corpus\|demo.seed" packages/gateway/src/demo packages/gateway/test packages/cli/src scripts/release --include=*.test.ts
```

Run them all now and record the baseline (all must pass before the change).

- [ ] **Step 2: Rewrite the metadata through the builders.** For each PR `metadata: (at) => ({ … })` in `acme.ts`, wrap the existing object: keep `number`, `draft`, `labels`, `merge_commit_sha`, `additions`/`deletions`/`changed_files` as the raw record, and move `state`/`merged`/`merged_at`/`repo` into the fields, adding `stateRaw: "closed"` (merged) or `"open"`, and `openedAtMs` one day before the PR's `offsetMs`. For example, the STORY PR #412 becomes:

```ts
    metadata: (at) =>
      buildPrMetadata(
        {
          number: 412,
          draft: false,
          merge_commit_sha: SHA_412,
          additions: 18,
          deletions: 6,
          changed_files: 2,
          labels: [],
        },
        {
          state: "merged",
          stateRaw: "closed",
          openedAtMs: at(-3 * HOUR - DAY),
          mergedAtMs: at(-3 * HOUR),
          repo: "acme/payments",
        },
      ),
```

PR #415 (open): `buildPrMetadata({ number: 415, draft: false, labels: [] }, { state: "open", stateRaw: "open", openedAtMs: at(-5 * HOUR), repo: "acme/payments" })` — its `metadata` now takes `(at)`.

The generated `ci_run` rows become:

```ts
        metadata: () =>
          buildCiRunMetadata(
            {
              workflowName: "Deploy production",
              runId,
              event: "push",
              headSha: mergeSha,
              headBranch: "main",
              status: "completed",
            },
            {
              conclusion: failed ? "failure" : "success",
              conclusionRaw: failed ? "failure" : "success",
              branch: "main",
              repo: svc.repo,
              workflowName: "Deploy production",
              headSha: mergeSha,
            },
          ),
```

Imports: `import { buildCiRunMetadata } from "../../connectors/ci-run-meta.ts";` and `import { buildPrMetadata } from "../../connectors/pr-meta.ts";`. Confirm `DAY` is defined in the file (it is used at line ~264); if `(at) =>` callers pass `at` with a different signature, follow the file's existing `at(...)` usage.

- [ ] **Step 3: Run the demo tests**

Re-run the full list from Step 1, plus `bun test packages/gateway/src/demo`. Expected: PASS, identical counts to the baseline. A change in a tour/brief count means a reader read a key the old hand-shape had and the contract shape does not — report it rather than adjusting the corpus to match.

- [ ] **Step 4: Commit**

```bash
bunx biome check packages/gateway/src/demo/corpus/acme.ts
bun run typecheck
git rev-parse --abbrev-ref HEAD
git add packages/gateway/src/demo/corpus/acme.ts
printf 'feat(demo): build the demo corpus through the index lane contract\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n' > "$TEMP/msg.txt"
git commit -F "$TEMP/msg.txt"
```

---

### Task 14: Verification and the A1 PR

**Files:** none new.

- [ ] **Step 1: Static gates**

Run: `bun run preflight:fast`
Expected: PASS. Fix anything red in the file that owns it, then re-run.

- [ ] **Step 2: Every test this PR touched, plus the readers it moves**

```bash
bun test packages/gateway/src/connectors packages/gateway/src/ipc/index-rebody-rpc.test.ts packages/gateway/src/agents packages/gateway/src/metrics packages/gateway/src/preflight packages/gateway/src/demo packages/gateway/test/unit/connectors
```

Expected: PASS. A reader test that fails because its fixture hand-wrote an old key (`state: "closed"` on a merged GitHub PR, `branch` holding a CircleCI tag, raw `conclusion: "timed_out"`) is a §3.1.1 collision: change the fixture to the real mapper's output and say so in the PR body. Do NOT edit reader code — readers are A2.

- [ ] **Step 3: Census delta (informational)**

```bash
bun run audit:lane-census
git checkout docs/structure-audit/index-lane-census.json
```

Record the `unmatched item reads` count in the PR body (it was 83). It is expected to move only slightly — the census cannot see builder-made keys until A3.

- [ ] **Step 4: Cross-platform test gaps**

Run: `bun run audit:platform-test-gaps`
The real-git test in Task 10 runs on every OS; note any `skipIf` it lists.

- [ ] **Step 5: Strip the spec and plan, push, open the PR**

Per the repo's convention, specs and plans never land on `main`:

Cut a PR branch so the working branch keeps the spec and plan for A2/A3:

```bash
git switch -c dev/asaf/index-lane-contract-a1
git rm docs/superpowers/specs/2026-10-08-index-lane-contract-design.md docs/superpowers/plans/2026-10-08-index-lane-contract-a1.md
printf 'chore: drop the planning docs from the PR branch\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n' > "$TEMP/msg.txt"
git commit -F "$TEMP/msg.txt"
git push -u origin dev/asaf/index-lane-contract-a1
gh pr create --title "feat(index): canonical ci_run / pr / git_commit metadata contract (index lane A1)" --body-file "$TEMP/pr-body.md"
```

PR body (`$TEMP/pr-body.md`): what the contract is; the four §3.1.1 collisions and the pinned reader changes (changelog/standup now count non-GitHub merges and drop merged ones from "active"); CircleCI has no success signal; GitLab tag residual; rebody now recovers the new versions (`nimbus index rebody`); census count before/after; "readers move in A2; the gate lands in A3"; and end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. No `!` — no user action is required (existing rows read as unknown until resync/rebody, which A2's disclosures cover).

Wait for `PR quality — required gates` to go green (or `gh pr merge --squash --auto`); merging is the user's call.
