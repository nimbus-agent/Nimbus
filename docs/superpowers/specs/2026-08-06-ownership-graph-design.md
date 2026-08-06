# Ownership graph from already-indexed data — design

**Date:** 2026-08-06
**Spine slot:** S1 (Local Brain) — closes the last unstarted S1 item
**Branch:** `dev/asafgolombek/ownership-graph`
**Schema:** **V51** — see [Schema version](#4-schema-version-v51-not-v50) for why not V50
**Roadmap row:** `docs/roadmap.md` § Spine S1 → "Ownership graph from already-indexed data —
service/code ownership derived from the existing GitHub + PagerDuty index; dedicated IDP
connectors (Backstage et al.) stay demoted to S5"

---

## 1. Summary

Derive a persisted, deterministic **ownership graph** from data the index already holds:
`person → source_file`, `person → directory`, and `person → service` edges scored by
recency-weighted git-blame line share, plus the two structural edges that make the service
rollup possible (`workspace → repo`, `repo → service`).

No new connectors. No LLM. No network. The computation reads `git_blame_line` (schema V32),
the `person` table, `[[filesystem.roots]]`, and `[ci.service.<id>]` / `[metrics.dora.<id>]`
config, and shells out to the same local `git` binary the blame sync already uses.

Delivered as **two PRs** split at the IPC boundary (§9).

---

## 2. Why the roadmap row's premise needed correcting

The roadmap says ownership is "derived from the existing GitHub + PagerDuty index". Verified
against the tree at `origin/main` = `826b76a1`, those two connectors are the *weakest*
available sources, and the strongest source is one the row does not mention.

| Signal the row implies | Verified reality |
| --- | --- |
| PagerDuty services / teams / escalation policies / on-call | **Not indexed.** `connectors/pagerduty-sync.ts` fetches only `GET https://api.pagerduty.com/incidents`. The sole ownership-adjacent field is `metadata.pagerduty_service_id` per incident. Incidents carry no assignee. |
| GitHub PR reviewers | **Not indexed.** `extractPrMetadataForIndex` (`connectors/github-sync.ts:67`) emits `number`, `repo`, `state`, `draft`, `merged`, `user`, `labels`, `mergeable`, `mergeable_state`, `merged_at`, `merge_commit_sha`. No reviewers. |
| GitHub changed-file paths | **Not indexed.** The same gap `nimbus decisions` already documents as capping its confidence at 0.86. |
| CODEOWNERS | **Not indexed anywhere.** The only occurrence in the repo is prose in `docs/SECURITY.md:301`. |
| `git_commit` items | `metadata = {repoRoot, sha, subject}`, **`authorId: null`**, capped at 40 commits per root (`connectors/filesystem-v2-sync.ts:198`). No files, no author. |

The signal that *is* genuinely indexed and genuinely about ownership:

- **`git_blame_line` (V32)** — `(repo_root, file_path, line_no) → commit_sha, author_name,
  author_email, author_time_ms`, maintained incrementally by
  `connectors/blame-index-sync.ts`. Per-file, per-person, and recency-bearing.
- Existing graph scaffolding: `person`, `source_file`, `workspace`, `repo` entities.
- `[ci.service.<id>]` / `[metrics.dora.<id>]` config, which is already a declared service
  catalog binding `serviceId → repo URNs + pagerduty service ids` (`metrics/dora-config.ts:8`).

**Decision.** This item builds **code ownership as the primary graph, with service ownership
as a transitive rollup over it**. It does not attempt team- or rotation-level service
ownership, because no team or rotation data exists in the index; that stays with the IDP
connectors demoted to S5. The roadmap row should be read as satisfied by authorship-derived
ownership, and the honesty limits in §7 say so explicitly at every read.

### 2.1 The broken link this exposed

`[ci.service.<id>]` binds a service to repo URNs of the form `github:owner/name`.
`git_blame_line` and `git_commit` key on `repo_root`, an **absolute local filesystem path**.
Nothing in the tree maps one to the other — `filesystem-v2-sync.ts`, `blame-index-sync.ts`
and `registered-roots-store.ts` contain zero occurrences of `remote`, `origin`, or
`github.com`. The graph holds `repo` entities (`github:owner/name`) and `workspace` entities
(`filesystem:<repoRoot>`) side by side with no edge between them.

Closing that gap is in scope, via the origin remote (§5.3). Without it the service rollup
cannot exist at all.

---

## 3. Scope

**In scope**

- `person → source_file` ownership edges, recency-weighted blame share.
- `person → directory` rollup edges.
- `person → service` rollup edges.
- `workspace → repo` binding derived from the local `git` origin remote.
- `repo → service` binding derived from `[ci.service.<id>]` / `[metrics.dora.<id>]` URNs.
- A debounced, single-flight post-sync pass, following the `glossary` / `decisions` precedent.
- Schema V51: three seeded relation types + one pass-state table.
- (PR B) An `ownership.*` IPC namespace and a `nimbus owners` CLI command.

**Explicitly out of scope**

- **No new built-in agent.** Registering in `AGENTS_RPC_HANDLERS` would collide directly with
  the in-flight HTTP-agents PR 2, which restructures that map and derives its `GET /v1/agents`
  route from it. An `agents.ownership` brief is a clean follow-up *after* that PR merges.
- No new connectors (Backstage, Cortex, OpsLevel, Port stay in S5).
- No CODEOWNERS parsing, no reviewer ingestion, no changed-file ingestion. Each would be a
  connector-surface change, not a derivation.
- No new security invariant, no HTTP write route, no egress-ledger participation (§8).

---

## 4. Schema version: V51, not V50

**V50 is reserved for the HTTP agents PR 3**, which claims it for a resolve-by-URL key
column. That PR is not yet started, so nothing on `main` shows the reservation — a
file-overlap check between the two branches would come back clean and both would still
silently break each other, because the schema version is a shared namespace enforced by the
migration ledger, and the second to merge loses.

This work therefore takes **V51** and leaves V50 unused on this branch. If PR 3 changes its
mind about V50, this spec is the record that V51 was chosen deliberately rather than
sequentially.

Current `CURRENT_SCHEMA_VERSION` is **49** (`index/local-index.ts:265`).

---

## 5. Design

### 5.1 Placement

New subsystem **`packages/gateway/src/ownership/`**, parallel to `glossary/` and `decisions/` —
the established location for a debounced post-sync derivation pass.

It writes graph edges through the existing `relationship-graph.ts` helpers
(`upsertGraphEntity` / `upsertGraphRelation`) rather than through `graph-populator.ts`, which
is strictly per-item and structurally cannot express a whole-file aggregate: blame ownership
is an aggregate over all lines of a file, and `git_blame_line` rows have no `item` to hang off
at all. **`packages/gateway/src/graph/` therefore needs no edits.**

### 5.2 Entities

`graph_entity.type` is free text with no FK constraint (`index/graph-v7-sql.ts`), so new
entity kinds require no migration.

| Entity type | External id | Status |
| --- | --- | --- |
| `person` | person id, or `git:<normalized-email>` when unresolved | existing |
| `source_file` | `file:<repoRoot>:<path>` | existing — converges with `syncCodeSymbolGraph` |
| `workspace` | `filesystem:<repoRoot>` | existing |
| `repo` | `<service>:<owner/name>` | existing |
| `directory` | `dir:<repoRoot>:<relPath>` | **new** |
| `service` | `service:<serviceId>` | **new** |

`source_file` reusing the exact external-id form already emitted by the code-symbol populator
is deliberate: ownership edges land on the *same* entity as `defined_in` / `in_repo` edges,
so the graph converges instead of forking into a parallel file universe.

### 5.3 Edges

```text
person    --owns-->          source_file    weight = recency-weighted share
person    --owns-->          directory      rolled up from descendant files
person    --owns-->          service        rolled up from all files in bound repos
directory --contains-->      source_file | directory
workspace --tracks_remote--> repo           from `git remote get-url origin`
repo      --belongs_to-->    service        from [ci.service.<id>] repo URNs
```

`repo --belongs_to--> service` deliberately **reuses an existing relation type** rather than
minting a fourth. `belongs_to` already expresses containment (`issue belongs_to repo`,
`index/graph-v7-sql.ts`); this extends the same chain one link outward.

The full service rollup path:

```text
service ←belongs_to← repo ←tracks_remote← workspace → source_file →owns→ person
```

### 5.4 Migration V51

Two artifacts, mirroring `index/graph-lineage-types-v40-sql.ts` (the V40 precedent that seeded
`upstream_refs` / `derived_from` / `monitors`). `graph_relation.type` is FK-constrained to
`graph_relation_type(name)`, so these rows must exist before any edge can be inserted.

```ts
// index/ownership-relation-types-v51-sql.ts
export const OWNERSHIP_RELATION_TYPES_V51_SQL = `
INSERT OR IGNORE INTO graph_relation_type (name, directed) VALUES
  ('owns', 1),
  ('contains', 1),
  ('tracks_remote', 1);
`;
```

```sql
-- index/ownership-pass-state-v51-sql.ts
CREATE TABLE IF NOT EXISTS ownership_pass_state (
  id              INTEGER PRIMARY KEY CHECK(id = 1),
  last_pass_at    INTEGER,
  last_duration_ms INTEGER NOT NULL DEFAULT 0,
  roots_total     INTEGER NOT NULL DEFAULT 0,
  roots_covered   INTEGER NOT NULL DEFAULT 0,
  roots_with_remote INTEGER NOT NULL DEFAULT 0,
  files_covered   INTEGER NOT NULL DEFAULT 0,
  files_excluded  INTEGER NOT NULL DEFAULT 0,
  services_bound  INTEGER NOT NULL DEFAULT 0,
  owners_emitted  INTEGER NOT NULL DEFAULT 0,
  entities_reaped INTEGER NOT NULL DEFAULT 0
);
```

The single-row `CHECK(id = 1)` shape follows `decision_pass_state`
(`index/decisions-v47-sql.ts:93`). Every counter exists to make a limit in §7 *reportable*
rather than implied — `roots_total = 0` is the single most common cause of an empty ownership
graph, and it must be visible, not silent.

Both use the `simpleStep` + `applySchemaStep` helpers per the `nimbus-db-migrations` skill;
neither needs a bespoke step.

### 5.5 Scoring

Each blame line's weight decays with the age of its authoring commit:

```text
w(line)              = 0.5 ^ ((now - author_time_ms) / halfLifeMs)
weighted(person, f)  = Σ w(line) over that person's lines in f
share(person, f)     = weighted(person, f) / Σ weighted(*, f)
```

Default `halfLifeMs` = 365 days, configurable. `author_time_ms` is already stored by
`git_blame_line`, so the decay input costs nothing to obtain.

Rollups aggregate **weighted line totals, then divide** — never an average of shares. Averaging
per-file shares would weight a 3-line file the same as a 3,000-line one.

**Emission threshold.** An edge is emitted for owners with `share ≥ 0.05`, capped at the top 10
by share. The share itself is the edge's `weight`.

The **true owner count before truncation** is recorded on the *target entity's* metadata
(`source_file` / `directory`), not on the edge. `upsertGraphRelation`
(`graph/relationship-graph.ts:102`) accepts `weight` but has **no metadata parameter**, and
nothing in the gateway reads `graph_relation.metadata` today. Extending that shared helper to
carry per-edge metadata would be a change to a populator-wide primitive for one caller's benefit;
recording it on the entity avoids that and is the better model anyway — "this file has 23 owners
and we show the top 10" is a fact about the file, not about any one of its edges. Entity
metadata carries `{ownerCount, truncated, totalWeightedLines}`, and `upsertGraphEntity` already
accepts it.

Per-`(person, path)` line counts are therefore deliberately **not** stored. `weight` is
sufficient to rank owners, and a consumer needing raw counts can recompute from `git_blame_line`.
This keeps the promise that `packages/gateway/src/graph/` needs no edits.

Capping is safe here in a way it explicitly was not for `correlates_with`: the comment on
`timelineCounterparts` (`graph/graph-populator.ts:624`) warns that truncating after a full clear
destroys edges the *other* side legitimately created. That hazard does not apply — the pass owns
`owns` and `contains` outright, and no other writer emits them.

Ties are broken by the **graph entity external id** ascending — not by "person id" loosely — so
the emitted set is deterministic regardless of whether an owner resolved to a `person` row or
fell back to `git:<email>`. Both key kinds are already `TEXT`: `person.id` is
`TEXT PRIMARY KEY` (`index/unified-item-v3-sql.ts:3`), so there is no integer-vs-string sort
hazard to reconcile. Naming the sort key explicitly keeps it that way if person ids ever change
shape.

### 5.5.1 Path exclusion

Blame indexing applies **no path filtering at all**: `gitBlameWindowFiles`
(`connectors/blame-index-sync.ts:70`) is `git log --since=Nd --name-only --pretty=format: -z`
and does not consult a filesystem root's `exclude` list. Lock files, generated output and
vendored trees are therefore fully present in `git_blame_line`.

Left alone this dominates the rollups: a churning `package-lock.json` is thousands of lines
attributed to whoever last ran the installer, and a directory rollup would report them as its
principal owner.

The ownership pass therefore filters **at aggregation time**, via an `ignore_globs` config key
matched with `Bun.Glob` against the root-relative path. Filtering here rather than in the blame
sync is deliberate and load-bearing: `git_blame_line` is shared with `nimbus why`'s provenance
lanes, which legitimately need to answer "who last touched this lock-file line". Narrowing what
gets blamed would silently degrade an unrelated shipped feature.

`Bun.Glob` is used rather than hand-rolled regex on purpose — a user-supplied pattern compiled
into a backtracking regex is a ReDoS surface, and glob-to-regex translation is exactly where
that bug is usually introduced.

Default `ignore_globs`:

```text
**/package-lock.json  **/yarn.lock  **/pnpm-lock.yaml  **/bun.lock  **/bun.lockb
**/Cargo.lock  **/poetry.lock  **/Gemfile.lock  **/composer.lock  **/go.sum
**/vendor/**  **/node_modules/**  **/dist/**  **/build/**  **/*.min.js  **/*.min.css
**/*.snap  **/__snapshots__/**  **/*.generated.*  **/*.pb.go  **/*_pb2.py
```

Excluded lines are removed from **both** numerator and denominator, so a file that is entirely
ignored simply produces no ownership edge rather than a degenerate 100% one. The count of
excluded files is recorded in `ownership_pass_state.files_excluded`, so the filter is auditable
rather than invisible. Setting `ignore_globs = []` disables filtering entirely.

### 5.6 Identity resolution

`author_email` → `normalizeEmail()` → `findPersonByCanonicalEmail()`
(`people/person-store.ts:6,65`).

- **Resolved** → graph `person` entity keyed by the person id, exactly as `syncPrGraph` does.
- **Unresolved** → graph `person` entity keyed `git:<normalized-email>`, labelled with the git
  `author_name`. **Never inserted into the `person` table.** A decade of drive-by committers
  and CI identities must not pollute people data, but dropping them would silently understate
  every denominator.
- **Bots** → skipped entirely: `author_name` ending in `[bot]`, or an email of exactly
  `noreply@github.com`. Note `*@users.noreply.github.com` addresses are **not** filtered —
  those are real GitHub users with private-email settings.

### 5.7 The repo ↔ remote bridge

`repo-remote.ts` runs `git remote get-url origin` per root and normalizes the result to
`owner/name`, handling `git@host:owner/name.git`, `https://host/owner/name.git`, and
suffix-less forms.

It reuses `blame-index-sync.ts`'s `runGit` discipline verbatim: `extensionProcessEnv({})` for
I1 child-process env scoping, a 30-second `AbortSignal.timeout`, and a `catch` that degrades to
an empty result rather than throwing. This is the same local `git` binary the blame sync
already invokes on the same roots — no new connector, no network egress.

Host is used only to pick the `repo` entity's service prefix (`github` / `gitlab` /
`bitbucket`); an unrecognised host yields no `tracks_remote` edge.

