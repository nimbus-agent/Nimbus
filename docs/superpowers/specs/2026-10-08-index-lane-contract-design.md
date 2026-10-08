# Index lane contract — design

**Date:** 2026-10-08 · **Status:** approved in conversation, awaiting written-spec review
**Closes:** roadmap Phase 4 row "B4 — Bug-hunt audit" (the gate half), pre-S3 close-out item A.
**Branch:** `dev/asaf/index-lane-contract` (this spec is stripped before the implementation PRs).

## 1. Problem

Production queries read `item.type` / `item.metadata.<key>` values that no connector writer
produces, so whole lanes are permanently empty and report as clean results. The B4 census
(`bun run audit:lane-census`) lists **83 unmatched item reads** plus **122 ambiguous reads**
(reads outside SQL with no type predicate). A hand triage of the 83 (2026-10-08) found:

| Verdict | Count |
|---|---|
| Real bug | 7 sites |
| Partial bug (some providers only, undisclosed) | 3 |
| Census blind spot (writer exists; helper-built / outside `WRITER_INCLUDE` / variable-held) | ~35 |
| Not an index read (API payload, writer assignment, test helper) | ~38 |

and confirmed a further bug the census does **not** list because its read is ambiguous:
`metrics/dora.ts` `selectDeploys` requires `meta.conclusion === "success"` plus a repo match,
which no CI writer satisfies (GitHub Actions has `conclusion` but no `repo`; CircleCI writes
`state`; GitLab `status`; Jenkins `result`). CI-derived deployments are never detected, so lead
time for changes is always `null`.

### 1.1 Confirmed defects (user-visible effect)

1. **preflight passes on a red build.** `preflight/preflight.ts` filters `$.branch` (only CircleCI
   writes it; GitHub Actions writes `headBranch`, GitLab `ref`, Jenkins nothing) and
   `$.conclusion` (only GitHub Actions writes it). No provider writes both. Its dedupe partitions
   on `$.workflow_name` (writer emits `workflowName`) and falls back to `title`, which embeds the
   conclusion, so runs never group. Fixtures (`preflight.test.ts`) hand-write
   `{branch, conclusion}` on `github_actions` rows. Two latent logic defects sit behind the dead
   keys and would surface the moment they are fixed: the failure filter is applied *inside* the
   ranking CTE (so a superseded failure still reports), and CI runs are not scoped to the
   service's repos (any repo sharing the CI service and branch name contaminates the verdict).
2. **DORA CI deploy lane is dead** (above).
3. **expert blame lane is silently empty.** `agents/expert.ts` `subBlame` reads
   `service='github' AND type='commit'`; the only commit rows are `filesystem`/`git_commit`
   written with `authorId: null` and no author metadata. The gap check asks about GitHub, which
   is connected, so nothing is disclosed.
4. **changelog / standup never show their non-GitHub gap.** They match `state='merged'`;
   Bitbucket writes `MERGED`, GitLab writes the MR state into `action`. The count is always 0 and
   the gap that is gated on `> 0` never fires. Fixtures (`changelog.test.ts`, `standup.test.ts`)
   hand-write `{state: "merged"}` on gitlab rows.
5. **pre-mortem review drag is always empty.** It reads PR `opened_at_ms`, which no forge writes
   (only PagerDuty incidents carry it). The disclosure reads as "missing for this cohort", and
   `risks.test.ts` asserts that weaker wording. Fixing it exposes a partial: `merged_at` is
   GitHub-only.
6. **negotiate merged-PR count reads 0** for GitLab/Bitbucket authors, undisclosed.
7. **The demo corpus has the same false shape.** `demo/corpus/acme.ts` writes `ci_run` rows with
   `{conclusion, repo}`, a shape no real writer produces; `nimbus demo` is correct only because
   of it.

### 1.2 Root cause

Each CI/forge writer names the same fact differently (`conclusion`/`state`/`status`/`result`,
`branch`/`headBranch`/`ref`, `merged`/`MERGED`/`action`), every reader picks one spelling, and
every test fixture hand-writes the spelling its reader wants. The census cannot see the mismatch
for helper-built writes or non-SQL reads.

## 2. Decision

**Normalize at the writers** behind a shared contract (chosen over reader-side `COALESCE`
mapping and over disclose-only). Precedent: `connectors/ticket-depth.ts` (Jira/Linear
`status_category`, `TICKET_META_VERSION`, rebody recovery).

