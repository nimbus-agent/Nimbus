# Index Lane Contract — PR A2 (readers + writer fixes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every reader of `ci_run` / `pr` / `git_commit` rows answers from the canonical contract and says honestly when it cannot, and the four writer defects A1's review found are closed.

**Architecture:** A1 (#1632, merged as `232b7783`) put canonical keys on every writer and already moved most reader SQL onto them. A2 finishes the job: (a) four writer fixes in `connectors/`; (b) one evaluability helper, derived from A1's emitted-keys tables, that preflight and DORA both use to emit a new `ci_not_evaluable` gap; (c) per-reader disclosure and key fixes (stats, premortem, negotiate, expert, oncall/changelog/standup wording); (d) every hand-shaped `ci_run`/`pr` fixture rebuilt from the real mapper output.

**Tech Stack:** Bun 1.3, TypeScript strict (no `any`), `bun:test`, `bun:sqlite`, Biome.

**Spec:** `docs/superpowers/specs/2026-10-08-index-lane-contract-design.md` — §4 and §4.2 (A2 decisions and scope, amended 2026-10-08) are this PR; §3 is the contract A1 shipped.

## Global Constraints

- Canonical `ci_run` keys: `conclusion` (`success|failure|cancelled|running|unknown`), `conclusion_raw`, `branch`, `repo`, `workflow_name`, `head_sha`, `meta_v`. Canonical `pr` keys: `state` (`open|merged|closed|unknown`), `state_raw`, `merged`, `opened_at_ms`, `merged_at`, `repo`, `meta_v`. Readers read canonical keys; a raw key is read only as a fallback for rows written before A1 (`meta_v` absent).
- A field the provider cannot honestly supply is omitted — never `null`, `""`, or guessed. Absent = unknown, and a reader must disclose unknown rather than report it as a clean zero.
- Unevaluable CI is a **gap, never a verdict change** (user decision): preflight's verdict logic (`computeDeployPreflight`, `preflight.ts` ~288) is not touched.
- New gap names are at most 64 characters (the GitHub Action truncates at `safeString(gap, 64)`).
- Every gap enum change is mirrored by hand in `packages/gateway/openapi/v1.yaml` (no test checks it): `PreflightGap` ~481–492, DORA gap ~372–387, stats gap ~430.
- Removing a value from a public enum is not allowed in this PR; add new values, stop emitting old ones.
- Fixtures: every `ci_run`/`pr`/`git_commit` row a test inserts gets its `metadata` from a real mapper — `githubActionsRunMetadata(repoFull, run, now)`, `circleciPipelineMetadata(githubRepoFull, projectSlug, row)`, `gitlabPipelineMetadata(projectPath, row)`, `jenkinsBuildMetadata(jobFullName, build)`, `extractPrMetadataForIndex(repoFull, pr, nowMs?)`, `bitbucketPrMetadata(repoFull, pr, authorDisplayName)`, `gitlabMrMetadata(f, stored)`, `buildGitCommitMetadata(raw, {authorEmail})` — passed into the test file's existing insert helper. A test that deliberately pins a shape no writer produces (a defensive branch) says so in a comment.
- Gap categories are the closed `GapCategory` union: `missing_entity_type | missing_relation_emit | missing_connector | missing_user_identity | empty_index`.
- A `GapNote` in the reserved `## Gaps` section needs no I31 anchor. Do not add interleaved disclosure prose that would need one.
- No `any`; bound-parameter SQL (I9); index writes only through `ctx.upsertItem` (I14); git spawns keep `windowsHide: true` + `extensionProcessEnv` (I1/D25).
- **Test paths CI runs:** `bun test packages/gateway packages/cli scripts`. Every task's final step runs its own files; Task 12 runs all three trees — a narrower run missed a `scripts/` failure on A1.
- Commit with `git commit -F <file>`; each message ends with exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Stage files explicitly; never stage `docs/superpowers/**/*-review.md`. Verify `git rev-parse --abbrev-ref HEAD` is `dev/asaf/index-lane-contract-a2` before every commit.

## Review Focus

1. **A service bound to both GitHub Actions and Jenkins** must still report GitHub Actions failures (count > 0) AND carry `ci_not_evaluable` — the gap must not suppress real findings. Pinned in Task 4.
2. **A GitLab MR first seen through a non-`opened` event** (approved, merged) must end with `authorId: null` and no `author_login`, not the approver/merger. Pinned in Task 2.
3. **A CI run stored as `running` that the provider no longer returns** (fell out of the latest-30 window) must not trigger an extra request or loop — it simply stays `running`. Pinned in Task 3.
4. **A stats window where a GitLab merge sits outside the synced window** is not double counted and the result still carries `incomplete_merge_data`. Pinned in Task 6.
5. **`expert` on an index whose `git_commit` rows predate A1** (no `author_id`, no `author_email`) must emit the `missing_user_identity` gap, not an empty lane. Pinned in Task 10.

---

## File Structure

| File | Responsibility |
|---|---|
| `connectors/pr-meta.ts` | `merged` only for a known state |
| `connectors/_lib/gitlab/events.ts`, `connectors/gitlab-sync.ts` | GitLab MR author = MR author; no `meta_v` without state |
| `connectors/ci-run-refresh.ts` (new) | `storedRunIsUnfinished(ctx, service, externalId)` |
| `connectors/{github-actions-sync,circleci-sync,jenkins-sync}.ts`, `connectors/_lib/gitlab/pipelines.ts` | re-upsert previously seen `running` runs |
| `metrics/ci-evaluability.ts` (new) | `unevaluableCiServices(repos, use)` derived from A1's tables |
| `preflight/preflight.ts` | `ci_not_evaluable` gap; canonical `head_sha` |
| `metrics/dora.ts` | `ci_not_evaluable` gap; canonical `head_sha` in the deploy index |
| `metrics/stats.ts` | `pr-merges` counts GitLab; `incomplete_merge_data` |
| `agents/premortem.ts`, `premortem/risks.ts` | per-forge review-drag disclosure |
| `agents/negotiate.ts`, `agents/_lib/negotiate-types.ts`, `agents/_lib/render.ts` | `mergedCoverage` |
| `agents/expert.ts` | commit-authorship lane on filesystem `git_commit` rows |
| `agents/{oncall,changelog,standup}.ts` + their `_lib`/queries comments | gap wording |
| `packages/gateway/openapi/v1.yaml` | enum mirrors |
| `docs/cli-reference.md`, `docs/roadmap.md`, `docs/CHANGELOG.md` | prose |

All paths below are under `packages/gateway/src/` unless they start with `packages/`, `docs/` or `scripts/`.

---

### Task 1: `merged` is written only for a known PR state

**Files:**
- Modify: `connectors/pr-meta.ts` (`buildPrMetadata`, ~143–175)
- Test: `connectors/pr-meta.test.ts`

**Interfaces:**
- Produces: `buildPrMetadata(raw, fields)` — unchanged signature; `merged` present iff `fields.state` ∈ {`open`,`merged`,`closed`}.

- [ ] **Step 1: Write the failing test** (append to `pr-meta.test.ts`)

```ts
describe("buildPrMetadata — merged only for a known state", () => {
  test("an unknown state writes state but no merged flag", () => {
    const out = buildPrMetadata({}, { state: "unknown" });
    expect(out["state"]).toBe("unknown");
    expect("merged" in out).toBe(false);
  });
  test("open and closed still write merged: false; merged writes true", () => {
    expect(buildPrMetadata({}, { state: "open" })["merged"]).toBe(false);
    expect(buildPrMetadata({}, { state: "closed" })["merged"]).toBe(false);
    expect(buildPrMetadata({}, { state: "merged" })["merged"]).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/gateway/src/connectors/pr-meta.test.ts`
Expected: FAIL — `merged` is `false` for `unknown`.

- [ ] **Step 3: Implement** — in `buildPrMetadata`, replace

```ts
  if (fields.state !== undefined) {
    out["state"] = fields.state;
    out["merged"] = fields.state === "merged";
  }
```

with

```ts
  if (fields.state !== undefined) {
    out["state"] = fields.state;
    // `unknown` asserts nothing about merging; writing `merged: false` there would turn an
    // unrecognised vendor value into a definite "not merged" for every reader of `$.merged`.
    if (fields.state !== "unknown") {
      out["merged"] = fields.state === "merged";
    }
  }
```

- [ ] **Step 4: Run tests**

Run: `bun test packages/gateway/src/connectors/pr-meta.test.ts packages/gateway/src/connectors/lane-contract-drift.test.ts packages/gateway/src/connectors/lane-contract-collisions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit** — message `fix(index): an unknown PR state no longer asserts merged: false`.

---

### Task 2: GitLab MR rows credit the MR author, and never claim recovery without state

**Files:**
- Modify: `connectors/_lib/gitlab/events.ts` (`storedPrFields` ~96, `gitlabMrMetadata` ~119–152, `upsertGitlabEventItem` ~167–221)
- Modify: `connectors/gitlab-sync.ts` (fetchOne MR path ~130–178) only if it does not already pass the MR author as `authorUsername`/`authorName`
- Test: `connectors/_lib/gitlab/events.test.ts`, `connectors/gitlab-sync.test.ts`

**Interfaces:**
- Consumes: `buildPrMetadata`, `PR_META_VERSION` (`connectors/pr-meta.ts`).
- Produces: `gitlabMrMetadata(f, stored)` where `f` gains `readonly author?: { readonly login: string; readonly name?: string | undefined }` — the MR author when THIS write knows it (an `opened` event's actor, or `fetchOne`'s `mr.author`). Output gains raw keys `author_login` / `author_name` (carried forward from `stored` when `f.author` is absent). Output has NO `meta_v` when it has no `state`.

- [ ] **Step 1: Write the failing tests** (append to `events.test.ts`, which already imports `gitlabMrMetadata`)

```ts
const AUTHOR = { login: "dana", name: "Dana" } as const;

test("gitlabMrMetadata — the opened event's actor is recorded as the MR author", () => {
  const m = gitlabMrMetadata(
    { pathWithNamespace: "acme/app", iid: 9, actionName: "opened", eventCreatedAt: "2026-10-01T09:00:00Z", author: AUTHOR },
    null,
  );
  expect(m["author_login"]).toBe("dana");
  expect(m["author_name"]).toBe("Dana");
});

test("gitlabMrMetadata — a later event carries the author forward and ignores its own actor", () => {
  const opened = gitlabMrMetadata(
    { pathWithNamespace: "acme/app", iid: 9, actionName: "opened", eventCreatedAt: "2026-10-01T09:00:00Z", author: AUTHOR },
    null,
  );
  const merged = gitlabMrMetadata(
    { pathWithNamespace: "acme/app", iid: 9, actionName: "accepted", eventCreatedAt: "2026-10-02T09:00:00Z" },
    opened,
  );
  expect(merged["author_login"]).toBe("dana");
});

test("gitlabMrMetadata — no state known means no meta_v, so rebody keeps the row eligible", () => {
  const legacy = { iid: 9, project: "acme/app", action: "opened" }; // a pre-A1 row
  const m = gitlabMrMetadata(
    { pathWithNamespace: "acme/app", iid: 9, actionName: "approved", eventCreatedAt: "2026-10-03T09:00:00Z" },
    legacy,
  );
  expect("state" in m).toBe(false);
  expect("meta_v" in m).toBe(false);
});
```

And a sync-level test (copy the fetch-stub setup of the existing "events sync — accepted then approved…" test in this file verbatim, changing only the events array) asserting the row's `author_id`:

```ts
// events: [{ target_type: "MergeRequest", target_iid: 9, action_name: "approved",
//            created_at: "2026-10-03T09:00:00Z", author_username: "sam", author_name: "Sam",
//            target_title: "Add cache", project: { path_with_namespace: "acme/app" } }]
// No stored row, so the MR author is unknown: expect author_id IS NULL, and metadata has no
// author_login — the approver (sam) is NOT credited as the author.
```

Write it as a real test with that events array, then read `SELECT author_id, metadata FROM item WHERE service='gitlab' AND type='pr'` and assert `author_id === null` and `!("author_login" in JSON.parse(metadata))`. Add a second case with an `opened` event by `dana` followed by an `accepted` event by `sam` and assert the row's `author_id` equals the person id that `opened` resolved (query `person` for the `gitlab_login`/handle column the people store uses — read `people/person-store.ts` for the column name; do not guess it).

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/gateway/src/connectors/_lib/gitlab/events.test.ts`
Expected: FAIL — no `author_login`; `meta_v` present; approver credited.

- [ ] **Step 3: Implement** in `events.ts`:

Extend `GitlabEventUpsertFields`-independent mapper input and add author carry:

```ts
type MrAuthor = { readonly login: string; readonly name?: string | undefined };

function storedAuthor(stored: Record<string, unknown> | null): MrAuthor | undefined {
  if (stored === null) {
    return undefined;
  }
  const login = stored["author_login"];
  if (typeof login !== "string" || login === "") {
    return undefined;
  }
  const name = stored["author_name"];
  return { login, name: typeof name === "string" && name !== "" ? name : undefined };
}

function withAuthor(out: Record<string, unknown>, author: MrAuthor | undefined): Record<string, unknown> {
  if (author === undefined) {
    return out;
  }
  return {
    ...out,
    author_login: author.login,
    ...(author.name === undefined ? {} : { author_name: author.name }),
  };
}

/**
 * A row whose state is still unknown after carry-forward has recovered nothing; stamping it with
 * the contract version would tell `nimbus index rebody` it is done.
 */
function withoutVersionIfStateless(out: Record<string, unknown>): Record<string, unknown> {
  if ("state" in out) {
    return out;
  }
  const { meta_v: _dropped, ...rest } = out;
  return rest;
}
```

Change `gitlabMrMetadata`'s `f` type to add `readonly author?: MrAuthor;`, and in each of its three return paths wrap the result: `return withoutVersionIfStateless(withAuthor(buildPrMetadata(raw, {...}), f.author ?? storedAuthor(stored)));`. (If Biome flags the unused `_dropped` binding, use the repo's existing idiom for omitting a key — search for `const { ` destructure-omit patterns under `packages/gateway/src` — or `Object.fromEntries(Object.entries(out).filter(([k]) => k !== "meta_v"))`.)