**When `origin` is absent**, the pass falls back to the sole configured remote **if and only if
exactly one exists**. With two or more non-`origin` remotes it emits no edge and logs the
ambiguity. "First available remote" is deliberately rejected: in a fork workflow `origin` is the
user's fork and `upstream` is canonical, so guessing binds a service to the wrong repository —
and it would do so silently, which is worse than no binding. Failing closed on ambiguity while
making it observable follows the `AmbiguousBindingWarning` precedent already in
`metrics/service-identity.ts:38`, where the resolver reports a contested binding rather than
letting the tie-break disappear.

**Remote URLs are not cached** between passes. One `git remote get-url` per root per debounced
pass (default 30s) is a single spawn against roots the blame sync is already spawning `git blame`
against up to 400 times. A cache would buy back a few milliseconds in exchange for an
invalidation rule and a staleness failure mode where a changed remote keeps a service bound to
the wrong repo until something evicts it — a silent-wrong-answer bug traded for an unmeasured
win. Revisit only if `ownership_pass_state.last_duration_ms` shows remote resolution to be
material.

---

## 6. Components and data flow

Five modules, each independently testable:

| Module | Responsibility | Depends on |
| --- | --- | --- |
| `blame-aggregate.ts` | Pure: scan `git_blame_line` for a root → weighted `(email, file)` totals. No graph, no I/O. | `git_blame_line` |
| `owner-identity.ts` | Email → person id or `git:` fallback; bot filtering. Pure, table-driven. | `people/person-store.ts` |
| `repo-remote.ts` | Origin remote → normalized `owner/name` + host. | injected `Bun.spawn` |
| `ownership-pass.ts` | Orchestration: aggregate → identity → dir rollup → service rollup → clear + emit. | the above |
| `ownership-refresh.ts` | Debounced single-flight wrapper, mirroring `decisions/decision-refresh.ts`. | `ownership-pass.ts` |