Delivered as **three PRs from this one spec, landed in order**:

- **A1 — contract + writers.** No reader code changes. **Not purely additive:** four canonical
  keys collide with raw keys some writers already emit (§3.1.1), so a few existing reads change
  meaning in A1 — each is listed and pinned by a test there.
- **A2 — readers.** Switch to canonical keys; fixtures from real writers; honest gaps. Closes the
  defects in §1.1.
- **A3 — gate.** Census noise fixes, contract-aware matching, ambiguous-read scoping, enforced CI
  gate with a named exemption list.

## 3. A1 — the contract and the writers

### 3.1 Rules (both modules)

- Canonical keys are **snake_case** and written **alongside** the raw keys; raw keys are not
  removed (other readers and `nimbus query` users may rely on them).
- The provider's own value is preserved as `*_raw` where the canonical value is normalized.
- **A field the provider cannot honestly supply is omitted, never guessed.** Absent means
  unknown; readers disclose it.
- Normalization tables are exact-match lookups; an unrecognized value maps to `unknown`, never
  to `success`/`open`/`merged`.
- Each module exports its version constant and a **per-service emitted-keys table as data**
  (`readonly` map service → set of canonical keys that service can emit). Writers build their
  canonical keys through the module's builder; the census (§5.2) and reader disclosures read the
  same table.
- Every row written through the builder carries `meta_v = <VERSION>`.
- **Writers never assemble canonical keys by hand.** Each module exports a pure builder
  (`buildCiRunMetadata(raw, fields)`, `buildPrMetadata(raw, fields)`) that normalizes, omits,
  and stamps `meta_v`; a connector passes the fields it extracted. The emitted-keys table is
  typed (`CanonicalCiRunKey` / `CanonicalPrKey` unions, a `Record<Service, ReadonlySet<Key>>`), so
  it can only name real canonical keys; that it matches what each writer actually emits is
  enforced by a drift test driving every real mapper.
- **Timestamps:** every canonical `*_at` / `*_ms` field is an integer epoch-millisecond `number`.
  ISO strings are parsed in the builder; seconds (git `ct`) are multiplied; an absent or
  unparseable value is omitted — never `NaN`, never `0`, never a string.
- **Identifiers are verbatim.** Jenkins `workflow_name` is `job.fullName` including folder
  slashes (`folder/sub/job`); no trimming or case folding anywhere, so `preflight` and `dora`
  keep exact matching.

#### 3.1.1 Key collisions (where "alongside" is not true)

Four canonical keys share a name with a raw key a writer already emits. For these the canonical
value **replaces** the raw one and the raw value moves to `*_raw`:

| Writer | Key | Before | After |
|---|---|---|---|
| `github_actions` | `conclusion` | vendor vocabulary (`timed_out`, `skipped`, `null` while running…) | canonical (`timed_out`→`failure`, running→`running`); raw in `conclusion_raw` |
| `circleci` | `branch` | `vcs.branch ?? vcs.tag` | `vcs.branch` only (tag omitted) |
| `github` (pr) | `state` | `open`/`closed` (a merged PR reads `closed`) | `open`/`merged`/`closed`; raw in `state_raw` |
| `bitbucket` (pr) | `state` | `OPEN`/`MERGED`/`DECLINED`/`SUPERSEDED` | lowercase canonical; raw in `state_raw` |