In `upsertGitlabEventItem`, for `shape.type === "pr"`:

```ts
  // The MR author is known only when THIS write describes the MR itself: the `opened` event
  // (its actor opened the MR) or `fetchOne` (the MR resource's own `author`). Every other event's
  // actor is whoever approved, merged or commented — never credit them as the author.
  const knownAuthor =
    shape.type === "pr" &&
    (f.mr !== undefined || actionName === "opened") &&
    authorUsername !== undefined &&
    authorUsername !== ""
      ? { login: authorUsername, name: authorName }
      : undefined;
```

pass `...(knownAuthor === undefined ? {} : { author: knownAuthor })` into the `gitlabMrMetadata` call, and resolve `authorId` for `pr` rows from the metadata, not the actor:

```ts
  const prAuthorLogin = shape.type === "pr" ? meta["author_login"] : undefined;
  const authorLogin =
    shape.type === "pr" ? (typeof prAuthorLogin === "string" ? prAuthorLogin : undefined) : authorUsername;
  const authorDisplay =
    shape.type === "pr" ? (typeof meta["author_name"] === "string" ? meta["author_name"] : undefined) : authorName;
  const authorId =
    authorLogin !== undefined && authorLogin !== ""
      ? ctx.resolvePerson({ gitlabLogin: authorLogin, displayName: authorDisplay ?? authorLogin })
      : null;
```