**Per pass:**

1. Enumerate git-aware `[[filesystem.roots]]`. Zero roots → no-op recording `roots_total = 0`.
2. Per root: resolve origin remote → upsert `workspace --tracks_remote--> repo`. No remote →
   skip that edge and continue; code ownership does not depend on it.
3. Aggregate blame into weighted `(email, file)` totals.
4. Resolve emails to persons; drop bots.
5. Clear `owns` / `contains` edges for this root, then emit file edges plus the
   `directory --contains-->` ancestor chain.
6. Roll weighted totals up each ancestor directory (root directory included); emit under the
   same threshold and cap.
7. For each configured service, match its repo URNs against `tracks_remote` edges; emit
   `repo --belongs_to--> service` and the rolled-up `person --owns--> service`.
8. Reap orphaned entities (below).
9. Write `ownership_pass_state`.

**Clearing discipline.** The pass clears `owns` / `contains` for the roots it processes and
re-emits wholesale, matching the populator's clear-then-emit pattern applied at pass scope. A
root that is processed and yields nothing correctly ends with zero edges rather than stale ones.

**Orphan reaping.** Clearing relations alone is not enough. `graph_relation` cascades on
`graph_entity` deletion, but not the reverse — so a deleted or moved file would leave its
`source_file` entity, and every ancestor `directory` entity, stranded forever. Nothing else
would ever collect them: `deleteGraphEntitiesForItemKeys` (`graph/relationship-graph.ts:120`)
deletes only `ITEM_LINKED_ENTITY_TYPES`, a list containing neither `source_file` nor
`directory`. Over a few months of refactoring, the graph would accumulate a shadow tree of paths
that no longer exist.

