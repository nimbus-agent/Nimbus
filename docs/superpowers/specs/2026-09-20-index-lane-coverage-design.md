# Index lane coverage — design

**Status:** proposed · **Initiative:** B4 (bug-hunt audit), `docs/roadmap.md` § Maintenance-initiative follow-ups
**Date:** 2026-09-20

## 1. The defect class

A production query filters on an `item.type` or a `metadata.<key>` **that no shipped connector
writes**. The lane is permanently empty, and the empty result is reported as a *clean answer*
rather than as an unavailable one.

Confirmed in four independent areas by the B4 reconnaissance, every one re-verified against the
connector writers:

| site | filters on | what the writer emits | user-visible consequence |
|---|---|---|---|
| `metrics/dora.ts:109` `selectDeploys` | `metadata.conclusion` + `metadata.repo` | `github-actions-sync.ts:129` emits `conclusion` but **no `repo`**; gitlab `status`, jenkins `result`, circleci `state` | lead time and change-failure rate are `null` on **every** install; the roadmap ships the row ✅ complete |
| `preflight/preflight.ts:166,175` | `$.workflow_name` and `$.branch` | writer emits `workflowName` and `headBranch` | the deploy gate reports `verdict: "ok"` on a red build — **fails open**, twice over, for two independent reasons |
| `agents/expert.ts:381` | `i.service='github' AND i.type='commit'` | nothing writes `item.type='commit'`; `filesystem-v2-sync.ts` writes `git_commit`/`filesystem` | the heaviest lane (weight 1) is dead; `expert` names the wrong person at score 1.0 with no gap note |
| `agents/premortem.ts:178`, `metrics/stats.ts:218` | `$.opened_at_ms` on **PR** items | written only by `pagerduty-sync.ts`, on **incident** rows | the `review_drag` risk lane is permanently unmeasurable |

A likely fifth, surfaced during feasibility and **not yet verified end to end**:
`metrics/service-identity.ts:68-70` is a second repo-URN binder with the same shape as
`dora.ts:69-71`, resolving via `metadata["repo"] ?? metadata["project"]`. A `github_actions:ci_run`
row has neither key, so that binder cannot bind either. Whether its zero result is reported as a
clean answer is the open question, and the first thing the census should settle.

**Why the test suite cannot see any of them:** the fixture hand-writes the key the query wants.
`dora.test.ts:112` seeds `{conclusion, repo, headSha}` — a shape no writer produces — and 85 tests
pass over a query returning zero rows in production. `expert.e2e.test.ts:24` hand-writes
`{service:"github", type:"commit"}`. This is a contract mismatch at the data layer: a test per side
proves the ends, never the wire.

**The contrast that defines a defect rather than a limitation.** `agents/impact.ts:272`'s
`subPipelines` lane is equally dead — nothing writes `pipeline_run` entities — but it ends its
zero-row branch with `detectMissingEntityType(db, "pipeline_run")`, producing a `GapNote` that I31
re-attaches verbatim. That lane is honest. `expert.ts:392` also calls a probe — but
`detectMissingConnector(db, "github")`, which asks about `sync_state`, **a different predicate from
the one the query filtered on**. GitHub is synced, so the probe returns `null` and the empty lane
reports clean. *The structural difference is one line, and it is checkable.*

## 2. Two traps that decide the design

**2.1 `type` is not one column — it is three, and conflating them reproduces the bug.**
Exactly three tables carry a bare `type` column: `graph_entity` (114 read sites), `graph_relation`
(75), `item` (56). `graph/graph-populator.ts:341,426` writes `type: "commit"` to **`graph_entity`**.
A literal-matching scan that is not table-aware sees `commit` emitted and `commit` read, and passes
`expert.ts` green. A naive shape-based writer scan was built during feasibility and did exactly
that, reporting 74 emitted item types including `commit`. **Table-awareness is not a refinement; it
is the difference between a gate and theatre.**

**2.2 The writer corpus must exclude `demo/` and `test/fixtures/`, or the gate passes vacuously on
day one.** `demo/corpus/acme.ts:443-452` writes a `github_actions:ci_run` whose metadata is
`{conclusion, repo, headSha}` — **including the `repo` key the real `github-actions-sync.ts` does
not write**. Any writer-set derived by scanning all of `packages/gateway/src` is satisfied by the
demo corpus and reports the DORA arm clean.