Every production read of these four keys was enumerated (`grep` of `$.conclusion` / `$.state` /
`["conclusion"]` / `["state"]` / `$.branch`); readers on other item types (`deployment`'s
`watcher-condition-kinds.ts`, `review`'s `negotiate.ts:453`) are unaffected. The `ci_run`/`pr`
readers that see the change in A1 — `preflight.ts`, `dora.ts`, `changelog-queries.ts`
(`selectDeployments` and the merged lane), `standup-queries.ts` — are exactly A2's readers, and
each changes in the direction of the fix (e.g. a Bitbucket merged PR starts matching
`state = 'merged'`). A1 pins each of these with a before/after test so the change is
deliberate, not incidental.

### 3.2 `connectors/ci-run-meta.ts` — `CI_RUN_META_VERSION = 1`

`CiConclusion = "success" | "failure" | "cancelled" | "running" | "unknown"`

| Canonical key | `github_actions` | `circleci` | `gitlab` | `jenkins` |
|---|---|---|---|---|
| `conclusion` | `status` ≠ `completed` → `running`; else `conclusion`: `success`→success, `failure`/`timed_out`/`startup_failure`→failure, `cancelled`→cancelled, `skipped`/`neutral`/`action_required`/`stale`/other→unknown | pipeline `state` (`created`/`errored`/`setup-pending`/`setup`/`pending` — a PIPELINE state, not a pass/fail; pass/fail lives on workflows, which the sync does not fetch): `errored`→failure, every other value→unknown. **CircleCI therefore cannot supply a success/failure conclusion** and readers disclose it (deferred: fetching workflow statuses) | `status`: `success`→success, `failed`→failure, `canceled`→cancelled, `created`/`waiting_for_resource`/`preparing`/`pending`/`running`/`scheduled`/`manual`→running, `skipped`/other→unknown | `building` → running; else `result`: `SUCCESS`→success, `FAILURE`/`UNSTABLE`→failure, `ABORTED`→cancelled, `NOT_BUILT`/other→unknown |
| `conclusion_raw` | raw `conclusion` ?? `status` | `state` | `status` | `result` |
| `branch` | `headBranch` | `vcs.branch` only (a tag is not a branch → omitted) | `ref`, **omitted when the pipeline is a tag pipeline** (`tag === true` where the API supplies it — planning confirms whether the list endpoint carries `tag` or only the single-pipeline endpoint; if absent, `branch` is written from `ref` and the residual is stated) | omitted |
| `repo` | repo full name (**new**) | `githubRepo` | `project` | omitted |
| `workflow_name` | `workflowName` | omitted | omitted | `jobName` |
| `head_sha` | `headSha` | `revision` | `sha` | omitted |

The exact vendor value sets are verified against each provider's API documentation during
planning; any value not listed maps to `unknown`.

### 3.3 `connectors/pr-meta.ts` — `PR_META_VERSION = 1`

`PrState = "open" | "merged" | "closed" | "unknown"`

| Canonical key | `github` | `bitbucket` | `gitlab` |
|---|---|---|---|
| `state` | `merged === true` → merged; else `state` (`open`/`closed`) | `MERGED`→merged, `OPEN`→open, `DECLINED`/`SUPERSEDED`→closed | MR `state` (`opened`→open, `merged`→merged, `closed`/`locked`→closed) from `fetchOne`; from events: `accepted`/`merged`→merged, `opened`/`reopened`→open, `closed`→closed; any other event action **does not write `state`** (§3.5) |
| `state_raw` | `state` | `state` | MR `state` or event `action` |
| `merged` | boolean | derived from `state` | derived from `state` (only when `state` is written) |
| `opened_at_ms` | `created_at` (**new**) | `created_on` (**new**) | the `opened` event’s own `created_at` (that event IS the opening), or MR `created_at` from `fetchOne`; carried forward otherwise |
| `merged_at` | already written (merged only) | **omitted** — Bitbucket's PR resource has no merge timestamp; `updated_on` is not one | the `accepted`/`merged` event’s `created_at` (that event IS the merge), or MR `merged_at` from `fetchOne`; carried forward otherwise |
| `repo` | already written | already written | `project` |

**GitLab timestamps come from transition events.** The periodic sync reads the events API in ascending order (`sort=asc`); an `opened` event’s `created_at` is the opening time and an `accepted`/`merged` event’s is the merge time, so both are honest. An MR whose opening (or merge) predates the sync window has no such event and its row lacks the key — per-row absence, which readers already treat as unknown. Non-transition events carry every canonical key forward (§3.5). (Amended 2026-10-08 during planning: the first draft said GitLab could not supply these at all.)

### 3.4 `git_commit` author (for expert, §4)

`filesystem-v2-sync.ts`'s `gitLogRecords` adds the author email (`%ae`) and name (`%an`) to its
format. The writer records `author_email` in metadata and resolves `authorId` through
`ctx.resolvePerson` by email (the same resolution other connectors use). A commit whose email
resolves to no person keeps `authorId: null`. Spawns stay `windowsHide: true` (D25). The version
constant is `GIT_COMMIT_META_VERSION = 1` in a new `connectors/git-commit-meta.ts`, beside the
other two contract modules.

### 3.5 GitLab event upserts must not regress state

A comment event upserts the same MR row and today overwrites `action`, so a merged MR can read
as open. **Verified:** `upsertIndexedItem` (`index/item-store.ts`, `ON CONFLICT … metadata =
excluded.metadata`) **replaces** metadata wholesale, so omitting keys is not enough — it would
erase them. Rule: for an event whose action is not a state transition, the event path reads the
stored row through the existing `ctx.itemMetadata(itemId)` capability
(`sync/sync-capabilities.ts`) and carries the canonical keys forward (`state`, `state_raw`,
`merged`, `opened_at_ms`, `merged_at`, `meta_v`). A state-transition event writes its own values.
Tests: merged → comment → still merged; no stored row → comment → `state` omitted (unknown, not
open); merged → `reopened` → open.

### 3.6 Rebody recovery, type-scoped

`REBODY_REQUIRED_META_VERSION` gains a `(service, type)` key form so that `github`/`gitlab`
`issue` rows (which carry no `pr` contract) do not stay rebody-eligible forever. Registered:

- `github_actions`, `circleci`, `gitlab`, `jenkins` for `ci_run` → `CI_RUN_META_VERSION`
- `github`, `bitbucket`, `gitlab` for `pr` → `PR_META_VERSION`
- `filesystem` for `git_commit` → its own version constant

Existing service-keyed entries (`jira`, `linear`, `pagerduty`) keep working unchanged. No
schema migration.

Shape: the map becomes a readonly array of
`{ service: string; type?: string; requiredMetaVersion: number }` (`type` absent = every type of
that service), replacing string-keyed lookup — no composite-key parsing. The eligibility SQL
(`buildTargetServicesSql`) emits `(service = ? AND type = ? AND COALESCE(json_extract(metadata,
'$.meta_v'), 0) < ?)` for a typed target and the same without `type` for a service-wide one,
OR-joined; `computePendingMetaByService` counts each row once even when two targets could match
it (a test registers overlapping targets and asserts no double count).

### 3.7 Demo corpus

`demo/corpus/acme.ts` builds its `ci_run` and `pr` rows through the contract builders, so the
demo exercises the same shape production writes. `nimbus demo`'s e2e test and the release judge
`scripts/release/assert-demo-tour.ts` must stay green.

### 3.8 A1 tests

- Per-provider normalization tables: every listed value, plus an unlisted value → `unknown`.
- Each writer: real API-shaped input → row carries the canonical keys, the raw keys, and
  `meta_v`; omitted fields are absent (not `null`, not `""`).
- Emitted-keys table matches what each writer actually emits (a test that drives each writer
  and compares key sets — the table cannot drift from the code).
- GitLab merged → comment event → still merged.
- Rebody: a `(service, type)` row below version is eligible; a same-service row of another type
  is not.

## 4. A2 — the readers

Every reader switches to the canonical keys. **Every fixture is built by calling the real writer
mapper**, never by hand-writing metadata. Every "no data" result distinguishes *permanently
impossible for this provider* (from the emitted-keys table) from *empty in this window*.

| Reader | Change | Disclosure |
|---|---|---|
| `preflight/preflight.ts` `selectFailingCiRuns` | `branch`, `conclusion`, `workflow_name`. **Two further defects fixed here:** (a) the `conclusion IN (failure, cancelled)` filter moves from inside the `ranked` CTE to the outer `rn = 1` query — today it ranks only failing runs, so a workflow that failed yesterday and passed ten minutes ago still reports red; (b) runs are **scoped to the service's repos** with the same URN matching as DORA (`repoLikeMatchesUrn` semantics, Jenkins on `jobName`) — today any repo sharing the CI service and branch name contaminates the verdict. Partition `(service, repo, COALESCE(workflow_name, ''))` — **never the title** | a targeted provider without `branch` (Jenkins) or without a pass/fail conclusion (CircleCI, §3.2) is "cannot evaluate" (`count: 0` + gap), never a clean pass; the same applies to DORA deploy detection for CircleCI |
| `metrics/dora.ts` `selectDeploys` / `repoLikeMatchesUrn` | `conclusion = 'success'`, `repo`; Jenkins keeps `jobName` | unchanged |
| `agents/changelog-queries.ts` `selectDeployments` | `conclusion = 'success'` canonical, `repo` via `keepByRepo` (missed in the first draft; found while enumerating §3.1.1) | unchanged |
| `metrics/stats.ts`, `agents/_lib/oncall-queries.ts` | canonical names | `github_only_merge_data` kept and **reworded to name both** GitLab (events carry no merge time, §3.3) and Bitbucket (API has none) |
| `agents/changelog-queries.ts`, `agents/standup-queries.ts` | `state = 'merged'` canonical | non-GitHub gap now fires; reworded to name the forge lacking the data |
| `agents/premortem.ts` review drag | `opened_at_ms`, `merged_at` canonical | replace the "missing for this cohort" message (and the `risks.test.ts` assertion of it) with a per-forge disclosure naming GitLab and Bitbucket |
| `agents/negotiate.ts` | `merged` canonical | merged count discloses forges without merge data, as `statsCoverage` does |
| `agents/expert.ts` `subBlame` | `service='filesystem' AND type='git_commit'` joined on the now-populated `author_id` | no resolved author → explicit "commit authorship unavailable" gap; the GitHub missing-connector check is replaced by a filesystem/git one |

### 4.1 A2 tests (wire, not ends)

- **Fixture helper:** one shared test helper (`connectors/testing/lane-fixtures.ts`, following
  the repo's `*/testing/*-test-helpers.ts` pattern) builds rows by driving the **real connector
  mapper** with API-shaped input (e.g. a GitHub Actions `workflow_run` object), not by calling the
  contract builder directly — calling the builder would skip the writer's own field extraction,
  which is where `headBranch`-style bugs live.
- **Red-proof:** preflight over a real-writer-built failing GitHub Actions run on the target
  branch returns a failing verdict (fails on today's code).
- preflight: a newer passing run of the same workflow supersedes an older failing one; a failing
  run in a repo outside the service's URNs is ignored.
- DORA lead time over real-writer `ci_run` + `pr` rows is non-null.
- changelog / standup count a real-writer Bitbucket `MERGED` PR and a GitLab merged MR.
- pre-mortem review drag non-null over real-writer GitHub PRs; Bitbucket disclosed.
- expert blame lane returns a person for a real `git log` fixture repo; discloses when no author
  resolves.
- Existing hand-shaped fixtures for these readers are deleted or rebuilt, not left alongside.

### 4.2 A2 decisions and scope (amended 2026-10-08, after A1 merged as #1632)

A1 already moved most readers onto canonical keys (preflight, DORA `selectDeploys`, changelog,
standup, premortem, negotiate); A2 is what remains, plus four writer fixes from A1's final review.
**One PR** (user decision).

**Decisions (user, 2026-10-08):**
1. **Unevaluable CI is a gap, never a verdict change.** A service bound to a CI provider the index
   cannot judge gets a new gap `ci_not_evaluable` on preflight's `failing_ci_runs` check; the
   verdict is unchanged (`ok` when nothing else is wrong). Unevaluable for preflight: `jenkins`
   (no branch), `circleci` (no pass/fail signal), `bitbucket` (no `ci_run` writer at all). For DORA
   deploy detection: `circleci` and `bitbucket` (Jenkins `SUCCESS` + `jobName` is evaluable). One
   helper owns both sets so they cannot drift.
2. **`pr-merges` counts GitLab.** GitLab MR rows with canonical `merged_at` and `repo` are counted
   beside GitHub. `github_only_merge_data` is no longer emitted by stats (it stays in the type and
   OpenAPI enum so a consumer matching it does not break); a new gap `incomplete_merge_data` is
   emitted whenever the service binds a Bitbucket repo (never records a merge time) or a GitLab
   repo (merges before the synced window carry none). The changelog/standup remediation strings
   that name the old gap point at the new one.
3. **Scope:** readers + the four writer fixes below, in one PR.

**Writer fixes (amend §3):**
- **`merged` only for a known state.** `buildPrMetadata` writes `merged` only when `state` is
  `open`/`merged`/`closed`; an `unknown` state writes no `merged` (absent = unknown, §3.1).
- **GitLab MR author is the MR author.** The `opened` event's actor IS the author; it is recorded
  as raw `author_login`/`author_name` in the MR row's metadata (and from `mr.author` on `fetchOne`)
  and carried forward like the canonical keys. `authorId` is resolved from the carried login,
  never from a later event's actor; with no known author it is `null` rather than the actor.
- **No version stamp without recovered state.** A GitLab MR row whose state is still unknown after
  carry-forward does not get `meta_v`, so `nimbus index rebody` keeps it eligible.
- **CI runs are refreshed until they finish.** A run already at or below the cursor is re-upserted
  when its stored canonical `conclusion` is `running` and the provider's existing fetch returns it
  again (GitHub Actions latest 30, CircleCI first page, Jenkins last 25; GitLab's loop stops
  breaking at the first seen id and skips instead). No new requests are made.

**Fixture rule (amends §4.1's helper):** fixtures pass real-mapper output into each test file's
existing insert helper; no shared `lane-fixtures.ts` is created, because the test files use three
different `item` schemas and a shared inserter would have to guess one.

**Other §4 amendments:** the stats/oncall row's "GitLab events carry no merge time" is superseded
by §3.3 (they do, inside the synced window). oncall's change lane matches on `merge_commit_sha`,
which only GitHub writes; that stays a disclosed GitHub-only limit, reworded to say so directly.

## 5. A3 — the gate

### 5.1 Census noise fixes

- Add `packages/gateway/src/clips/` and `index/item-store.ts` to `WRITER_INCLUDE`.
- A `meta["k"] = …` / `meta.k = …` assignment target is a write, not a read.
- Exclude `*.test-helpers.ts` (and any `test-helpers` path) from production reads.
- Resolve `metadata: <identifier>` to the identifier's local `const` initializer.
- A `meta[...]` access counts as an item read only when `meta` derives from an `item` row
  (`row.metadata`, `parseMetadata(...)`, `JSON.parse(row.metadata)` of an `item` query result);
  otherwise it is not an index read (k8s ObjectMeta, Slack/Zendesk pagination, GX result files,
  SCIM request bodies).

### 5.2 Contract-aware matching

The census imports the emitted-keys tables from `ci-run-meta.ts` and `pr-meta.ts` and treats
them as writer emissions for their `(service, type)`. A read of a contract key scoped to a
provider that omits it is a precise `partial` naming that provider.

### 5.3 Ambiguous reads must be scoped

Each of the 122 ambiguous reads gets either a scope annotation the census then verifies —
`// lane-census: scope=<type>[ service=<id>[,<id>]]` on the line above the read — or an
exemption with a reason. After A3, an unannotated ambiguous read in new code fails the gate.

### 5.4 Enforcement

`bun run audit:lane-census --check` exits 1 on:

- an unmatched or partial read not listed in `scripts/structure-audit/lane-census/exemptions.ts`
  (entries: `file`, `key`, `category`, `reason` — e.g. `disclosed as github_only_merge_data at
  agents/oncall.ts:<line>`);
- an ambiguous read with neither annotation nor exemption;
- a **stale exemption** that matches no current read.

The gate is added to `scripts/lib/preflight-gates.ts` and the PR-quality workflow (the drift
test enforces parity; the aggregator means no ruleset edit). Without `--check` the command keeps
today's always-exit-0 report.

### 5.5 A3 tests

- Fixture cases: a dead read fails; an annotated read passes; an annotation naming a type no
  writer emits fails; a stale exemption fails; a contract partial fails unless exempted.
- **Red-proof:** on a scratch branch, reverting A2's preflight change turns `--check` red.

## 6. Out of scope

- Normalizing other item types (`incident`, `issue`, `message`) — the ticket and incident lanes
  already have their own contracts or were not implicated.
- Backfilling GitLab `opened_at_ms` from events history.
- A Bitbucket merge timestamp (the API does not provide one).
- Any change to which services a reader targets beyond fixing what it reads.

## 7. Risks

- **GitLab metadata replace semantics (§3.5)** — verified (replace); handled by read-merge-write.
- **Key collisions (§3.1.1)** change four existing keys' values in A1; every reader was
  enumerated and each change is pinned by a test.
- **GitLab `tag` field availability (§3.2)** — the one remaining unverified vendor detail.
- **Stored rows below version** read as "unknown" until resync/`nimbus index rebody`; readers
  must disclose rather than undercount silently. The version bump makes them recoverable.
- **Raw-key readers outside this list** keep working because raw keys are retained.
- **Vendor value sets** may include values not listed; they map to `unknown`, which degrades to a
  disclosure, never a false pass.