The pass therefore reaps, under two strict conditions that make it safe:

1. **Scoped by exact equality, never a path pattern.** Ownership-owned `source_file` and
   `directory` entities carry `service = 'ownership:<repoRoot>'`, and both the clear and the reap
   scope on that column with `=`. The pass never issues a `LIKE 'file:<root>:%'` prefix delete —
   a `repoRoot` containing `%` or `_` would silently widen such a pattern into other roots, and
   escaping LIKE wildcards around a user-supplied absolute path is a trap worth not entering.
   Equality on a dedicated marker column has none of that hazard, and lets both operations be a
   single bulk statement rather than a per-entity loop.
2. **Degree-0 across *all* relation types, not just this pass's.** A `source_file` may still
   carry `defined_in` edges from `syncCodeSymbolGraph`, which owns them. Deleting an entity that
   still has any edge would destroy another populator's work and cascade its relations away. The
   zero-degree test is what makes reaping the two populators' shared `source_file` entity safe
   from either side.

Because a degree-0 entity has, by definition, no relations to cascade, the delete is inert
beyond removing the row itself.

The degree-0 test is written as `NOT EXISTS`, not `NOT IN`. Both happen to be correct here only
because `graph_relation.from_id` / `to_id` are `TEXT NOT NULL` (`index/graph-v7-sql.ts:19-20`) —
a single NULL inside a `NOT IN` subquery makes the entire predicate never match, which would
silently reap nothing and look like the feature working. `NOT EXISTS` does not depend on that
constraint holding, and uses the existing `idx_graph_relation_from` / `_to` indexes.