The purest instance is `workflow_name`: it has **no writer anywhere in the repo**. Its only
production occurrence is the reader at `preflight/preflight.ts:166`; every other occurrence is a
test fixture (`preflight.test.ts:534,539`, `test/fixtures/preflight/payment-service/seed.ts`). The
key exists solely because the fixtures invented it — the defect class in its final form, already
sitting in the tree waiting for the gate that would trip over it.

The writer corpus is therefore `connectors/**` plus `deployment/annotate.ts`, excluding `demo/`,
`perf/`, `agents/` and `test/fixtures/`. **This scoping is hand-maintained and no scanner validates
it** — it is the one place the gate's correctness rests on a human decision, and it is the reason
the design keeps the coverage map rather than trusting extraction alone.

## 3. Approaches considered

**(A) Static SQL-aware gate — viable on both halves, but not sufficient alone.** Reader extraction
is strong: 253 of 255 `type` comparisons have their `FROM`/`JOIN` in the same string literal, and
alias binding succeeded on **253/253, zero unresolved**.

The writer half is stronger than first measured. Over `connectors/**` there are 114 row literals;
`type:` is extractable at **113/114 (99.1%)** — 101 plain string literals, 8 module-level
`const … as const`, 2 ternaries of two literals, 1 local const, 2 threaded from literal call sites,
and **zero computed template strings**. The single unresolvable site is dead code
(`_lib/item-builder.ts:38`, whose `buildIndexedItem` has no production callers). Metadata keys are
likewise **never computed**: zero `[expr]:` keys, zero raw `...apiResponse` spreads, zero
`JSON.parse`. 71% of write sites have their keys physically outside any `*-sync.ts`, but following
one import plus six named helpers (`buildPagerdutyMetadata`, `extractPrMetadataForIndex` +
`applyMergeFields` + `mergeForwardPrStats`, `jiraDepthMetadata`, `linearDepthMetadata`,
`pickAllowed`, `applyReportFieldPolicy`) reaches the same 113/114. Exactly one site is genuinely
open-world: `workday-mappers.ts:140`, over a customer's RaaS report columns.

So a static writer set is defensible on its own. **What (A) still cannot do is validate its own
corpus scoping** (2.2), which is where the vacuous pass lives — and that is untouched by extraction
fidelity.

*A cautionary data point from the feasibility work itself:* the first writer scan reported 148 row
literals and 74 emitted item types including `commit`, because it swept `graph_entity` literals too
— the probe committed the very conflation it was written to warn about. Restricting to
`connectors/**` gives 114.

**(B) Hand-maintained registry — rejected.** This is the "hand-listed table that agrees with
itself" failure already booked in this repo. A *generated* registry is (A)'s writer half wearing a
JSON file, inheriting every blind spot while hiding it behind a checked-in artifact.

**(C) Runtime canary — highest fidelity, but it does not enumerate.** Driving the *real* connector
mapper into a real SQLite index and asserting the production query returns rows removes the writer
extraction question entirely, which is the whole point. But it says nothing about *which* lanes
exist, so a dead lane written next month is not caught.

**(D) Census → coverage map → canaries — chosen.** Take (A)'s strong reader half and (C)'s
fidelity, and use a compiler-enforced coverage map as the thing that actually gates.

## 4. Design

### 4.1 The census (`scripts/structure-audit/check-index-lane-coverage.ts`)

A table-aware scanner over `packages/gateway/src/**/*.ts` minus tests. For each SQL string literal
it binds every alias to its table from the `FROM`/`JOIN` in that same literal, then emits triples:

- `(table, type-literal, file:line)` for every `<alias>.type = '<literal>'`
- `(table, metadata-key, file:line)` for every `json_extract(<alias>.metadata, '$.<key>')`

Plus a second pass for the two shapes a pure SQL scan misses, both cheap and both named:
a same-file follow for per-file mini query builders (`changelog-queries.ts:134`'s
`WHERE i.type = ?` with literal callers in the same file), and a JS-side scan for
`meta["<key>"]` reads after `JSON.parse(metadata)`.

Ships in **census mode first**: exit 0, artifact to `docs/structure-audit/`. Prior art:
`collectDbRunCensus` / `db-run-census.json`.

### 4.2 The coverage map (`packages/gateway/src/index/lane-coverage.ts`)

Keyed `service:type`, **not bare `type`** — copying `glossary/glossary-source-types.ts`, whose
20-line header already reasoned this out for one subsystem and already records that nothing writes
`item.type = 'commit'`: *"`message`, `page`, `issue` and `commit` are generic type names shared
across services."* Somebody solved this once; the key shape is theirs.

