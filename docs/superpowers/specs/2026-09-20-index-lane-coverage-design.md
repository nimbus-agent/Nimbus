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

The map is a typed constant, so `tsc` checks it and the audit script reads the same source:

```ts
export type LaneStatus =
  | { readonly kind: "canaried"; readonly canaryTestFile: string; readonly canaryTestName: string }
  | { readonly kind: "disclosed"; readonly gapProbe: string }
  | { readonly kind: "known-dead"; readonly reason: string; readonly issue: string };

export type LaneCoverageEntry = {
  readonly service: string;
  readonly itemType: string;
  readonly requiredMetadataKeys: readonly string[];
  readonly servicesReached?: readonly string[]; // cross-service reads, § 4.2.1
  readonly status: LaneStatus;
};
```

`requiredMetadataKeys` is the field doing the real work: it is what turns the map from a
classification into a contract the census can check a writer against.

**Three anti-stale rules, because an escape hatch that only grows is how a guard dies:**

1. **A `known-dead` entry whose writer now emits the key is a FAILURE, not a pass.** This is the
   rule that matters most, and it is the one that runs in the direction guards usually forget:
   `Lane github_actions:ci_run is marked known-dead but the writer now emits 'repo' — reclassify.`
   Without it, the four bugs get marked dead, fixed, and the map keeps saying they are broken.
2. **A descending ratchet on the `known-dead` count**, asserted in
   `check-nimbus-invariants.test.ts`. It may fall freely; raising it is an explicit edit a reviewer
   sees. (Note the repo's own scar tissue here: a one-directional ratchet is right for this, but
   the coverage-floor ratchet has bitten before when the direction was wrong — the direction is the
   whole design.)
3. **`reason` non-empty and `issue` a real reference.** A `known-dead` with no issue is a TODO that
   has learned to pass CI.

I am **not** adopting "drive `known-dead` to zero" as a goal. Some lanes are legitimately dead —
a connector that genuinely cannot emit a field is a fact about an upstream API, not a bug to burn
down — and a target of zero converts an honest classification into pressure to misclassify.

### 4.2.1 Cross-service queries — the case the `service:type` key does not answer by itself

`dora.ts:98` is `WHERE service IN (${placeholders}) AND type = 'ci_run'`, where the placeholder set
resolves at runtime from config to `github_actions`, `gitlab`, `jenkins`, `circleci`. The census can
read `type = 'ci_run'` from the literal; it **cannot** read the service set, which is not in the SQL
at all.

This is not an edge case — it is the DORA bug's own shape. A generic-over-services query extracting
`$.conclusion` is satisfied by exactly one of the four services that reach it, and a census that
emitted a single `?:ci_run` triple would classify the lane as covered on the strength of the one
service that works.

**Rule:** a read site whose service set is not a literal emits a triple **per service the query can
reach**, and the coverage map must classify each one. Where the set comes from config rather than
the SQL (`distinctCiServiceColumns(cfg.repos)`), the read site declares it — an explicit
`servicesReached` on the map entry, cross-checked against the census's per-service triples. A lane
is `canaried` only when **every** service it reaches is; a partially covered lane is a first-class
state, not a rounding-up to covered.

That makes the four incompatible `ci_run` outcome keys visible as four entries — three of which are
today unclassified — rather than as one entry that looks fine.

### 4.2.2 What the extractor follows, and where it stops

Symmetry with the writer side is the honest design: both halves follow one hop plus a named
manifest, and both declare their residual.

- **Readers, same file:** follow a metadata object into a helper defined in the same file
  (`repoLikeMatchesUrn` at `dora.ts:60`, reached from `:111`). This is the shape that hides `repo`
  from a per-call-site window.
- **Readers, cross file:** a named manifest of metadata-reading helpers, mirroring the writer side's
  six. `metrics/service-identity.ts:68`'s `repoMetadataMatchesUrn` is the second member and the
  reason the manifest exists — it is a second binder with the same defect, found during feasibility
  and **not yet verified end to end**.
- **Writers:** do **not** hardcode the six helper names. Follow any call whose return value is
  assigned to `metadata` on a row passed to `ctx.upsertItem`/`upsertIndexedItem`. The six are what
  that rule resolves to today, not the rule itself — otherwise connector #95's
  `extractSentryMetadata` is invisible on the day it lands, which is precisely the drift this gate
  exists to prevent.
