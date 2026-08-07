# Ticket depth — Jira + Linear (S1 / workstream A, PR D1)

> **Status:** design approved 2026-08-07. Implementation branch
> `dev/asafgolombek/ticket-depth-jira-linear`. Consumer: `nimbus pre-mortem` (the next PR).

## Where this sits

Spine **S1 (Local Brain)** has two remaining roadmap rows: the implicit-knowledge triad remainder
(`pre-mortem` + `negotiate`) and the answer-quality surfaces. Grounding those rows against the tree
showed both agents want evidence the index does not hold, so workstream A was re-cut as five PRs,
each depth PR landing immediately before the agent it unblocks:

| | PR | Migration | Feeds |
| --- | --- | --- | --- |
| **D1** | **Ticket depth — Jira + Linear metadata (this spec)** | none | `pre-mortem` |
| A1 | `nimbus pre-mortem <epic-id>` — 13th built-in agent | none | — |
| D2 | Review edges — GitHub PR reviews → the `reviewed` relation | none | `negotiate` |
| D3 | On-call + incident attribution — PagerDuty tools, on-call item type, `on_call_for` | V53 | `negotiate` |
| A2 | `nimbus negotiate` — 14th built-in agent | none | — |

## Why this PR exists

`nimbus pre-mortem <epic-id>` is specified as "analyze similar historical epics to identify why
comparable work was delayed or failed". None of that is derivable today:

- **Epics are unidentifiable.** Jira and Linear each index a single flat `type: "issue"`.
  `jira-sync.ts:148` *requests* `issuetype` and `status` from the API and then stores neither —
  `metadata` is `{jiraId, key}` (`jira-sync.ts:273`). Linear stores `{linearId, identifier}`
  (`linear-sync.ts:180`) and its GraphQL selection set (`linear-sync.ts:14`) asks only for
  `id, identifier, title, description, updatedAt, url, creator`.
- **Nothing carries time-to-done.** No created date, no resolution date, no due date, no changelog.
  The only timestamp reaching the index is `updated` → `modifiedAt`.
- **No hierarchy.** Neither sync stores a parent or project reference, so an epic's children cannot
  be found even if the epic could be.

So the agent cannot select its input, cannot tell delivered from in-flight, and cannot measure
duration. This PR is the data layer; the agent is the next one.

## Scope

**In:** the two sync mappers (`connectors/jira-sync.ts`, `connectors/linear-sync.ts`), a normalized
metadata contract shared by both, an optional `SyncContext.historyFloorMs` honored by those two
connectors, and the backfill path — `rebody`'s eligibility generalization plus
`nimbus index rebody --since <days>`.

**Out:** any new item type, any new relation type, any schema change, any agent code, anything
touching GitHub or PagerDuty (those are D2/D3), resumable mid-walk cursors (deferred — see
§ Rate limits), and Jira `fields.resolution` (deferred — see § the normalized vocabulary).

## Design

### 1. Jira

Extend the `fields` list at `jira-sync.ts:148` with `created`, `resolutiondate`, `parent` and
`duedate`. `issuetype` and `status` are already fetched and only need storing.

**Caveat, stated rather than discovered later:** `fields.parent` is populated on team-managed
(next-gen) projects. Classic company-managed projects express epic membership through a per-instance
custom field (`customfield_100xx`, whose number differs per Jira site), and this PR does **not**
chase per-instance custom fields — `parent_key` is simply absent there. Jira epics remain
identifiable on classic projects via `issue_type`; only the child→epic link is missing. If that
turns out to matter for real usage, resolving the epic-link field id from
`/rest/api/3/field` is a follow-up, not a silent addition here.

### 2. Linear

Extend `SYNC_QUERY`'s selection set with `createdAt`, `completedAt`, `canceledAt`, `dueDate`,
`state { name type }`, `parent { identifier }`, and `project { id name }`.

### 3. The normalized metadata contract

Both mappers write the same keys, so a consumer never branches on service:

| Key | Jira source | Linear source |
| --- | --- | --- |
| `issue_type` | `fields.issuetype.name` | `null` (Linear has no issue type — see § Epic analogue) |
| `status` | `fields.status.name` | `state.name` |
| `status_category` | normalized from `fields.status.statusCategory.key` | normalized from `state.type` |
| `status_category_raw` | `fields.status.statusCategory.key` | `state.type` |
| `created_at_ms` | `fields.created` | `createdAt` |
| `resolved_at_ms` | `fields.resolutiondate` | `completedAt` ?? `canceledAt` |
| `due_at_ms` | `fields.duedate` | `dueDate` |
| `parent_key` | `fields.parent.key` | `parent.identifier` |
| `project_id` | `null` | `project.id` |
| `meta_v` | `1` | `1` |

`status_category` is the load-bearing key, and it is **normalized at the mapper**, not passed
through. Teams rename workflow states freely, so Done-vs-not must never come from the display name;
but the two platforms also disagree on vocabulary, so passing the raw value through would force
every consumer to branch on service — contradicting the whole point of a shared contract.

The normalized vocabulary is `todo` / `in_progress` / `done` / `canceled`:

| Normalized | Jira `statusCategory.key` | Linear `state.type` |
| --- | --- | --- |
| `todo` | `new` | `backlog`, `unstarted` |
| `in_progress` | `indeterminate` | `started` |
| `done` | `done` | `completed` |
| `canceled` | *(unreachable — see below)* | `canceled` |