The decisive argument for that key shape is `ci_run`. **Four connectors write `type: "ci_run"` with
four mutually incompatible outcome key names** — `conclusion` (github_actions), `status` (gitlab),
`result` (jenkins), `state` (circleci). A bare-`type` registry would report `ci_run` as emitting all
four and every consumer as satisfied, which is precisely the DORA bug wearing a registry. The same
applies to `repo`, which has five writers across three services (`github-sync` on pr/review/issue,
`bitbucket-sync` on pr, `vercel-deployment-mapping` on deployment) and near-misses that are *not*
`repo` in four others (gitlab `project`, circleci `githubRepo`, semgrep `repository`, filesystem-v2
`repoRoot`) — and none on `github_actions:ci_run`, which is the dead arm.

Every censused triple is classified:

- **`canaried`** — a test drives the real connector writer and asserts the query returns ≥1 row.
- **`disclosed`** — the lane emits a `GapNote` keyed on *the same predicate it filtered on*.
- **`known-dead`** — deliberately empty, with a one-line reason and a linked issue.

**The census becomes a gate the moment a triple has no entry.** That is the "what cannot pass"
formulation: a new dead lane is a violation on the day it is written, with no list for anyone to
forget to update.

### 4.3 `detectMissingItemType`

`agents/_lib/gap-notes.ts` has five probes — `detectEmptyIndex` (count only),
`detectMissingConnector` (`sync_state`), and three graph-keyed ones. **There is no item-type probe,
so no item lane in this repo can currently disclose emptiness the way `subPipelines` does.** Add
one, so `disclosed` is a state a lane can actually reach.

### 4.4 Canaries — confirmation, not the primary mechanism

Because the writer set is statically derivable at 99.1% (§3), canaries are **not** needed to
discover what connectors emit. They are spent only where *"this lane returns rows"* is the claim
worth pinning against a real writer — the lanes whose emptiness would be reported as an answer.

One fixture per such lane, using the existing harness
(`connectors/connector-sync-test-helpers.ts`, already used by 55 of 99 `*-sync.ts` files) to drive
the **real** syncable against a stubbed `fetch` into a real SQLite index. Fixtures come from
recorded responses, never from imagination — an invented payload that omits a field the real API
returns produces a canary that passes while production does not.

Blast radius is small either way: only 10 distinct `item.type` literals and ~37 metadata keys are
read anywhere.

## 5. Scope: `item` only in v1

`item` is 56 of 255 read sites, has the clean write chokepoint (exactly two `INSERT INTO item`
statements in production — `index/item-store.ts:113` and `deployment/annotate.ts:200`), and is
where **all four confirmed bugs live**.

`graph_entity` and `graph_relation` are 74% of the sites and the harder half: a relation's real unit
is `(relation-type, from-entity-type, to-entity-type)`, not `(table, type)`, and
`gap-notes.ts:86`'s `detectMissingRelationToEntityType` exists precisely because the broad probe was
already wrong once for that reason — the same defect class, already found by hand, in the probe
layer. A `(table, type)` census would under-specify them. **They are explicitly out of scope for
v1**, to be done second with the endpoint triple, or not at all.

## 6. What this does not catch — stated, not softened

- **A canary proves a lane returns rows against one fixture, not that it returns the *right* rows.**
  The precedent is in this repo: `changeFailureRate`'s incident-window bug (#1494) returned rows and
  was systematically wrong for months. This gate is orthogonal to that class and does not claim it.
- **A fixture built from imagination rather than a recorded response** can omit a field the real API
  returns, and then the canary passes while production does not. Fixtures come from recorded
  responses.
- **The 21 `type = ?` sites** are mostly generic user-supplied filters, not product lanes; only ~4
  are hardcoded. They need the same-file argument follow, which is in scope but is the least certain
  part of the extractor.
- **`known-dead` is an escape hatch**, and escape hatches are how guards die. It requires a reason
  and a linked issue, and the count is reported by the census so growth is visible.

## 7. Acceptance

1. The census, run over `main` today, reproduces all four confirmed bugs as unclassified triples.
2. `expert.ts`'s `item.type='commit'` is flagged **while** `graph_entity.type='commit'` is not —
   the table-awareness test, and the one that would have failed a naive implementation.
3. The census is **not** satisfied by `demo/corpus/acme.ts`'s `repo` key — the vacuous-pass test.
4. Adding a new `item.type` read with no coverage-map entry fails the gate (red-proved by adding
   one, observing the failure, and removing it).
5. Every rule reports clean on an empty scan, matching the existing anti-vacuity suite at
   `check-nimbus-invariants.test.ts:1270`.