- **Stops at:** a helper that composes keys from data rather than literals. Exactly one exists
  (`workday-mappers.ts:140`, over a customer's RaaS report columns) and it is declared open-world in
  the coverage map rather than silently approximated.

**SQL preprocessing.** Template interpolations are replaced with a placeholder identifier before
parsing (`${placeholders}` → `__INTERP__`); feasibility measured 53 such literals with **none**
breaking alias binding. CTEs must be resolved transitively: `preflight.ts:161`'s
`WITH ranked AS (SELECT … FROM item …) SELECT … FROM ranked` means a `ranked` column is an `item`
column, and a census that stopped at the outer `FROM ranked` would bind nothing on the one query
that is dead twice over.

### 4.3 `detectMissingItemType`

`agents/_lib/gap-notes.ts` has five probes — `detectEmptyIndex` (count only),
`detectMissingConnector` (`sync_state`), and three graph-keyed ones. **There is no item-type probe,
so no item lane in this repo can currently disclose emptiness the way `subPipelines` does.** Add
one, so `disclosed` is a state a lane can actually reach.

It must distinguish the three cases `expert.ts` currently collapses, because they have different
remediations and only the first is what `detectMissingConnector` answers:

```ts
export type ItemTypeGap =
  | { readonly kind: "missing_connector"; readonly service: string }
  | { readonly kind: "empty_lane"; readonly service: string; readonly itemType: string };
```

- `sync_state` absent for the service → `missing_connector` (configure the connector).
- `sync_state` present, `COUNT(*) WHERE service = ? AND type = ?` is zero → `empty_lane` (this
  connector does not emit this type, *or* genuinely has none).

The second is deliberately **not** split further into "unsupported type" vs "user has none": the
index cannot tell them apart, and a probe that guessed would be the same overclaim the gate exists
to catch. The note says what is true — zero rows of this type from a synced connector — and the
coverage map carries which of the two it is, because a human decided it there.

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

**A canary over a relative time window is a test with an expiry date, and it must not be.** Every
lane this gate protects filters on one: `dora.ts` on `modified_at >= nowMs - sinceMs`, `expert.ts`
on 90 days, `preflight.ts` on 7. A fixture carrying a fixed ISO timestamp passes today and fails
silently once that date falls outside the window — and it fails *as though the lane were dead*,
which is the exact signal this gate is built to make meaningful. The harness normalises fixture
timestamps relative to `Date.now()` at ingestion (or the query takes an injected `nowMs` matching
the fixture's timeline); the canary must never depend on the wall clock of the day it runs.

**What a canary asserts.** Not `rows.length >= 1` alone — that passes while a field the downstream
code reads comes back `NULL`. It runs the production reader against the populated database and
asserts the fields that reader extracts are present and of the expected type. Casing
(`workflowName` vs `workflow_name`), nullability (a missing key yields SQL `NULL`, so `WHERE k = ?`
is never true rather than false), and `json_extract`'s type coercion are all in scope — **the
semantic correctness of the value is not**, and §6 says so.

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

**Static scope is `item`; canary scope is the whole query.** Many lanes join `item` to another
table — `expert.ts:383` is `FROM item i JOIN person p ON p.id = i.author_id`. In v1 the census
audits only the `item` predicates and ignores the `person` ones. The **canary** does not get that
narrowing: it seeds every row the query touches, through the real sync helpers, and asserts the
whole statement returns. That distinction matters for `expert.ts` specifically, whose lane is dead
on three grounds at once and only one of them is an `item` predicate — the join against
`author_id`, which `filesystem-v2-sync.ts` writes as `null`, is invisible to the static half and
caught only by running the query.

## 5.1 Rollout

Three phases, so the gate can land without being blocked on the fixes it finds:

1. **Census, report-only.** Ship the scanner in census mode, exit 0, artifact under
   `docs/structure-audit/`. Acceptance is §7.1–7.3 — it must reproduce the four known bugs and must
   not be fooled by the demo corpus.
2. **Map and gate.** Add `lane-coverage.ts`, classify every clean lane, classify the four confirmed
   bugs as `known-dead` against tracking issues, and turn the gate on. `main` stays green
   throughout: the bugs are *classified*, not fixed.
3. **Remediation.** One PR per bug, each adding its canary and reclassifying its entry. Anti-stale
   rule 1 above is what forces the reclassification rather than leaving a stale `known-dead`.

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
6. A cross-service read (`dora.ts`'s `service IN (…)` + `type = 'ci_run'`) yields **four** triples,
   not one, and the lane is not `canaried` while three of them are unclassified (§4.2.1).
7. A `known-dead` entry whose writer begins emitting the key **fails** the gate (§4.2, rule 1) —
   red-proved by adding `repo` to `github-actions-sync.ts` and observing the failure.
8. A canary with a fixed-date fixture does not silently decay: moving the system clock forward past
   the query's window leaves it passing (§4.4).