Issue rows (`shape.type === "issue"`) keep their current behaviour exactly. Confirm `gitlab-sync.ts`'s fetchOne passes `mr.author.username`/`mr.author.name` as `authorUsername`/`authorName` (the dossier says it does, ~141–143); if so no change there.

- [ ] **Step 4: Run tests**

Run: `bun test packages/gateway/src/connectors/_lib/gitlab packages/gateway/src/connectors/gitlab-sync.test.ts packages/gateway/src/connectors/lane-contract-drift.test.ts packages/gateway/src/connectors/lane-contract-collisions.test.ts`
Expected: PASS. If the drift test's GitLab case fails because `author_login` is not a canonical key, it should not: the drift test filters to `CANONICAL_PR_KEYS`. If the collisions test's GitLab row (an `accepted` event with no stored row) now lacks `meta_v`, that is correct only if it has no state — it HAS state (`merged`), so `meta_v` stays.

- [ ] **Step 5: Commit** — message `fix(gitlab): credit a merge request to its author, not to whoever acted on it last`.

---

### Task 3: CI runs are refreshed until they finish

**Files:**
- Create: `connectors/ci-run-refresh.ts`
- Modify: `connectors/github-actions-sync.ts` (`tryUpsertGithubActionsRun` guard ~140), `connectors/circleci-sync.ts` (`tryUpsertCircleciPipeline` guard ~136), `connectors/jenkins-sync.ts` (`upsertJenkinsBuildRowIfNew` guard ~178), `connectors/_lib/gitlab/pipelines.ts` (`tryUpsertGitlabPipelineItem` ~61–63 and its caller loop ~108–110)
- Test: `connectors/ci-run-refresh.test.ts` (new) + one case per writer in its existing test file (`packages/gateway/test/unit/connectors/github-actions-sync.test.ts`, `connectors/circleci-sync.coverage.test.ts`, `connectors/jenkins-sync.test.ts`, `connectors/_lib/gitlab/pipelines.test.ts`)

**Interfaces:**
- Consumes: `itemPrimaryKey(service, externalId)` (`index/item-key.ts`); `SyncContext["itemMetadata"]`.
- Produces: `export function storedRunIsUnfinished(itemMetadata: SyncContext["itemMetadata"], service: string, externalId: string): boolean`

- [ ] **Step 1: Write the failing tests**

```ts
// connectors/ci-run-refresh.test.ts
import { expect, test } from "bun:test";

import { storedRunIsUnfinished } from "./ci-run-refresh.ts";

const meta = (json: string | null) => (_id: string): string | null => json;

test("a stored run whose canonical conclusion is running is unfinished", () => {
  expect(storedRunIsUnfinished(meta(JSON.stringify({ conclusion: "running" })), "github_actions", "a/b#run-1")).toBe(true);
});
test("finished, unknown, missing and malformed rows are not", () => {
  for (const json of [
    JSON.stringify({ conclusion: "failure" }),
    JSON.stringify({ conclusion: "unknown" }),
    JSON.stringify({}),
    "not json",
    null,
  ]) {
    expect(storedRunIsUnfinished(meta(json), "github_actions", "a/b#run-1")).toBe(false);
  }
});
test("it looks up the row by the same primary key the writer uses", () => {
  let asked = "";
  storedRunIsUnfinished((id) => { asked = id; return null; }, "jenkins", "job#7");
  expect(asked).toBe("jenkins:job#7");
});
```

Check `index/item-key.ts`'s `itemPrimaryKey` format before trusting `"jenkins:job#7"`; assert whatever `itemPrimaryKey("jenkins", "job#7")` returns by calling it in the test instead of hard-coding, if the format differs.

Per writer, add one test in its existing file using that file's sync harness: first sync returns run/pipeline/build N in progress (GitHub Actions `status: "in_progress"`; GitLab `status: "running"`; Jenkins `building: true`), second sync returns the SAME N finished with a failure; assert the stored row's `conclusion` is now `failure`, and that the cursor did not move backwards. For CircleCI (whose canonical conclusion is never `running`) add instead a test that a previously seen `created` pipeline is NOT re-upserted (no wasted write). For GitLab also assert the second sync made the same number of HTTP requests as the first (no extra pages).

Add the Review Focus #3 case to the GitHub Actions file: first sync stores run 5 as `in_progress`; second sync's list no longer contains run 5 (only newer runs); assert run 5 is still `running` and the second sync made exactly one runs-list request per repo.

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/gateway/src/connectors/ci-run-refresh.test.ts` (FAIL: module missing) and each writer test file (FAIL: still `running`).

- [ ] **Step 3: Implement**

```ts
// connectors/ci-run-refresh.ts
/**
 * CI writers skip any run at or below their cursor. A run first synced while still running would
 * therefore stay `conclusion: "running"` forever — and preflight would let that row hide an older
 * failure. A previously seen run is re-written only when its stored canonical conclusion is
 * `running` and the provider's EXISTING fetch returned it again; this never makes a request.
 */
import { itemPrimaryKey } from "../index/item-key.ts";
import type { SyncContext } from "../sync/types.ts";
import { asRecord } from "./unknown-record.ts";

export function storedRunIsUnfinished(
  itemMetadata: SyncContext["itemMetadata"],
  service: string,
  externalId: string,
): boolean {
  const json = itemMetadata(itemPrimaryKey(service, externalId));
  if (json === null) {
    return false;
  }
  try {
    return asRecord(JSON.parse(json) as unknown)?.["conclusion"] === "running";
  } catch {
    return false;
  }
}
```

(Match the import paths/names to the real `SyncContext` export and `asRecord` location — `connectors/unknown-record.ts`.)

GitHub Actions — compute `externalId` before the guard and change

```ts
  if (id === undefined || id <= lastSeen) {
    return { upserted: 0, runId: null };
  }
```

to

```ts
  if (id === undefined) {
    return { upserted: 0, runId: null };
  }
  const externalId = `${full}#run-${String(id)}`;
  if (id <= lastSeen && !storedRunIsUnfinished(ctx.itemMetadata, SERVICE_ID, externalId)) {
    return { upserted: 0, runId: null };
  }