**Wiring.** `platform/assemble.ts` constructs the refresher gated on `[ownership].enabled`
(the `decisionsRefresher` pattern — construction-gated, so a disabled pass leaves it `undefined`
rather than idling), triggers it alongside the other two at the post-sync seam
(`assemble.ts:531–532`), and registers `stop()` into `sidecarStops`.

**Config** — a new `[ownership]` section in `packages/gateway/src/config/nimbus-toml.ts`
(`DEFAULT_NIMBUS_OWNERSHIP_TOML` + `parseNimbusOwnershipToml` +
`loadNimbusOwnershipFromConfigDir`, following the `[glossary]` / `[decisions]` sections at
lines 1533 and 1636 — these live *in* `nimbus-toml.ts`, not in per-feature config files):

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Construct and run the pass |
| `debounce_ms` | `30000` | Post-sync debounce, matching `[decisions]` |
| `half_life_days` | `365` | Recency decay half-life |
| `min_share` | `0.05` | Emission threshold |
| `max_owners_per_path` | `10` | Emission cap |
| `ignore_globs` | see §5.5.1 | Paths excluded from aggregation |

Defaulting to enabled matches **both** existing derivation passes: `DEFAULT_NIMBUS_GLOSSARY_TOML`
and `DEFAULT_NIMBUS_DECISIONS_TOML` are each `enabled: true`. (`[briefs]` is the default-off one,
because it opens an HTTP surface.) This pass is cheaper than either — local, deterministic, and
network-free, with no model call at all.

