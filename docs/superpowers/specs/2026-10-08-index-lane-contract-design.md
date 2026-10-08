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
   `{branch, conclusion}` on `github_actions` rows.
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

- **A1 — contract + writers.** Additive only; no reader changes; nothing user-visible changes.
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

### 3.2 `connectors/ci-run-meta.ts` — `CI_RUN_META_VERSION = 1`

`CiConclusion = "success" | "failure" | "cancelled" | "running" | "unknown"`

| Canonical key | `github_actions` | `circleci` | `gitlab` | `jenkins` |
|---|---|---|---|---|
| `conclusion` | `status` ≠ `completed` → `running`; else `conclusion`: `success`→success, `failure`/`timed_out`/`startup_failure`→failure, `cancelled`→cancelled, `skipped`/`neutral`/`action_required`/`stale`/other→unknown | `state`: `success`→success, `failed`/`errored`/`failing`→failure, `canceled`→cancelled, `created`/`running`/`on_hold`→running, other→unknown | `status`: `success`→success, `failed`→failure, `canceled`→cancelled, `created`/`waiting_for_resource`/`preparing`/`pending`/`running`/`scheduled`/`manual`→running, `skipped`/other→unknown | `building` → running; else `result`: `SUCCESS`→success, `FAILURE`/`UNSTABLE`→failure, `ABORTED`→cancelled, `NOT_BUILT`/other→unknown |
| `conclusion_raw` | raw `conclusion` ?? `status` | `state` | `status` | `result` |
| `branch` | `headBranch` | `vcs.branch` only (a tag is not a branch → omitted) | `ref` | omitted |
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
| `opened_at_ms` | `created_at` (**new**) | `created_on` (**new**) | MR `created_at` from `fetchOne` only — an event timestamp is not the opening time |
| `merged_at` | already written (merged only) | **omitted** — Bitbucket's PR resource has no merge timestamp; `updated_on` is not one | MR `merged_at` from `fetchOne` |
| `repo` | already written | already written | `project` |

### 3.4 `git_commit` author (for expert, §4)

`filesystem-v2-sync.ts`'s `gitLogRecords` adds the author email (`%ae`) and name (`%an`) to its
format. The writer records `author_email` in metadata and resolves `authorId` through
`ctx.resolvePerson` by email (the same resolution other connectors use). A commit whose email
resolves to no person keeps `authorId: null`. Spawns stay `windowsHide: true` (D25).

### 3.5 GitLab event upserts must not regress state

A comment event upserts the same MR row and today overwrites `action`, so a merged MR can read
as open. Rule: an event whose action is not a state transition omits `state`/`merged`/`state_raw`
from the metadata it writes. **Planning must verify whether `upsertItem` merges or replaces
`metadata`.** If it replaces, the event path reads the stored row's canonical keys and carries
them forward (read-merge-write inside the same sync pass); a test covers merged → comment event
→ still merged.

### 3.6 Rebody recovery, type-scoped

`REBODY_REQUIRED_META_VERSION` gains a `(service, type)` key form so that `github`/`gitlab`
`issue` rows (which carry no `pr` contract) do not stay rebody-eligible forever. Registered:

- `github_actions`, `circleci`, `gitlab`, `jenkins` for `ci_run` → `CI_RUN_META_VERSION`
- `github`, `bitbucket`, `gitlab` for `pr` → `PR_META_VERSION`
- `filesystem` for `git_commit` → its own version constant

Existing service-keyed entries (`jira`, `linear`, `pagerduty`) keep working unchanged. No
schema migration.

### 3.7 Demo corpus

`demo/corpus/acme.ts` builds its `ci_run` and `pr` rows through the contract builders, so the
demo exercises the same shape production writes. `nimbus demo`'s e2e test must stay green.

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
| `preflight/preflight.ts` | `branch`, `conclusion`, `workflow_name`; partition `(service, repo, COALESCE(workflow_name, ''))` — a provider without `workflow_name` collapses to the latest run per repo+branch — **never the title** | a targeted provider without `branch` (Jenkins) is "cannot evaluate" (`count: 0` + gap), never a clean pass |
| `metrics/dora.ts` `selectDeploys` / `repoLikeMatchesUrn` | `conclusion = 'success'`, `repo`; Jenkins keeps `jobName` | unchanged |
| `metrics/stats.ts`, `agents/_lib/oncall-queries.ts` | canonical names | `github_only_merge_data` kept, now accurate (Bitbucket omits `merged_at`) |
| `agents/changelog-queries.ts`, `agents/standup-queries.ts` | `state = 'merged'` canonical | non-GitHub gap now fires; reworded to name the forge lacking the data |
| `agents/premortem.ts` review drag | `opened_at_ms`, `merged_at` canonical | replace the "missing for this cohort" message (and the `risks.test.ts` assertion of it) with a per-forge disclosure |
| `agents/negotiate.ts` | `merged` canonical | merged count discloses forges without merge data, as `statsCoverage` does |
| `agents/expert.ts` `subBlame` | `service='filesystem' AND type='git_commit'` joined on the now-populated `author_id` | no resolved author → explicit "commit authorship unavailable" gap; the GitHub missing-connector check is replaced by a filesystem/git one |

### 4.1 A2 tests (wire, not ends)

- **Red-proof:** preflight over a real-writer-built failing GitHub Actions run on the target
  branch returns a failing verdict (fails on today's code).
- DORA lead time over real-writer `ci_run` + `pr` rows is non-null.
- changelog / standup count a real-writer Bitbucket `MERGED` PR and a GitLab merged MR.
- pre-mortem review drag non-null over real-writer GitHub PRs; Bitbucket disclosed.
- expert blame lane returns a person for a real `git log` fixture repo; discloses when no author
  resolves.
- Existing hand-shaped fixtures for these readers are deleted or rebuilt, not left alongside.

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

- **GitLab metadata replace semantics (§3.5)** — the one unverified mechanic; planning resolves
  it first.
- **Stored rows below version** read as "unknown" until resync/`nimbus index rebody`; readers
  must disclose rather than undercount silently. The version bump makes them recoverable.
- **Raw-key readers outside this list** keep working because raw keys are retained.
- **Vendor value sets** may include values not listed; they map to `unknown`, which degrades to a
  disclosure, never a false pass.