```

(remove the later duplicate `externalId` declaration). The floor check stays where it is. The caller's `maxId = Math.max(...)` must not move the cursor backwards — verify it uses `Math.max`.

CircleCI and Jenkins: the same shape, with their own external ids (`${slug}#p${num}`; `jenkinsBuildExternalId(job.fullName, num)`). Keep each guard's existing return value for the skip case.

GitLab: `tryUpsertGitlabPipelineItem` returns `{ kind: "break" }` at `id <= lastSeen`. Change it to: if `id <= lastSeen` and the stored run is NOT unfinished → `{ kind: "seen" }` (new variant); if it IS unfinished → fall through and upsert. In the caller loop, treat `"seen"` as "skip this item, and do not fetch another page after this one" — read the loop first; if it fetches only one page today, `"seen"` simply continues to the next item of the page. The per-sync request count must not increase.

- [ ] **Step 4: Run tests**

Run: `bun test packages/gateway/src/connectors/ci-run-refresh.test.ts packages/gateway/test/unit/connectors/github-actions-sync.test.ts packages/gateway/src/connectors/circleci-sync.coverage.test.ts packages/gateway/test/unit/connectors/circleci-sync.test.ts packages/gateway/src/connectors/jenkins-sync.test.ts packages/gateway/src/connectors/jenkins-sync.coverage.test.ts packages/gateway/src/connectors/_lib/gitlab/pipelines.test.ts packages/gateway/src/connectors/gitlab-sync.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit** — message `fix(ci): refresh a CI run synced mid-run until it finishes`.

---

### Task 4: `ci_not_evaluable` — one helper, and preflight uses it

**Files:**
- Create: `metrics/ci-evaluability.ts`, `metrics/ci-evaluability.test.ts`
- Modify: `preflight/preflight.ts` (`PreflightGap` ~6–15, `selectFailingCiRuns` return ~213, finding `head_sha` ~209)
- Modify: `packages/gateway/openapi/v1.yaml` (`PreflightGap` enum ~481–492)
- Test: `preflight/preflight.test.ts` (provider cases ~612–663)

**Interfaces:**
- Consumes: `CI_RUN_EMITTED_KEYS`, `CI_RUN_NO_SUCCESS_SIGNAL`, `type CiRunService` (`connectors/ci-run-meta.ts`); `distinctCiServiceColumns`, `type ParsedDoraRepoUrn` (`metrics/dora-config.ts`).
- Produces: `export type CiEvaluationUse = "preflight_failing_runs" | "dora_deploys"`; `export function unevaluableCiServices(repos: readonly ParsedDoraRepoUrn[], use: CiEvaluationUse): string[]`; `PreflightGap` gains `"ci_not_evaluable"`.

- [ ] **Step 1: Write the failing tests**

```ts
// metrics/ci-evaluability.test.ts
import { describe, expect, test } from "bun:test";

import { parseDoraRepoUrn } from "./dora-config.ts";
import { unevaluableCiServices } from "./ci-evaluability.ts";

const repos = (...urns: string[]) => urns.map(parseDoraRepoUrn);

describe("unevaluableCiServices", () => {
  test("preflight cannot judge jenkins (no branch), circleci (no pass/fail) or bitbucket (no writer)", () => {
    expect(unevaluableCiServices(repos("jenkins:deploy", "circleci:gh/a/b", "bitbucket:a/b"), "preflight_failing_runs").sort())
      .toEqual(["bitbucket", "circleci", "jenkins"]);
  });
  test("DORA deploy detection can judge jenkins but not circleci or bitbucket", () => {
    expect(unevaluableCiServices(repos("jenkins:deploy", "circleci:gh/a/b", "bitbucket:a/b"), "dora_deploys").sort())
      .toEqual(["bitbucket", "circleci"]);
  });
  test("github actions and gitlab are evaluable for both uses", () => {
    expect(unevaluableCiServices(repos("github:a/b", "gitlab:g/p"), "preflight_failing_runs")).toEqual([]);
    expect(unevaluableCiServices(repos("github:a/b", "gitlab:g/p"), "dora_deploys")).toEqual([]);
  });
});
```

Check `dora-config.ts` for the real URN parser name and URN syntax (the dossier shows `parseDoraRepoUrn`); use the existing preflight tests' URN strings as the model.

In `preflight.test.ts`, update the provider cases: Jenkins → `count: 0`, `gap: "ci_not_evaluable"`; CircleCI errored → `count: 1`, `gap: "ci_not_evaluable"`; Bitbucket → `count: 0`, `gap: "ci_not_evaluable"`; GitLab and GitHub Actions only → `gap: null`. Rebuild the still hand-written GitLab case (~612–621) with `gitlabPipelineMetadata("group/proj", { id: 1, status: "failed", ref: "main" })`. Add Review Focus #1:

```ts
test("a service bound to GitHub Actions and Jenkins reports the Actions failure AND the gap", () => {
  // insert a failing GitHub Actions run (insertGhRun, the file's real-mapper helper) for the
  // service's GitHub repo on the target branch; bind the service to that github URN plus a
  // jenkins URN; expect failing_ci_runs.count === 1 and failing_ci_runs.gap === "ci_not_evaluable".
});
```

Write it as a real test using the file's existing `insertGhRun` and ServiceConfig builder.

Add a test that a finding's `head_sha` comes from canonical `head_sha` for a GitLab pipeline row (built with `gitlabPipelineMetadata(..., { sha: "abc123" })`) — today it is `null` because the reader uses raw `headSha`.

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/gateway/src/metrics/ci-evaluability.test.ts packages/gateway/src/preflight/preflight.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// metrics/ci-evaluability.ts
/**
 * Which CI providers bound to a service the index cannot judge, per use. DERIVED from A1's
 * contract tables, so a writer that starts emitting `branch` (or a success signal) flips its
 * provider to evaluable with no edit here:
 *   - no writer at all (`bitbucket` has no `ci_run` writer) → unevaluable for every use;
 *   - preflight's failing-runs check filters on `branch` and needs pass/fail → a provider that
 *     emits no `branch` (Jenkins) or has no success signal (CircleCI) is unevaluable;
 *   - DORA deploy detection needs a success signal (Jenkins matches on `jobName`, so no branch
 *     is fine).
 * Callers turn a non-empty result into the `ci_not_evaluable` gap; it never changes a verdict.
 */
import {
  CI_RUN_EMITTED_KEYS,
  CI_RUN_NO_SUCCESS_SIGNAL,
  type CiRunService,
} from "../connectors/ci-run-meta.ts";
import { distinctCiServiceColumns, type ParsedDoraRepoUrn } from "./dora-config.ts";

export type CiEvaluationUse = "preflight_failing_runs" | "dora_deploys";

function isCiRunService(s: string): s is CiRunService {
  return Object.hasOwn(CI_RUN_EMITTED_KEYS, s);
}

function evaluable(service: string, use: CiEvaluationUse): boolean {
  if (!isCiRunService(service) || CI_RUN_NO_SUCCESS_SIGNAL.has(service)) {
    return false;
  }
  return use === "dora_deploys" || CI_RUN_EMITTED_KEYS[service].has("branch");
}

export function unevaluableCiServices(
  repos: readonly ParsedDoraRepoUrn[],
  use: CiEvaluationUse,
): string[] {
  return distinctCiServiceColumns(repos).filter((s) => !evaluable(s, use));
}
```

If importing `connectors/ci-run-meta.ts` from `metrics/` violates a dependency rule (`bun run audit:boundaries` / dependency-cruiser), stop and report — do not copy the tables.