`min_share` is a float and, like `[decisions]`'s `min_confidence`, its parse branch **must
precede the integer branch**, which would truncate `0.05` to `0` and then discard it via the
`n <= 0` guard. That exact trap is called out in `nimbus-toml.ts:1663–1665`.

---

## 7. Honesty and failure posture

Every degradation is **partial and recorded**, never fatal. The pass never blocks sync;
`onError` warns without killing the scheduler.

| Condition | Behaviour |
| --- | --- |
| No git-aware `[[filesystem.roots]]` | No-op; `roots_total = 0` recorded |
| Root is not a git repo | Skipped; counted in `roots_total`, not `roots_covered` |
| No origin remote, exactly one other remote | That remote is used |
| No origin remote, two or more others | No `tracks_remote` edge; ambiguity logged, never guessed |
| No remotes at all | File + directory ownership still emitted; no service rollup for that root |
| Unrecognised remote host | Same as no remote |
| All of a file's lines excluded by `ignore_globs` | No edge for that file, not a degenerate 100% owner |
| Email resolves to no person | `git:<email>` entity; the line still counts toward denominators |
| `git` absent from PATH | Empty result, pass completes |
| No `[ci.service.<id>]` declared | File + directory ownership only; `services_bound = 0` |

**Five limits, following the `decisions` precedent of stating limits per-read rather than
absorbing them silently.** Each is backed by a counter in `ownership_pass_state` so the PR B
read surface can report it as a fact rather than a disclaimer:

1. Ownership covers only git-aware `[[filesystem.roots]]`. None configured → legitimately empty.
2. `MAX_BLAME_FILES = 400` per root per tick (`connectors/blame-index-sync.ts:149`), so early
   runs are genuinely partial. Coverage is reported, never implied complete.
3. **Blame measures who wrote lines, not who is accountable.** There is no CODEOWNERS, no
   reviewer data, and no PagerDuty team or rotation in the index. This is authorship-derived
   ownership and every read must say so.
4. Service rollup requires *both* a `[ci.service.<id>]` declaration *and* a matching origin
   remote.
5. Vendored, generated and lock files inflate a single author's share — whoever ran the
   generator owns the output by this measure. The default `ignore_globs` (§5.5.1) covers the
   common cases, but a project-specific generated path that is not listed still skews its
   directory. `files_excluded` reports how much was filtered, so the mitigation is visible
   rather than assumed total.

---

## 8. Security posture

No new invariant. Read-only derivation over already-indexed local data:

- No `connectors.dispatch`, so nothing appends to the egress ledger (I29/D22 untouched).
- No HTTP route, so `WRITE_ROUTE_ALLOWLIST` stays at **12** and
  **`security-invariants.test.ts` is not edited at all** — the shared hot spot with the
  parallel HTTP-agents session is avoided outright, not merely coordinated. Verified: that
  file's only allowlist count assertions are `WRITE_ROUTE_ALLOWLIST → 12` at lines 418 and 1451.
- The one child-process spawn (`git remote`) goes through `extensionProcessEnv({})`, satisfying
  **I1** the same way the existing blame sync does.
- All SQL is bound-param, identifiers via `escapeIdentifier`, writes via `dbRun`/`dbExec`
  (**I9**, **I14**).
- PR B's Tauri allowlist bump (**I7**, 103 → 106) touches only
  `packages/ui/src-tauri/src/gateway_bridge.rs:535` — a Rust file outside the parallel
  session's scope.

---

## 9. Delivery: two PRs