`status_category_raw` carries the platform's own value alongside it, so a consumer that needs the
finer distinction (Linear's `backlog` vs `unstarted`) can still reach it and normalization never
destroys information.

**The asymmetry that matters: `canceled` is unreachable on Jira.** Jira folds "Won't Do" / "Canceled"
resolutions into the `done` status category — the distinction lives in `fields.resolution`, which
this PR does not fetch. So a consumer counting canceled work would see zero for Jira and non-zero
for Linear and conclude, wrongly, that Jira teams never abandon epics. `pre-mortem` must therefore
**not** compare cancel rates across services, and must treat a Jira `done` as "closed, outcome
unknown" rather than "delivered". If distinguishing abandoned from delivered work turns out to
matter, adding `fields.resolution` is a scoped follow-up.

Timestamps are stored as epoch milliseconds, matching every other numeric metadata key in the tree
(`opened_at_ms` in `pagerduty-sync.ts`, `mergedAtMs` in `github-sync.ts`). A field that is absent or
unparseable is omitted, never stored as `0` or `NaN` — a consumer must be able to tell "no due date"
from "due at the epoch".

### 4. The epic analogue is asymmetric, and says so

Jira has an Epic issue type. Linear does not — its hierarchy is project and parent-issue. Rather
than introduce a `linear:project` item type (which would pull in embedding-routing, body-depth and
graph decisions and break this PR's shape), the epic analogue for Linear is the `project_id`
metadata key: `pre-mortem` groups Linear issues by project and Jira issues by
`issue_type = 'Epic'` / `parent_key`.

This asymmetry is a stated limitation of the consuming agent's output, not a hidden one.

`parent_key` and `project_id` are independent and may both be present on the same Linear issue —
`parent_key` carries `parent.identifier` for both services, so plain parent→child nesting is uniform
across them, and `project_id` exists only as Linear's epic-shaped grouping. A consumer building a
hierarchy uses `parent_key` on either service; a consumer looking for "the epic" uses
`issue_type = 'Epic'` / `parent_key` on Jira and `project_id` on Linear.

### 5. Depth interaction: none

`applyDepth` (`index/item-store.ts:181`) strips only `body` / `bodyPreview` / `bodyTruncated`.
Metadata passes through unchanged at every depth, including `metadata_only` — which is correct by
the depth's own name. A test asserts this directly, because it is the first question a reviewer will
ask.

### 6. No migration

`item.metadata` is a JSON column, and `upsertIndexedItem`'s conflict clause is
`metadata = excluded.metadata` (`index/item-store.ts:130`) — a wholesale replace. New keys need no
schema change, and a re-walk fully rewrites the value rather than merging into a stale one.

## Backfill

Already-indexed rows keep their old two-key metadata until the connector re-walks them, and neither
sync will re-walk a closed ticket on its own: Jira's cursor is a JQL floor on `updated`
(`jiraJqlFromCursor`) and Linear's is an `updatedAt` filter. A ticket that closed a year ago and was
never touched again is invisible to every future incremental sync — and closed historical tickets
are precisely `pre-mortem`'s input.

### The corpus is bounded to 30 days, not just the metadata

This is the finding that most changes this PR's shape, and the first version of this design missed
it. **Clearing a cursor does not produce a history walk.** Both connectors cold-start from a
hardcoded 30-day floor — `jira-sync.ts:302` and `linear-sync.ts:212` each declare
`const initialSyncDepthDays = 30`, feeding `updated >= -30d` (Jira) and `now − 30 × 86_400_000`
(Linear). `rebody`'s own doc comment already documents this class of connector as "bounded-window"
and warns that a Confluence `rebody` recovers roughly the last 30 days, not the whole wiki.

The consequence is larger than stale metadata: **Nimbus has never indexed a Jira or Linear ticket
that was not updated within 30 days of the connector's first sync**, or touched at some point since.
The closed historical epics `pre-mortem` is meant to learn from are, for the most part, not in the
index at all — so no amount of metadata backfill would have surfaced them. D1 must widen the corpus,
not merely enrich it.

Also worth recording, because it shapes the fix: `Syncable.initialSyncDepthDays` is declared on the
interface (`sync/types.ts:52`) and set by every connector, but **nothing outside `connectors/` reads
it** — a grep for `.initialSyncDepthDays` outside that directory returns nothing, and each connector
uses its own local constant internally. The field is decorative today. There is no config knob for
it either. So "make the depth configurable" means wiring a consumer path that does not currently
exist, not flipping an existing switch.

**Design: an explicit, bounded history floor, opted into per connector.** `SyncContext` gains an
optional `historyFloorMs`. When present, Jira and Linear cold-start from it instead of their 30-day
constant; connectors that do not honor it are unaffected (the field is optional and opt-in, and the
two that honor it in D1 say so in their doc comments — a partial-adoption seam that is documented
rather than implied). It is set only by an explicit, user-initiated re-walk: `nimbus index rebody`
gains `--since <days>`, defaulting to the connector's own constant so existing behavior is
unchanged when the flag is absent.

Bounded-by-parameter rather than "fetch everything" is deliberate. An unbounded walk is precisely
the shape most likely to trip the rate-limit behavior described below, and a history window the user
chose is a window they can widen again.

**`nimbus index rebody` cannot be reused as-is.** Its eligibility query is
`SELECT DISTINCT service FROM item WHERE body_complete = 0` (`ipc/index-rebody-rpc.ts:340`), and
`resolveTargetServices` (`:374`) hard-rejects an explicit `service` with no pending rows —
`-32602`, deliberately, to refuse spending API quota on a service with nothing to recover. Jira and
Linear rows already have complete bodies, so `rebody --service jira` would be rejected today.

**Decision: generalize `rebody`'s notion of "pending" from bodies to indexed depth.** A const map of
service → required metadata version — `REBODY_REQUIRED_META_VERSION`, living in
`ipc/index-rebody-rpc.ts` beside the existing `REBODY_IMPROVABLE_SERVICES` — drives a second
eligibility reason:

```sql
SELECT DISTINCT service FROM item
WHERE body_complete = 0
   OR (service = ? AND COALESCE(json_extract(metadata, '$.meta_v'), 0) < ?)
```

Consequences that are part of this design, not incidental:

- The quota protection is **preserved** — a service whose rows are all at the current `meta_v` and
  all body-complete is still rejected with `-32602`. The guard's reason broadens; its direction does
  not.
- `dryRun` and the progress payload currently report a single pending count that means "bodies".
  They gain a per-reason breakdown (`pending_body`, `pending_meta`), because a count that silently
  changes meaning is worse than no count.
- The command keeps the name `rebody`. Renaming it would break a shipped IPC method, a shipped CLI
  subcommand and `@nimbus-dev/client`; the doc comment and `docs/cli-reference.md` are updated to
  describe it as recovering indexed *depth*, of which bodies were the first kind.
- D2 and D3 reuse this mechanism by bumping their own services' required version — the map exists so
  the next depth PR adds a row, not a mechanism.

Rejected alternatives: a separate `nimbus index resync` (two commands doing nearly the same thing);
a cursor-clearing migration (no migration has ever done this, and it spends the user's API quota
without being asked); forward-only with no backfill (leaves the consuming agent blind to exactly the
closed epics it exists to analyze).

### Rate limits during a history walk

A wider window means more pages, so the failure mode is worth stating precisely rather than
assuming the existing rate limiter covers it. Both syncs call `ctx.rateLimiter.acquire(service)`
before walking, and Jira raises `RateLimitError` mid-walk on a 429 (`jira-sync.ts:165`). The
scheduler's handler (`sync/scheduler.ts:656`) transitions health to `rate_limited` and **returns
without persisting a cursor**.

So a rate-limited backfill is *safe but not resumable*: rows upserted before the abort persist, and
nothing is corrupted, but the cursor never advances, so the next tick restarts the walk from the
same cold floor and re-fetches the same early pages. On a large account with a wide `--since`, the
tail may never be reached — the walk keeps paying for pages it already has.

Two things follow, both in scope for D1: `--since` is bounded by an explicit value rather than
offering an "everything" mode, and `rebody`'s progress output states plainly when a run ended
rate-limited and that it made no cursor progress — a silent retry loop that looks like activity is
the failure this call-out exists to prevent.

**Deferred:** making the Jira/Linear walks resumable mid-run (persisting a partial cursor on abort)
is a change to the `SyncResult` contract that every connector shares, and it is a correctness
question about interrupted pagination in general — not about ticket depth. It belongs in its own PR;
this design does not silently take it on.

## What this still cannot support

Stated here so the consuming agent inherits the bound rather than discovering it:

- **There is no plan to be late against.** Neither sync carries sprint commitments, original
  estimates, or a changelog of status transitions. "Delayed" can therefore mean two different things
  and the agent must not conflate them: *late* is well-defined only for the minority of tickets that
  carry a `due_at_ms`; for everything else the honest statement is **cycle time
  (`resolved_at_ms − created_at_ms`) against the median of comparable work**.
- **No transition history**, so "sat in code review for three weeks" is not derivable — only total
  duration.
- **Jira closure is outcome-blind.** `done` covers delivered and abandoned alike (see § the
  normalized vocabulary), so cross-service cancel-rate comparison is off the table.
- Coverage is a function of the backfill actually having run, **and of the `--since` window the user
  chose**. `pre-mortem` reports how many candidate tickets carried depth data and what history
  window the index actually covers per service, in the style of the `decisions` agent's truncation
  counts. "No comparable epics found" and "no history indexed" are different answers and must not
  render identically.

## Testing

- Unit, per mapper: an API payload with every field present maps to the full key set; a payload with
  each field missing omits that key rather than writing a zero; `status_category` is read from the
  category/type field and is unaffected by a renamed display status.
- Unit: the normalization table is total — every documented Jira `statusCategory.key` and every
  Linear `state.type` maps to a normalized value, and an unrecognized input maps to a stated
  fallback rather than silently becoming `todo`. Jira never yields `canceled`.
- Unit: `historyFloorMs` absent ⇒ each connector cold-starts at its own 30-day constant (existing
  behavior, asserted so the opt-in cannot regress the default); present ⇒ the JQL floor / `updatedAt`
  filter is built from it.
- Unit: `--since` maps to `historyFloorMs`, and rebody's report distinguishes a completed walk from
  one that ended `rate_limited` with no cursor progress.
- Unit: `applyDepth` at `metadata_only` and `summary` preserves every metadata key.
- Unit: the eligibility SQL selects a service with `body_complete = 1` but a stale `meta_v`, and
  rejects one that is current on both counts (the `-32602` path).
- Integration: seed an item at the old two-key metadata, run the mapper against a fixture payload,
  assert the row's metadata is replaced wholesale rather than merged.
- The connector contract tests for both connectors continue to pass unchanged — no tool surface
  moves in this PR.

## Verification notes

Every claim above was read from the tree at `0a32751f`, not from the roadmap. The two that most
warrant re-checking during implementation, because they were assumptions this design had to correct
once already:

1. `rebody`'s rejection path — the original plan assumed the command could simply be pointed at Jira.
2. Whether any *other* production writer touches `item` metadata for these services. Grep the SQL
   (`grep -rn "INSERT INTO item\b" --include=*.ts | grep -v test`), never the helper name — that
   grep is what caught `deployment/annotate.ts` as a second independent `INSERT INTO item` during
   the resolve-by-URL work.
