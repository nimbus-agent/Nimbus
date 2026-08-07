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
metadata contract shared by both, and a backfill path for already-indexed rows.

**Out:** any new item type, any new relation type, any schema change, any agent code, anything
touching GitHub or PagerDuty (those are D2/D3).

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
| `status_category` | `fields.status.statusCategory.key` | `state.type` |
| `created_at_ms` | `fields.created` | `createdAt` |
| `resolved_at_ms` | `fields.resolutiondate` | `completedAt` ?? `canceledAt` |
| `due_at_ms` | `fields.duedate` | `dueDate` |
| `parent_key` | `fields.parent.key` | `parent.identifier` |
| `project_id` | `null` | `project.id` |
| `meta_v` | `1` | `1` |

`status_category` is the load-bearing key. Teams rename workflow states freely, so Done-vs-not must
come from Jira's `statusCategory.key` (`new` / `indeterminate` / `done`) and Linear's `state.type`
(`backlog` / `unstarted` / `started` / `completed` / `canceled`) — **never** the display name.

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

## What this still cannot support

Stated here so the consuming agent inherits the bound rather than discovering it:

- **There is no plan to be late against.** Neither sync carries sprint commitments, original
  estimates, or a changelog of status transitions. "Delayed" can therefore mean two different things
  and the agent must not conflate them: *late* is well-defined only for the minority of tickets that
  carry a `due_at_ms`; for everything else the honest statement is **cycle time
  (`resolved_at_ms − created_at_ms`) against the median of comparable work**.
- **No transition history**, so "sat in code review for three weeks" is not derivable — only total
  duration.
- Coverage is a function of the backfill actually having run. `pre-mortem` reports how many
  candidate tickets carried depth data, in the style of the `decisions` agent's truncation counts.

## Testing

- Unit, per mapper: an API payload with every field present maps to the full key set; a payload with
  each field missing omits that key rather than writing a zero; `status_category` is read from the
  category/type field and is unaffected by a renamed display status.
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