**PR A — derivation** (this spec's primary deliverable)

- V51 migration: three relation types + `ownership_pass_state`.
- `packages/gateway/src/ownership/` — all five modules.
- `git remote` bridge and the `workspace → repo` edge.
- `[ownership]` config + the `assemble.ts` debounced seam.
- Tests per §10.

Carries **no IPC, no CLI, no Tauri, no `security-invariants.test.ts`** — essentially zero
collision surface with the parallel session.

**PR B — read surface**

- `ipc/ownership-rpc.ts`: `ownership.forPath`, `ownership.forService`, `ownership.status`.
- Registration in `ipc/server/dispatchers.ts`.
- `nimbus owners <path>` CLI.
- Tauri `ALLOWED_METHODS` 103 → 106.

Small enough to follow immediately, and it can land after the HTTP-agents PR 2 merges,
removing even the theoretical count-assertion race.

### Parallel-work constraints honoured

None of the following are touched by either PR: `ipc/agents-rpc.ts`, `ipc/http-server.ts`,
`ipc/http-write-routes.ts`, `ipc/http-route-auth.ts`, `egress/*`, `cli/src/commands/prove.ts`,
`scripts/structure-audit/check-nimbus-invariants.ts`.

---

## 10. Testing

Per the `nimbus-testing` layering; real SQLite and fresh temp dirs, no DB-layer mocks.

**Unit**

- Decay arithmetic, including the `age = 0` and `age = halfLifeMs` boundaries (the latter must
  yield exactly 0.5).
- Rollup aggregates weighted totals, not an average of shares — asserted with a 3-line file and
  a 3,000-line file whose naive average would invert the answer.
- Threshold + cap: an 11th owner above `min_share` is dropped, and the pre-truncation count is
  recorded in metadata. Tie-break determinism.
- Identity: resolved, unresolved-`git:` fallback, `[bot]` filtering, and the explicit
  `*@users.noreply.github.com` **non**-filtering case.
- Remote-URL normalization across ssh / https / `.git`-suffixed / suffix-less / unrecognised-host,
  plus remote selection: `origin` present; `origin` absent with exactly one other remote; `origin`
  absent with two others (**must** emit nothing and log, not pick one); no remotes.
- `ignore_globs`: a matched path is removed from numerator **and** denominator; a fully-excluded
  file yields no edge rather than a 100% owner; `ignore_globs = []` disables filtering; a
  `repoRoot` or path containing glob metacharacters does not corrupt matching.
- Config parsing: `min_share = 0.05` survives the float branch (a regression here silently
  truncates to `0`, disabling the threshold entirely rather than erroring), and every key
  falls back to its default when absent or malformed.

**Integration**

- Seed `git_blame_line` + config, run the pass, assert the exact edge set including
  `contains` chains and the service rollup.
- **Idempotence:** run twice, assert an identical graph — clear-and-re-emit must not accumulate.
- **Retirement:** a file whose blame is removed loses its edges.
- **Orphan reaping:** a deleted file's `source_file` entity and its now-childless `directory`
  ancestors are gone after the next pass, and `entities_reaped` counts them.
- **Reaping safety (the load-bearing one):** a `source_file` that still carries a `defined_in`
  edge from `syncCodeSymbolGraph` **survives** reaping with that edge intact, even after its
  `owns` edges are cleared. Red-prove this one by weakening the degree-0 test to a
  degree-0-in-`owns`/`contains` test and watching the code-symbol edge vanish.
- **Reaping scope:** a second root whose `repoRoot` contains `%` and `_` is untouched by the
  first root's reap — the regression test for the `LIKE`-prefix delete that §6 rejects.

**Degradation** — one test per row of the §7 table, each asserting partial success plus the
correct recorded state.

**Migration** — V51 seeds exactly three relation types, creates the pass-state table, and is
re-runnable.

**Test hygiene** (carried from the PR 1 post-mortem): any test that reads a source file resolves
paths from `import.meta.dir`, never the process CWD, and is verified by running the suite from a
second working directory. Every guard is red-proven — break the thing it protects, watch it
fail, revert exactly.

---

## 11. Open items deliberately deferred

- **`agents.ownership` brief** — a follow-up PR once HTTP-agents PR 2 has merged and
  `AGENTS_RPC_HANDLERS` is stable.
- **Teaching `nimbus expert` to consume these edges.** Its `subBlame` lane
  (`agents/expert.ts`) currently queries `item`/`person` for `service = 'github'` and does not
  read `git_blame_line` at all. Rewiring it to real ownership edges is a clear improvement, but
  couples a PR to an agent's brief shape and e2e tests; it belongs on its own.
- **CODEOWNERS ingestion**, reviewer ingestion, and changed-file ingestion — each a connector
  surface change, and each would materially strengthen this graph. Worth a roadmap note.