`preflight.ts`: add `| "ci_not_evaluable"` to `PreflightGap`; at the end of `selectFailingCiRuns` replace `return { count, findings, gap: null };` with

```ts
  // A bound provider this check cannot judge is DISCLOSED, never silently read as clean. It does
  // not change the verdict (a user decision): the gap rides beside any real findings.
  const gap: PreflightGap =
    unevaluableCiServices(cfg.repos, "preflight_failing_runs").length > 0 ? "ci_not_evaluable" : null;
  return { count, findings, gap };
```

and the `head_sha` line with

```ts
        head_sha:
          typeof meta["head_sha"] === "string"
            ? meta["head_sha"]
            : typeof meta["headSha"] === "string" // rows written before the contract (A1)
              ? meta["headSha"]
              : null,
```

OpenAPI: add `ci_not_evaluable` to the `PreflightGap` enum (keep alphabetical/existing order convention of that list).

- [ ] **Step 4: Run tests**

Run: `bun test packages/gateway/src/metrics/ci-evaluability.test.ts packages/gateway/src/preflight packages/gateway/test/unit/preflight packages/gateway/src/ipc/preflight-rpc.test.ts`
Expected: PASS. Then `bun run audit:boundaries` (if the script exists) must pass.

- [ ] **Step 5: Commit** — message `feat(preflight): disclose CI providers the index cannot evaluate`.

---

### Task 5: DORA — `ci_not_evaluable`, canonical `head_sha`, real-writer fixtures

**Files:**
- Modify: `metrics/dora.ts` (`DoraGap` ~5–16, `deploymentFrequency` ~148–175, `buildDeployIndex` ~189–196)
- Modify: `packages/gateway/openapi/v1.yaml` (DORA gap enum ~372–387, and the stats gap enum ~430 if it lists DORA members)
- Modify fixtures: `metrics/dora.test.ts` (`insertCiRun` ~112–125), `metrics/dora.coverage.test.ts` (~131–146), `packages/gateway/test/unit/metrics/dora.test.ts` (`seedCiRun`/`seedPr` ~28–67), `packages/gateway/test/integration/metrics/dora-deployment-source.test.ts` (~65–74), `packages/gateway/test/fixtures/preflight/payment-service/seed.ts` (~90–153)

**Interfaces:**
- Consumes: `unevaluableCiServices(repos, "dora_deploys")` (Task 4).
- Produces: `DoraGap` gains `"ci_not_evaluable"` (and therefore `StatsGap`).

- [ ] **Step 1: Write the failing tests** (in `metrics/dora.test.ts`)

```ts
test("a CircleCI-only service reports ci_not_evaluable, not no_deployment_data", () => {
  // bind cfg to a circleci URN; insert a CircleCI pipeline row built with circleciPipelineMetadata
  // (state "created") whose title matches the deploy pattern; expect deploymentFrequency(...).gap
  // === "ci_not_evaluable" and value === null.
});
test("lead time matches a GitLab deploy by canonical head_sha", () => {
  // Not possible end to end (GitLab MRs carry no merge_commit_sha). Instead pin buildDeployIndex
  // indirectly: a GitHub Actions deploy row whose metadata has canonical head_sha but NO raw
  // headSha (strip it from githubActionsRunMetadata output) still matches a GitHub PR's
  // merge_commit_sha — expect a non-null lead time.
});
test("DORA lead time is non-null over real-writer rows", () => {
  // githubActionsRunMetadata("acme/app", {id: 1, name: "Deploy prod", status: "completed",
  //   conclusion: "success", head_branch: "main", head_sha: "m1", created_at: <T+1h>}, NOW)
  // extractPrMetadataForIndex("acme/app", {number: 7, state: "closed", merged: true,
  //   created_at: <T-1d>, merged_at: <T>, merge_commit_sha: "m1"})
  // expect leadTimeForChanges(...).value to be a positive number.
});
```

Write all three as real tests using the file's helpers. Rebuild `insertCiRun` (and the other listed fixtures) so their `metadata` comes from `githubActionsRunMetadata` / `extractPrMetadataForIndex`, keeping every existing test's intent and expected numbers. If an expected number would have to change, stop and report — a changed DORA number means the fixture was hiding a real reader difference.

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/gateway/src/metrics/dora.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `DoraGap`: add `| "ci_not_evaluable"`.
- `deploymentFrequency`: after `selectDeploys`, compute `const unevaluable = unevaluableCiServices(cfg.repos, "dora_deploys");`. In the `regex.length === 0` (and no annotated) branch return `gap: unevaluable.length > 0 && unevaluable.length === distinctCiServiceColumns(cfg.repos).length ? "ci_not_evaluable" : "no_deployment_data"`. In the regex-based success branch pass `gap: unevaluable.length > 0 ? "ci_not_evaluable" : null` into `gapOrNull` — read `gapOrNull` first and keep its precedence (e.g. `low_sample`) unchanged; state in a comment which gap wins and why.
- `buildDeployIndex`: read `meta["head_sha"]`, falling back to raw `meta["headSha"]` for pre-A1 rows (same shape as Task 4's finding fix).
- OpenAPI: add `ci_not_evaluable` to the DORA gap enum and to the stats gap enum if it enumerates DORA members.

- [ ] **Step 4: Run tests**

Run: `bun test packages/gateway/src/metrics packages/gateway/test/unit/metrics packages/gateway/test/integration/metrics packages/gateway/test/e2e` (e2e: only the metrics/preflight/dora files — find them with `ls packages/gateway/test/e2e | grep -i -E "dora|preflight|metric"`) plus the payment-service consumers named in the dossier (`preflight-real-db`, `metrics-rpc`, `preflight-rpc`, http preflight/dora/stats route tests — find with `git grep -l payment-service packages/gateway/test`).
Expected: PASS, and `expected-envelope.json` unchanged. If the envelope changes, stop and report.

- [ ] **Step 5: Commit** — message `feat(dora): disclose unevaluable CI and match deploys on the canonical head sha`.

---

### Task 6: `pr-merges` counts GitLab; `incomplete_merge_data`

**Files:**
- Modify: `metrics/stats.ts` (`StatsGap` ~22, doc ~119–124, `prMerges` ~125–179)
- Modify: `packages/gateway/openapi/v1.yaml` (stats gap enum ~430 — ADD `incomplete_merge_data`, KEEP `github_only_merge_data`)
- Modify: `packages/cli/src/commands/stats.ts` (comment ~209 naming the gap; any gap→text map)
- Modify: `agents/changelog.ts` (~178), `agents/standup.ts` (~300) remediation strings; comments in `agents/changelog-queries.ts` (~306), `agents/standup-queries.ts` (~339)
- Test: `metrics/stats.test.ts` (`insertPr` ~29–36, gap cases ~120–142); changelog/standup tests that assert the remediation text

**Interfaces:**
- Produces: `StatsGap` gains `"incomplete_merge_data"`; `github_only_merge_data` stays in the union, documented as no longer emitted.

- [ ] **Step 1: Write the failing tests** (in `metrics/stats.test.ts`; rebuild `insertPr` to take the mapper output — `insertPr(db, id, service, metadata)`)

```ts
test("pr-merges counts a GitLab MR merged in the window", () => {
  // bind cfg to github:acme/app and gitlab:grp/svc. Insert one GitHub PR via
  // extractPrMetadataForIndex("acme/app", {number:1, state:"closed", merged:true, merged_at:<in window>})
  // and one GitLab MR via gitlabMrMetadata({pathWithNamespace:"grp/svc", iid:2, actionName:"accepted",
  // eventCreatedAt:<in window>}, null). Expect value 2 and gap "incomplete_merge_data".
});
test("a GitLab merge outside the window is not counted and the gap stays", () => {
  // same binding, GitLab accepted event BEFORE the window start → value 1 (GitHub only), gap
  // "incomplete_merge_data" (Review Focus #4).
});
test("a Jenkins binding beside GitHub does not mark merge data incomplete", () => {
  // bind github:acme/app + jenkins:deploy → gap null when there are merges (was github_only_merge_data).
});
test("a Bitbucket-only service reports incomplete_merge_data, not no_repos", () => {});
test("stats never emits github_only_merge_data any more", () => {
  // run the gap-producing scenarios above and assert none returns "github_only_merge_data".
});
```

Write each as a real test. Existing GitHub-only cases keep their expected values.

- [ ] **Step 2: Run to verify failure** — `bun test packages/gateway/src/metrics/stats.test.ts` → FAIL.

- [ ] **Step 3: Implement** — replace `prMerges`' body:

```ts
  // Merge counts come from the two forges that record a merge time on the PR row: GitHub always,
  // GitLab from its `accepted`/`merged` events (only for merges inside the synced window).
  // Bitbucket never records one. `service` is matched per forge so an `owner/name` shared across
  // forges is never counted twice.
  const githubRepos = cfg.repos.filter((r) => r.provider === "github").map((r) => r.providerId);
  const gitlabRepos = cfg.repos.filter((r) => r.provider === "gitlab").map((r) => r.providerId);
  const incomplete = cfg.repos.some((r) => r.provider === "gitlab" || r.provider === "bitbucket");
  if (githubRepos.length === 0 && gitlabRepos.length === 0) {
    return {
      value: null,
      unit: "merges",
      sample: 0,
      gap: incomplete ? "incomplete_merge_data" : "no_repos",
    };
  }
  const forgeClauses: string[] = [];
  const params: Array<string | number> = [];
  if (githubRepos.length > 0) {
    forgeClauses.push(`(service = 'github' AND json_extract(metadata, '$.repo') IN (${githubRepos.map(() => "?").join(",")}))`);
    params.push(...githubRepos);
  }
  if (gitlabRepos.length > 0) {
    forgeClauses.push(`(service = 'gitlab' AND json_extract(metadata, '$.repo') IN (${gitlabRepos.map(() => "?").join(",")}))`);
    params.push(...gitlabRepos);
  }
  const row = db
    .query(
      `SELECT COUNT(*) AS c FROM item
       WHERE type = 'pr'
         AND json_valid(metadata)
         AND (${forgeClauses.join(" OR ")})
         AND json_extract(metadata, '$.merged_at') IS NOT NULL
         AND json_extract(metadata, '$.merged_at') >= ?
         AND json_extract(metadata, '$.merged_at') < ?`,
    )
    .get(...params, startMs, endMs) as { c: number } | null;
  const count = row?.c ?? 0;
  const gap: StatsGap | null = incomplete ? "incomplete_merge_data" : null;
  if (count === 0) {
    return { value: null, unit: "merges", sample: 0, gap: gap ?? "low_sample" };
  }
  return { value: count, unit: "merges", sample: count, gap };
```

Keep the existing `json_valid` comment, adapted. Update the doc comment (~119–124) and `StatsGap` (add `| "incomplete_merge_data"`, and a comment that `github_only_merge_data` is retained for API compatibility but no longer emitted). Replace the remediation string in `changelog.ts` and `standup.ts` with ``"Track this as the same substrate gap `nimbus stats` reports as `incomplete_merge_data`."`` and update the two queries-file comments. If a changelog/standup test asserts the old remediation text, update the asserted string.

- [ ] **Step 4: Run tests** — `bun test packages/gateway/src/metrics packages/gateway/src/agents/changelog.test.ts packages/gateway/src/agents/standup.test.ts packages/cli/src/commands` → PASS.

- [ ] **Step 5: Commit** — message `feat(stats): count GitLab merges and disclose incomplete merge data`.

---

### Task 7: changelog and standup — real-writer fixtures and brief-level forge tests

**Files:**
- Modify (tests only): `agents/changelog.test.ts` (`insertPr`/`insertCiRun` ~50–80; GitLab rows ~130–142, ~255–272), `agents/standup.test.ts` (`insertItem` ~53–80; GitLab ~235–256; GitHub ~323–332), `packages/gateway/test/integration/changelog-queries.test.ts`, `changelog-queries.coverage.test.ts`, `standup-queries.test.ts`, and the e2e changelog/standup scenarios (find with `git grep -l -E "changelog|standup" packages/gateway/test/e2e`)

**Interfaces:**
- Consumes: the mappers (Global Constraints).

- [ ] **Step 1:** Rebuild every `pr`/`ci_run` fixture in the listed files from the mappers, keeping each test's intent and expected values. Hand-written GitLab `{state: "merged"}` rows become `gitlabMrMetadata({..., actionName: "accepted", eventCreatedAt}, null)` — note such a row now HAS `merged_at`, so a test that expected it in the "non-GitHub merges not listed" count must now expect it LISTED instead; that is the A1 behaviour change, and it is the one place an expected value may change — say so per test in the report.
- [ ] **Step 2:** Add brief-level tests (spec §4.1): a changelog brief over one Bitbucket merged PR (`bitbucketPrMetadata(..., {state: "MERGED"})`) and one GitLab merged MR lists the GitLab MR and reports the Bitbucket one in `## Gaps`; the same for standup with the owner as author.
- [ ] **Step 3: Run** — `bun test packages/gateway/src/agents/changelog.test.ts packages/gateway/src/agents/standup.test.ts packages/gateway/test/integration packages/gateway/test/e2e` (e2e: only the changelog/standup files) → PASS.
- [ ] **Step 4: Commit** — message `test(agents): changelog and standup fixtures come from the real writers`.

---

### Task 8: premortem — per-forge review-drag disclosure

**Files:**
- Modify: `agents/premortem.ts` (`CohortPrTiming` ~159, cohort select ~178–180, `reviewDragMedians` ~216–263, stale comment ~117–121), `premortem/risks.ts` (`computeReviewDrag` ~123–160, `computeRisks` ~280–310)
- Test: `premortem/risks.test.ts` (~193–229), `agents/premortem.test.ts` (fixtures ~83–193, ~639–702; HONESTY NOTE ~74–81, ~139–141)

**Interfaces:**
- Produces: `computeReviewDrag` input replaces `cohortHasPrsMissingTimingData: boolean` with `forgesMissingTiming: readonly string[]` (distinct `item.service` values of cohort PRs lacking `opened_at_ms` or `merged_at`; empty = none). `reviewDragMedians` returns `forgesMissingTiming` instead of the boolean; `CohortPrTiming` gains `service: string`.

- [ ] **Step 1: Write the failing tests** (replace the `:193–203` case in `risks.test.ts`; keep the `:209–218` negative assertions and the `:220–229` "No pull requests were found" case)

```ts
test("review drag names each forge whose PRs lack timing, with the reason", () => {
  const r = computeReviewDrag({
    reviewDragMedianMs: null,
    repoReviewMedianMs: 3_600_000,
    forgesMissingTiming: ["bitbucket", "gitlab"],
  });
  expect(r.value).toBeNull();
  expect(r.summary).toContain("Bitbucket never records a merge time");
  expect(r.summary).toContain("GitLab");
  expect(r.summary).not.toContain("GitHub");
});
test("a GitHub-only gap names re-sync as the recovery", () => {
  const r = computeReviewDrag({ reviewDragMedianMs: null, repoReviewMedianMs: null, forgesMissingTiming: ["github"] });
  expect(r.summary).toContain("nimbus index rebody");
});
```

If `computeReviewDrag` is not exported, test through `computeRisks` the way the existing tests do.

- [ ] **Step 2: Run to verify failure** — `bun test packages/gateway/src/premortem/risks.test.ts` → FAIL.

- [ ] **Step 3: Implement** — in `risks.ts`:

```ts
const FORGE_TIMING_REASON: Readonly<Record<string, string>> = {
  bitbucket: "Bitbucket never records a merge time.",
  gitlab: "GitLab records opened and merged times only for merge requests whose open or merge event falls inside the synced window.",
  github: "GitHub pull requests indexed before this release carry no opened time until re-synced (`nimbus index rebody --service github`).",
};

function missingTimingSummary(forges: readonly string[]): string {
  const reasons = forges.map((f) => FORGE_TIMING_REASON[f] ?? `${f} pull requests carry no opened or merged time.`);
  return (
    "Review drag cannot be measured: this cohort has linked pull requests, but none records both " +
    `an opened and a merged timestamp. ${reasons.join(" ")}`
  );
}
```

`computeReviewDrag`: `const summary = input.forgesMissingTiming.length > 0 ? missingTimingSummary(input.forgesMissingTiming) : "No pull requests were found for this cohort, so review drag cannot be measured.";` — keep the existing sentence's "does not record both an opened and a merged" fragment only if another test still asserts it (search first); otherwise the new wording stands. Update the doc comment on the input field.

`premortem.ts`: add `pr_item.service AS service` to the cohort select and `service: string` to `CohortPrTiming`; in `reviewDragMedians` compute `forgesMissingTiming = [...new Set(timings.filter((t) => t.opened_at_ms === null || t.merged_at === null).map((t) => t.service))].sort()` and return it in place of the boolean; `computeRisks` passes it through. Fix the stale comment at ~117–121 (GitLab MR rows now carry canonical `repo`).

`premortem.test.ts`: rebuild `seedChildWithPr` / `seedChildWithGitlabMr` metadata via `extractPrMetadataForIndex` / `gitlabMrMetadata`, keep the graph wiring, update the HONESTY NOTE comments (~74–81, ~139–141) to describe what the writers emit now, and add (spec §4.1) a case where review drag is non-null over real-writer GitHub PRs and a case where a Bitbucket-linked cohort names Bitbucket.

- [ ] **Step 4: Run** — `bun test packages/gateway/src/premortem packages/gateway/src/agents/premortem.test.ts` (and `packages/gateway/test` files matching `premortem`) → PASS.
- [ ] **Step 5: Commit** — message `feat(premortem): name the forge behind unmeasurable review drag`.

---

### Task 9: negotiate — `mergedCoverage`

**Files:**
- Modify: `agents/negotiate.ts` (`accumulateAuthoredPrStats` ~363–392, lane return ~421–427, doc ~353–361), `agents/_lib/negotiate-types.ts` (`NegotiateAuthoredPrs` ~153–164), `agents/_lib/render.ts` (~777–800)
- Test: `agents/negotiate.test.ts` (`seedPr` ~17–34)

**Interfaces:**
- Produces: `NegotiateAuthoredPrs` gains `mergedCoverage: NegotiateCoverage` (`{ covered, total }`; `covered` = rows whose `metadata.merged` is a boolean).

- [ ] **Step 1: Write the failing test**

```ts
test("the merged count discloses PRs whose merge status the index does not know", () => {
  // seed two authored PRs for the person: one GitHub (extractPrMetadataForIndex, merged) and one
  // GitLab first seen through an `approved` event (gitlabMrMetadata(..., actionName:"approved"), null)
  // → no state, no `merged`. Expect lane.merged === 1, lane.mergedCoverage === { covered: 1, total: 2 },
  // and the rendered line to contain "merge status known for 1/2".
});
```

Write it with the file's existing seeding/graph idiom; switch `seedPr` to mapper output.

- [ ] **Step 2: Run to verify failure** — FAIL.
- [ ] **Step 3: Implement** — count `typeof meta["merged"] === "boolean"` as covered alongside `merged`; return `mergedCoverage: { covered: mergedKnown, total: rows.length }`; in `render.ts` after `` `- ${a.count} PR(s), ${a.merged} merged` `` append `` ` (merge status known for ${a.mergedCoverage.covered}/${a.mergedCoverage.total})` `` when `covered < total`, mirroring the `statsCoverage` suffix. Replace the doc note at ~353–361 that says a `mergedCoverage` field "is the fix". Grep for every other constructor/consumer of `NegotiateAuthoredPrs` (fleet digest extractor, HTTP/MCP schema, fixtures) — `git grep -n "statsCoverage" packages/gateway` — and add the field everywhere `statsCoverage` appears. Do not add a `Disclosure`/anchor (the suffix is unanchored like `statsCoverage`), and confirm `brief-disclosures.test.ts`'s negotiate count (5) is unchanged.
- [ ] **Step 4: Run** — `bun test packages/gateway/src/agents/negotiate.test.ts packages/gateway/src/agents/_lib packages/gateway/src/fleet` → PASS.
- [ ] **Step 5: Commit** — message `feat(negotiate): disclose how many authored PRs have a known merge status`.

---

### Task 10: expert — the commit-authorship lane reads filesystem commits

**Files:**
- Modify: `agents/expert.ts` (`subBlame` ~358–384)
- Test: `agents/expert.test.ts` (subBlame cases ~597–660, `makePopulatedDb` ~545–556), `packages/gateway/test/e2e/scenarios/expert.e2e.test.ts` (~21–31)
- Modify: `scripts/structure-audit/check-index-lane-coverage.acceptance.test.ts` (the `expert.ts`'s dead `'commit'` case)

**Interfaces:**
- Consumes: `buildGitCommitMetadata` (`connectors/git-commit-meta.ts`); `GapNote` (`agents/_lib/gap-notes.ts`).

- [ ] **Step 1: Write the failing tests** (replace the `github`/`commit` subBlame cases)

```ts
test("subBlame credits the resolved author of a matching filesystem commit", () => {
  // insert a person (alice) and a filesystem git_commit row: author_id = alice's id, title
  // "Fix retry loop", body_preview = sha, metadata = buildGitCommitMetadata({repoRoot:"/r", sha, subject},
  // {authorEmail:"alice@example.com"}). Expect the lane to name alice for input "retry".
});
test("commits with no resolved author report missing_user_identity", () => {
  // git_commit rows exist but author_id is NULL and metadata has no author_email (a pre-A1 row).
  // Expect a gap with category "missing_user_identity" (Review Focus #5).
});
test("no indexed commits reports missing_entity_type naming gitAware", () => {
  // no git_commit rows at all → gap category "missing_entity_type", remediation mentions gitAware.
});
```

Plus one real-git test: create a temp git repo (copy the `filesystem-v2-sync.test.ts` "gitAware=true on a real git repo" setup — `mkdtempSync` under `tmpdir()`, `git init`, `user.email`, a commit), run `createFilesystemV2Syncable` over it with that file's context helper, then run the expert lane against the same DB and assert the person resolved from `user.email` is returned. Never touch real user data; temp dirs only.

- [ ] **Step 2: Run to verify failure** — FAIL.
- [ ] **Step 3: Implement** — `subBlame`:

```ts
function subBlame(db: Database, input: string): SubAgentResult {
  // Local git history is the only commit-level source the index holds: the filesystem connector's
  // `git_commit` rows, whose author is resolved from `git log`'s author email (index lane A1).
  const commits = db
    .query(
      `SELECT p.id AS person_id, COALESCE(p.display_name, p.id) AS display_name,
              i.id AS item_id, i.title AS title, i.modified_at AS modified_at, i.service AS service_id
         FROM item i
         JOIN person p ON p.id = i.author_id
        WHERE i.service = 'filesystem'
          AND i.type = 'git_commit'
          AND (i.title LIKE '%' || ? || '%' OR i.body_preview LIKE '%' || ? || '%')
        ORDER BY i.modified_at DESC
        LIMIT 50`,
    )
    .all(input, input) as ExpertLaneRow[];
  if (commits.length > 0) {
    return topLaneStream(commits, "commit_authored", 1);
  }
  return { ...commitLaneGap(db) };
}

function commitLaneGap(db: Database): { gap?: GapNote } {
  const counts = db
    .query(
      `SELECT COUNT(*) AS total, COUNT(author_id) AS attributed
         FROM item WHERE service = 'filesystem' AND type = 'git_commit'`,
    )
    .get() as { total: number; attributed: number };
  if (counts.total === 0) {
    return {
      gap: {
        category: "missing_entity_type",
        detail: "No local git commits are indexed, so commit authorship cannot inform this answer.",
        remediation: "Set `gitAware = true` on a `[[filesystem.roots]]` entry and sync.",
      },
    };
  }
  if (counts.attributed === 0) {
    return {
      gap: {
        category: "missing_user_identity",
        detail:
          "Indexed commits carry no resolved author: commits indexed before this release have none, " +
          "and a commit whose author email matches no known person stays unattributed.",
        remediation: "Run `nimbus index rebody --service filesystem` to re-read authors from git.",
      },
    };
  }
  return {};
}
```

Match `GapNote`'s exact field names to `agents/_lib/gap-notes.ts` (read it first) and use its constructors if it has them. Rewrite the e2e scenario's four `github`/`commit` rows as `filesystem`/`git_commit` rows with `author_id` set and `buildGitCommitMetadata` metadata, keeping its expected expert.

Census acceptance test: the `expert.ts`'s dead `'commit'` read no longer exists. Replace that case with one asserting the census flags no `commit` item-type read in `agents/expert.ts`, and — if the new `git_commit` read is reported unmatched — that this is the documented census blindness (the filesystem writer's `type: "git_commit"` literal is visible; check before asserting). Never weaken: the case must still fail if a dead `commit` read is re-introduced.

- [ ] **Step 4: Run** — `bun test packages/gateway/src/agents/expert.test.ts packages/gateway/test/e2e/scenarios/expert.e2e.test.ts scripts/structure-audit` → PASS.
- [ ] **Step 5: Commit** — message `fix(expert): credit commit authors from local git history`.

---

### Task 11: oncall wording, docs prose, CHANGELOG

**Files:**
- Modify: `agents/oncall.ts` (gap ~239–252), comments `agents/_lib/oncall-queries.ts` (~311–313), `agents/_lib/oncall-types.ts` (~101–112), `metrics/stats.ts` (any remaining comment claiming GitHub alone writes `merged_at`)
- Modify: `docs/cli-reference.md` (~962, ~1374–1377), `docs/roadmap.md` (~478, ~481, ~482, ~1450), `docs/CHANGELOG.md` (new dated entry)

- [ ] **Step 1:** oncall gap: detail → "No pull request could be matched to the deployment below. A deployment is matched to its change by merge commit, which only the GitHub connector records — GitLab and Bitbucket rows carry none, so on those forges this is always empty, and on GitHub it means the deploy carried a commit that no indexed pull request merged."; remediation → "Connect GitHub for this repository, or bind the deploy through `POST /v1/deployments` with its PR." (keep it a `GapNote`; update any oncall test asserting the old string).
- [ ] **Step 2:** Comments: replace "written by the GitHub connector alone / github-sync.ts ALONE" for `merged_at` everywhere it is now false (`git grep -n -i "merged_at" packages/gateway/src | grep -i -E "alone|only"`); `merge_commit_sha` remains GitHub-only and those comments stay accurate.
- [ ] **Step 3:** Docs. `cli-reference.md` is current-state: rewrite ~962 and the `pr-merges` bullet ~1374–1377 (GitLab now counted; `incomplete_merge_data`; Bitbucket never records a merge time). `roadmap.md` rows are dated delivery records: append a one-sentence reconciling note to each of ~478/481/482/1450 ("Superseded 2026-10-08 by the index lane contract: GitLab MR rows now carry `merged_at` …") rather than rewriting the record. Add `ci_not_evaluable` to the `nimbus preflight` / `nimbus metrics dora` gap descriptions in `cli-reference.md` if those sections enumerate gaps.
- [ ] **Step 4:** `docs/CHANGELOG.md`: a new dated entry (read the file's recent entries for format) listing the A2 user-visible changes: `ci_not_evaluable` (preflight + DORA, never a verdict change); stats counts GitLab merges and `incomplete_merge_data` replaces `github_only_merge_data` in output; premortem names the forge; negotiate `mergedCoverage`; expert's commit lane uses local git authors; GitLab MR authorship = MR author; CI runs synced mid-run are refreshed; `merged` no longer asserted for an unknown state.
- [ ] **Step 5: Run** — `bun run audit:doc-refs`, `bun run audit:status-drift` (findings inside `docs/superpowers/` are out of scope) and the oncall tests → PASS.
- [ ] **Step 6: Commit** — message `docs: GitLab merge times, unevaluable CI and the A2 reader changes`.

---

### Task 12: Verification

- [ ] **Step 1:** `bun run preflight:fast` — PASS (docs/superpowers findings excepted; report them).
- [ ] **Step 2:** `bun test packages/gateway packages/cli scripts` — the exact CI paths. PASS, except pre-existing sandbox-helper/toolgen failures in a fresh worktree, which must be shown identical on `main`.
- [ ] **Step 3:** `bun run typecheck` and `bun run typecheck:tests` — clean; if `typecheck:tests` reports an IMPROVEMENT, re-bank only that entry (the update script refuses on Windows; edit the single entry and say so).
- [ ] **Step 4:** `bun run audit:lane-census` then `git checkout docs/structure-audit/index-lane-census.json` — record the unmatched count (88 after A1).
- [ ] **Step 5:** `bun run audit:platform-test-gaps` — record.
- [ ] **Step 6:** Strip the spec and plan on a PR branch cut from the working branch, push, open the PR (title `feat(index): readers answer from the contract and disclose what they cannot (index lane A2)`), body ending with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. No `!`: no user action is required (the OpenAPI enums only gain values).
