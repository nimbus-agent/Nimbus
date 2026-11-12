# Plan — Incident engine IC1: `item_history` (V94) and `--at`


Status: APPROVED by Antigravity (round 2, 2026-11-12).
Spec: `docs/superpowers/specs/2026-11-12-incident-engine.md` (approved, Antigravity round 3): § 2 (OR-10-8,
OR-10-19), § 4 (the IC1 row), § 5.1 (IC1's design), § 7 (acceptance), § 8 (stated bounds), § 9 (review log:
the writer is in `upsertIndexedItem`, no foreign key, batched pruning, `--at` on three commands).
Roadmap rows: Phase 10 *Point-in-time index queries* (`docs/roadmap.md:2028`) and the acceptance criterion at
`:2062`. IC1 adds no HITL type, no invariant, no egress class, no model step and no `ALLOWED_METHODS` entry.

After IC1: every sync-time write of an incident, PR, ticket, error-issue or data-quality item records the
CHANGES to an allowlist of state keys in a new table `item_history` (schema V94), written inside
`upsertIndexedItem`; `nimbus ask`, `nimbus query` and `nimbus search` accept `--at <time>` and answer as the index
stood then (existence and the allowlisted state keys; titles and bodies stay as of now, and the answer says so);
the table is pruned daily in batches (`[index] history_retention_days`, default 180).

## Spec deviations (checked against the code; each has its evidence and the correction this plan makes)

Where the spec is right, the plan follows it. Where the code disagrees, the correction below is binding for
IC1, and the later slices it touches are named.

1. **There is no `[index]` config section or reader (brief item 4: "the config reader for `[index]`").**
   `git grep -n "\[index\]"` over `packages/` finds nothing; `SECTION_LOADERS`
   (`config/config-explain.ts:80`) has no `index` id. Correction: a new `config/index-toml.ts` modeled on
   `config/briefing-toml.ts` (its `intInRange` at `:94`, `parseNimbusTomlBriefing` at `:262`, the
   `loadNimbusBriefingFromConfigDir` loader at `:292`), registered in `SECTION_LOADERS` (`config-explain.test.ts` fails until
   it is). A value outside `7..3650` or not an integer falls back to 180 with a recorded section fallback; it is
   never clamped. `0` is NOT "disabled" (unlike `[audit] tool_call_log_retention_days`): an unbounded history
   table is not a mode this project offers.
2. **The roadmap already reserves the name `item_history` for a later phase, with a different shape.** `M8
   Time-Travel` (`docs/roadmap.md:3004`) describes a "per-write snapshot row to a `item_history` shadow table",
   30-day retention in `[index].timetravel_retention_days`; line `:2867` makes `item_history` a "hard
   prerequisite" of a later reasoning-replay phase. The spec (OR-10-19, § 5.1) builds `item_history` NOW as
   allowlisted state-change rows with `[index] history_retention_days` (180). Correction: the docs task rewrites
   the M8 row and the `:2867` dependency to say the table and the flag shipped in Phase 10 IC1 with this narrower
   shape; M8's remaining scope is a per-write snapshot of more keys, and it reuses `history_retention_days`
   instead of introducing `timetravel_retention_days`. This is a roadmap edit, not a code change.
3. **"The filter runs in SQL before ranking" is true of fusion and scoring, NOT of vector candidate selection.**
   `search/vec-store.ts` (`buildVectorChunkQuery`, `:35`) takes the KNN top-k from the `vec0` subquery FIRST
   (`WHERE embedding MATCH ? AND k = ?`), then `CROSS JOIN`s `embedding_chunk` and `item` and applies
   `service`/`type`/`since` as `AND` clauses AFTER the k nearest are fixed. A temporal clause appended there has
   the same property: a later item can never be RETURNED, but it can occupy a KNN slot and starve a valid one.
   Correction: when an `--at` clause is present the vector arm requests the maximum `k` (500, the existing
   clamp at `vec-store.ts` `Math.min(500, ...)`) instead of `limit * 25`, and the plan states the residual
   recall bound (a query whose nearest 500 chunks are all post-T returns no vector hits; the keyword arm is
   unaffected because FTS applies the clause inside the same statement as `MATCH`). Everything downstream of
   candidate selection (RRF, recency, service priority) sees only admitted items, which is the spec's actual
   guarantee ("a later item can never outrank an earlier one").
4. **Neither example provider timestamp in § 5.1 is indexed.** PagerDuty `last_status_change_at` is not in
   `buildPagerdutyMetadata` (`connectors/pagerduty-sync.ts:66`); IC2 adds `resolved_at_ms`. A PR's
   `merged_at` IS indexed (canonical key, `connectors/pr-meta.ts:158`). Correction: `source_at_ms` is filled only
   from keys the mapper already writes: a PR `state` or `merged` change to merged carries `merged_at`; every
   other row has `source_at_ms` NULL. IC2 may register more.
5. **Jira and Linear write no assignee and no priority; GitLab issues write no state.** `jiraDepthMetadata`
   (`connectors/jira-sync.ts:425`) and `linearDepthMetadata` (`connectors/linear-sync.ts:201`) write `status`,
   `status_category`(`_raw`), `created_at_ms`, `resolved_at_ms`, `due_at_ms`, `parent_key`, `issue_type`/
   `project_id`; no assignee or priority key exists to track. GitLab issue metadata is `{iid, number, project,
   repo, action}` (`connectors/_lib/gitlab/events.ts:246`): nothing to track. The brief's "assignee keys" are
   real only for PagerDuty (`assignee_emails`) and Sentry (`assignedTo`). The allowlist below is derived from the
   writers, not from the spec's prose; the spec's wording ("status, state, severity, priority, urgency, assignee
   keys, merged, draft, resolution and due date") names key CLASSES, and `priority` has no writer in the tracked
   set (PagerDuty's priority name is stored as `severity`).
6. **Status is metadata JSON, never a column** (`item` has no status column; `index/item-store.ts:111-130`
   writes id, service, type, external_id, title, body*, url, canonical_url, resolve_key, modified_at, author_id,
   metadata, synced_at, pinned). Every tracked key is a `json_extract(metadata, '$.<key>')`.
7. **`modified_at` is not a change clock for every tracked type.** It is the provider's `updated_at` for
   PagerDuty, Jira, Linear and GitHub (`modifiedMsFromGithubTimestamps`, `connectors/github-sync.ts:234`), but
   Bigeye sets it to the sync time on every upsert (`bigeye-dq-mapping.ts`, `modifiedAt: ctx.syncedAt`), Monte
   Carlo to `firstSeenAt` (never updated by a status change), and Sentry to `lastSeen` (an event, not a status
   change). The reconstruction rule (below) therefore uses `modified_at <= T` as proof of "unchanged since T"
   only where the table declares `modifiedAtTracksChange: true`.
8. **`alert` (the spec's list of types) does not exist yet.** The JSM alert item type arrives in IC2; IC1's table
   has no `jira`/`alert` entry. IC2 MUST add one in its own PR (recorded in Risks).
9. **Two `deleteItem` neighbours do not go through `deleteItemByPrimaryKey`.** `deleteAllItemsForService`
   (`index/item-store.ts:282`, used by `LocalIndex.removeConnectorIndexData`, `index/local-index.ts:497`) and
   `commands/data-delete.ts:88` (`DELETE FROM item WHERE service = ?`) remove a whole service. These are owner
   erasures, not upstream deletions. Correction: neither writes `__deleted` rows; BOTH erase that service's
   `item_history` rows (an erasure that leaves a change log of the erased items would be a privacy defect), through
   `deleteItemHistoryForService` in the one writer module. `replaceItemSetRows` (`index/item-set-store.ts:84`)
   and the other `deleteItem` callers do reach `deleteItemByPrimaryKey`, so they write `__deleted`.
10. **A third index.** § 5.1 lists `(item_id, observed_at_ms)` and `(service, type, observed_at_ms)`. Daily
    pruning is `observed_at_ms < cutoff` with no leading equality; neither index serves it, so each 5,000-row
    batch would scan the table. Correction: add `item_history_observed (observed_at_ms)`. Additive; the cost is one
    more index entry per change row (a change row is rare relative to upserts).
11. **D46 does not exist yet and the spec splits it across slices.** `check-nimbus-invariants.ts` ends at D45
    (`briefing-confined`, `:2401`). Spec § 5.1 names the confinement "D46(b)"; (a) and (c) arrive with IC3 and
    IC5. Decision for review: IC1 introduces D46 and ships ONLY sub-rule (b) (`item-history-confined`), says in
    `SECURITY-INVARIANTS.md` that (a) and (c) are reserved by the incident-engine spec, and moves every "D10–D45"
    range to "D10–D46". The alternative (naming it D24-style, as MB1 and MB4 did for `work_snapshot` and
    `chat_read_marker`) would contradict the spec's own cross-references.
12. **`upsertIndexedItem` is not transactional.** Its callers' batches are (`ctx.writeBatch`), but `clips/
    clip-ingest.ts`, `briefs/brief-save.ts` and `glossary/glossary-project.ts` call it bare. History is written for
    tracked (service, type) pairs only, which are all sync-written, but the plan still wraps read-old, item
    upsert and history insert in `db.transaction(...)()` for tracked pairs (a nested call is a SAVEPOINT in
    bun:sqlite), so a crash cannot leave a changed item without its change row. Untracked pairs take the
    existing path byte-for-byte.
13. **`nimbus query --since` is a duration, not an instant, and no `yesterday-09:00` parser exists.** CLI
    `parseSinceDurationToMs` (`packages/cli/src/lib/parse-since.ts`) accepts `7d`/`24h`; the gateway's
    `parseRelativeSinceToWindowMs` (`index/item-list-query.ts:87`) accepts `d|h|m|s`. Correction: the parser is a
    new gateway module (`util/point-in-time-parse.ts`) so the zone is the gateway's (`gatewayZone()`,
    `util/zoned-time.ts:80`); the CLI sends the raw string. `--at` combined with `--since` is REFUSED: `--since`
    filters on the current `modified_at`, which after T means something else.
14. **`nimbus ask` has two routes that cannot be time-travelled.** `runAskInner` (`engine/run-ask.ts:1348`) can
    route to `dispatchPlan` (connector steps), and the Mastra agent's tools include live connector reads, the
    graph, `oncall_now`, generated tools, user MCP tools and the connector-write door. Correction (design
    below): `--at` forces the conversational route (as `--devil` does, `:1365`) and restricts the agent to
    point-in-time-safe tools; a turn with `--at` is never offered a write or a live read.

Spec claims verified correct (no deviation): the next migration is V94 (`CURRENT_SCHEMA_VERSION` = 93 at
`index/local-index.ts:290`; V93 is `simpleStep(92, 93, ..., BRIEFING_V93_SQL)` at `index/migrations/runner.ts:784`);
the real SQL chokepoint is `upsertIndexedItem` (`index/item-store.ts:65`, `ON CONFLICT(id) DO UPDATE` at `:117`);
deployments live in `deployment_items` and `deployment/annotate.ts` writes its own `item` INSERT (not tracked,
as the spec says); `-sql.ts` files are skipped by the static scan (`scripts/structure-audit/lib.ts:344`).

## Design decisions

**The tracked set, derived from the writers (`index/item-history-keys.ts`, `ITEM_HISTORY_SPECS`).** Keyed by
`"<service>:<type>"`. Each spec: `keys` (each `{ key, always? }`; `always` means the mapper writes that key on
EVERY upsert, so an absent key means null and the change is recorded; without it an absent key means "this
write did not say" and records nothing, which is how a carry-forward or a conditional `putIfNonEmpty` stays
silent), `born` (`{ key, kind: "ms" | "iso" }`, the metadata key holding the provider's creation time),
`modifiedAtTracksChange`, and optional `sourceAt` rules. Evidence per row:

| `service:type` | tracked keys (`always`) | `born` | tracks `modified_at` | writer |
| --- | --- | --- | --- | --- |
| `pagerduty:incident` | `status`*, `severity`, `urgency`, `assignee_emails`* (array), `resolved_by_email`* | `opened_at_ms` (ms) | yes (`updated_at`) | `pagerduty-sync.ts:66-95` |
| `github:pr` | `state`, `merged`, `draft` | `opened_at_ms` (ms) | yes | `github-sync.ts:138` + `pr-meta.ts:158` |
| `gitlab:pr` | `state`, `merged` | `opened_at_ms` (ms) | no | `_lib/gitlab/events.ts:143` + `pr-meta.ts` |
| `bitbucket:pr` | `state`, `merged` | `opened_at_ms` (ms) | no | `bitbucket-sync.ts:121` |
| `github:issue` | `state`, `due_at_ms` | none (the issue mapper writes no creation key) | yes | `github-sync.ts:481` |
| `jira:issue` | `status`, `status_category`*, `resolved_at_ms`, `due_at_ms` | `created_at_ms` (ms) | yes | `jira-sync.ts:425` |
| `linear:issue` | `status`, `status_category`*, `resolved_at_ms`, `due_at_ms` | `created_at_ms` (ms) | yes | `linear-sync.ts:201` |
| `sentry:error_issue` | `status`*, `level`*, `assignedTo`* (object, projected) | `firstSeen` (ms) | no | `sentry-issue-mapping.ts:77` |
| `montecarlo:data_quality_test` | `status`*, `severity`* | `firstSeenAt` (iso) | no | `monte-carlo-dq-mapping.ts:58` |
| `bigeye:data_quality_test` | `slaStatus`*, `anomaly`* | none | no | `bigeye-dq-mapping.ts` |

`sourceAt`: on `github:pr`, `gitlab:pr` and `bitbucket:pr`, a `state` change whose new value is `merged` and a
`merged` change whose new value is `true` take `source_at_ms` from `metadata.merged_at` (absent on Bitbucket, so
null there). Noisy counters (`count`, `userCount`, `lastSeen`, `additions`, `labels`, `mergeable_state*`) are
deliberately NOT tracked: they change on most syncs and carry no state.

**Value normalization (`normalizeHistoryValue`).** A value is recorded as TEXT, capped at 256 characters (cut by
code points, never mid-surrogate): string as is; number and boolean as `String(v)`; `null` as SQL NULL; an array
of scalars as its elements sorted by code-unit comparator and joined with `,` (so a re-ordered
`assignee_emails` is not a change); an object as its string/number `id`, else its `name`, else NULL (Sentry's
`assignedTo`). Anything else (nested objects, arrays of objects) is NULL. Titles, bodies and free text are not
in any `keys` list, so they cannot be recorded.

**The writer contract (`index/item-history.ts`, the ONLY module with a write verb on `item_history`).**
- `readItemHistoryBefore(db, id, service, type)`: returns `undefined` with NO query when `(service, type)` has
  no spec (the cost bound: an untracked item pays one `Map.get`); otherwise one PK read
  `SELECT metadata FROM item WHERE id = ?` returning `{ existed: false }` or `{ existed: true, metadata }`.
- `recordItemUpsertHistory(db, before, next)`: no prior row writes ONE `__created` row (`old_value` NULL,
  `new_value` NULL, `observed_at_ms = syncedAt`) and no per-key rows (a first observation is a baseline, not a
  change). A prior row whose metadata JSON string equals the new one writes nothing (the fast path: re-syncs of
  unchanged items parse nothing). Otherwise both JSON strings are parsed once (a parse failure of the OLD one
  is treated as "no information": nothing recorded, never a throw into a sync) and each tracked key is
  compared after normalization; a key absent from the new metadata records nothing unless it is `always`.
  One INSERT per changed key. `observed_at_ms` is the row's `syncedAt` (the sync pass's own clock), so a test
  controls time through the production seam and the table is ordered by the same clock `sync_state` uses.
- `recordItemDeleteHistory(db, id, nowMs)`: called by `deleteItemByPrimaryKey` BEFORE the delete, for tracked
  pairs only; one `__deleted` row.
- `deleteItemHistoryForService(db, service)`, `pruneItemHistory(db, { cutoffMs, batchSize, maxBatches })`.
- Cost bound per tracked upsert: one PK read, at most two `JSON.parse`, at most `keys.length` INSERTs, all in the
  savepoint. Per untracked upsert: zero extra statements. Per prune batch: one indexed `DELETE`.

**Reconstruction (`index/item-history-at.ts`, read-only; reads of `item_history` are unrestricted by D46(b)).**
For an item that exists now, at instant T, with `H0(service)` = `MIN(observed_at_ms)` of that service's history
rows (one indexed seek per tracked service, computed once per query and bound as parameters):
- `seen` = the item's earliest `__created` row; `born` = the provider creation time from the spec;
  `covered` = `COALESCE(seen, H0(service))`; `tracks` = the spec's `modifiedAtTracksChange` (untracked pairs:
  true, with no keys).
- OUT when the latest `__created`/`__deleted` row with `observed_at_ms <= T` is `__deleted`, or `born > T`.
- Otherwise existence: `born <= T`, else (`born` unknown) `seen <= T`, else `tracks AND modified_at <= T`; if none
  holds the item is GAP (it may or may not have existed).
- State: IN when `T >= covered`, or `tracks AND modified_at <= T`; otherwise GAP (its state at T cannot be
  reconstructed: it may have changed after T before history began).
- An IN item's value for a tracked key at T is the `old_value` of that key's earliest history row with
  `observed_at_ms > T` (the state before the first change we observed after T), else the current value.
- Stated bounds (go in the docs): observation time is the sync's, not the provider's, so a change made at 08:50
  and synced at 09:05 reads as of 09:05; an item deleted since T has no `item` row and is not shown; the first
  observed state stands in for earlier states (the honesty line says so); untracked item types are admitted only
  when `modified_at <= T` (content unchanged since T) and otherwise counted as gaps.

**The SQL predicate (`buildAtClause`).** `buildAtClause(db, atMs, alias)` returns `{ sql, params }`:
`(<classExpr>) = 'in'`, a single `CASE` over correlated subqueries, every constant bound (I9), alias from the
closed set `"i" | "item"`. Skeleton (`:T` is the bound instant; the per-spec lookups are `CASE a.service || ':' ||
a.type WHEN ? THEN ?` branches built from `ITEM_HISTORY_SPECS`; `h0` is the same shape over the H0 map):

```sql
CASE
  WHEN (SELECT h.key FROM item_history h WHERE h.item_id = a.id AND h.key IN ('__created','__deleted')
          AND h.observed_at_ms <= :T ORDER BY h.observed_at_ms DESC, h.id DESC LIMIT 1) = '__deleted' THEN 'out'
  WHEN <born> IS NOT NULL THEN CASE WHEN <born> > :T THEN 'out' ELSE <state> END
  WHEN <seen> IS NOT NULL THEN CASE WHEN <seen> <= :T THEN <state> ELSE 'gap' END
  WHEN <tracks> = 1 AND a.modified_at <= :T THEN <state>
  ELSE 'gap'
END
-- <state> := CASE WHEN COALESCE(<seen>, <h0>) IS NOT NULL AND :T >= COALESCE(<seen>, <h0>) THEN 'in'
--                 WHEN <tracks> = 1 AND a.modified_at <= :T THEN 'in' ELSE 'gap' END
-- <born>  := CASE spec WHEN 'ms' THEN CAST(json_extract(a.metadata, ?) AS INTEGER)
--                      WHEN 'iso' THEN CAST(strftime('%s', json_extract(a.metadata, ?)) AS INTEGER) * 1000 END
-- <seen>  := (SELECT MIN(h.observed_at_ms) FROM item_history h WHERE h.item_id = a.id AND h.key = '__created')
```

`json_extract` raises on malformed JSON (memory note): `born` is wrapped in `CASE WHEN json_valid(a.metadata)
THEN ... END`. The same builder yields `buildAtGapClause` (`= 'gap'`) for the Gaps count. The clause is spliced as
the LAST conjunct of a statement's `WHERE`, so its parameters append after the existing ones and before `LIMIT`.

**Where the clause lands (all of them, or `--at` leaks).**
- keyword arm: `LocalIndex.searchWithFtsOrderRank` and `searchWithoutFtsOrdered` (`index/local-index.ts`,
  via `searchFiltersAndParams`), and `search/hybrid-internal.ts` `loadBm25Hits` (`:68`);
- vector arm: `search/vec-store.ts` `buildVectorChunkQuery` (`:35`) through `VectorSearchChunkOptions.at`,
  `search/dual-search.ts` `DualSearchOptions.at`, `runVectorSearch` (`hybrid-internal.ts:112`), with `k` forced
  to 500 (deviation 3);
- `HybridSearchOptions.at` (`search/hybrid-types.ts:17`) and `IndexSearchQuery.atMs` (`local-index.ts:95`);
- browse paths: `buildItemListSql` (`index/item-list-query.ts:37`, new optional `at` field, composes with
  `service`/`type`/`ids`/`idInSql`; `federation/query-gate.ts:144` never sets it, so I17/D13 is untouched) and
  `LocalIndex.fetchMoreItems` (`local-index.ts:785`, new optional `atMs`).

**Annotation.** After retrieval, `annotateStateAt(db, items, atMs)` adds `asOf: { atMs, state: { <key>: value |
null }, basis: "history" | "current" }` to each returned item, from ONE batched read of the result ids' history
rows (at most 500 ids). Only tracked keys appear. Titles and bodies are never rewritten.

**The disclosure (`pointInTimeDisclosure`, one builder, three consumers).** Lines, in this order:
`As of <ISO instant> (<zone>). State keys come from item history; titles and bodies are as of now.`;
when the earliest history row for the in-scope services is later than T:
`History starts <ISO>; state before then is the first observed state.`; and always
`## Gaps` + `<n> item(s) could not be placed at that time (their state changed after it and the change predates
item history, or their birth is unknown); they are not shown.` The count `<n>` is exact for `query` (same
filters, `= 'gap'`), and for `ask`/`search` it is the count of gap-class KEYWORD matches (same `MATCH`, same
service/type filter); gap-class vector-only candidates are not counted (stated bound). With no history rows at
all: `Item history is empty; only items unchanged since that time are shown.`

**`nimbus ask --at`.** The CLI sends the raw string as `at` on `agent.invoke` (the method `nimbus ask` uses,
`cli/src/commands/ask.ts` `buildInvokeParams`). `dispatchAgentInvoke` (`ipc/server/inline-handlers.ts:140`)
parses it (`-32602` on a bad value or a future instant) and carries `pointInTimeMs` on `AgentInvokeContext`
(`ipc/agent-invoke.ts`), into `gateway-main.ts:289`'s `RunAskParams` (`engine/run-ask.ts:76`) and into the
request's `AgentRequestContext` (`engine/agent-request-context.ts:45`). `runAskInner` treats it like `--devil`:
skip the classifier, require `canUseConversation` (else the existing no-LLM error), never `dispatchPlan`.
- **Local-router path** (no tools): `buildLocalIndexedContext` (`run-ask.ts:935`) passes `atMs` to its
  `searchRankedAsync`, both `searchRanked` calls and the fallback-term loop; the `githubIssueContextItemsForRepo`
  pass (`:998`) is skipped under `--at` (it reads the current issue list); `formatContextItem` (`:852`) carries
  `asOf` into the context JSON; `indexCountFor`/`indexCountLine` (the "N indexed" line) is omitted under `--at`
  (it is a current count).
- **Mastra agent path**: `toolsFor` (`engine/agent.ts:661`) returns ONLY `searchLocalIndex`,
  `fetchMoreIndexResults` and `resolvePerson` when the request context has `pointInTimeMs`; no `traverseGraph`,
  negation tools, `oncall_now`, session memory, generated, user-MCP, computer-use or connector-write tools.
  `searchLocalIndex` (`:276`) and `fetchMoreIndexResults` (`:334`) read the instant from the request context
  and pass it to the index; their results carry `asOf`. The agent instructions get one appended sentence naming
  the instant.
- Both paths end in `appendDeterministicDisclosures` (`engine/run-conversational-agent.ts:325`): a new optional
  `pointInTime` param carries the already-built disclosure lines, appended deterministically and streamed as a
  final chunk like the existing lines, never asked of the model. The `agent.invoke` result echoes
  `asOfMs`; the CLI prints a stderr warning and sets a non-zero exit code if it passed `--at` and the echo is
  missing (an older gateway silently ignoring the param would otherwise answer from current data).
- `engine.askStream` (the UI/editor path) does not read `at` in IC1 (stated bound; it is on the Tauri list, the
  param change does not touch `ALLOWED_METHODS`).

**`nimbus query --at`.** `index.queryItems` (`ipc/diagnostics-rpc.ts:499` `parseQueryItemsParams`, `:626`
`rpcIndexQueryItems`) gains `at` (string). Refused with `-32602`: `at` with `notTouching`/`noDownstreamIncident`
(do not compose), with `sinceMs`/`untilMs`. `index.querySql` (`rpcIndexQuerySql`, `diagnostics-rpc.ts:685`) refuses a present `at`. The result gains
`asOf` (instant, zone, history start or null) and a third `QueryItemsGaps` member
`{ excludedUnplaceable: number }`; the CLI (`cli/src/commands/query.ts`, `QueryItemsGaps` and `printQueryResult`)
prints the disclosure through the existing `formatGapLine` path. `nimbus query --sql ... --at ...` is refused in
the CLI before any IPC. A gateway that returns no `asOf` for a request that sent `at` makes the CLI refuse
(older gateway).

**`nimbus search --at`.** `index.searchRanked` (`ipc/server/inline-handlers.ts:481`) gains `at`; a request with
`at` and without `envelope: true` is refused (`-32602`; an undisclosed historical answer is the failure this
slice exists to prevent). The envelope gains `asOf`; the disclosure lines join `notes`, which the CLI already
prints to stderr (`cli/src/commands/search.ts`), and `parseSearchRankedResponse` carries `asOf` so the CLI can
refuse an envelope without it. stdout stays the plain item array; each item carries `asOf`.

## File map

New:
- `packages/gateway/src/index/item-history-v94-sql.ts`
- `packages/gateway/src/index/item-history-keys.ts` (+ `.test.ts`)
- `packages/gateway/src/index/item-history.ts` (+ `.test.ts`)
- `packages/gateway/src/index/item-history-retention.ts` (+ `.test.ts`)
- `packages/gateway/src/index/item-history-at.ts` (+ `.test.ts`)
- `packages/gateway/src/index/migrations/runner-v94.test.ts`
- `packages/gateway/src/config/index-toml.ts` (+ `.test.ts`)
- `packages/gateway/src/util/point-in-time-parse.ts` (+ `.test.ts`)
- `packages/gateway/test/integration/index/point-in-time.acceptance.test.ts`

Modified: `index/migrations/runner.ts`, `index/migrations/runner.test.ts`, `index/local-index.ts` (+ test),
`index/item-store.ts` (+ test), `index/item-list-query.ts` (+ test), `commands/data-delete.ts` (+ test),
`config/config-explain.ts`, `platform/assemble.ts`, `search/{vec-store,dual-search,hybrid,hybrid-internal,
hybrid-types}.ts`, `ipc/diagnostics-rpc.ts`, `ipc/server/inline-handlers.ts`, `ipc/agent-invoke.ts`,
`gateway-main.ts`, `engine/{run-ask,run-conversational-agent,agent,agent-request-context}.ts`,
`packages/cli/src/commands/{ask,query,search}.ts` (+ tests), `packages/cli/src/lib/search-ranked-response.ts`,
`scripts/structure-audit/check-nimbus-invariants.ts` (+ test), and the docs listed at the end.

## Tasks (test first; red-prove every guard by reverting the production line and watching the test fail)

### Task 0 - Preconditions

1. The worktree is `C:\gitrep\Nimbus\.claude\worktrees\p10-ic1` (absolute path, never nested), created from
   current `main`: `git -C C:\gitrep\Nimbus worktree add C:\gitrep\Nimbus\.claude\worktrees\p10-ic1 -b dev/asaf/p10-ic1 main`.
   Verify `git rev-parse --abbrev-ref HEAD` before every commit. The spec and this plan are STRIPPED from the
   branch before the PR (specs and plans never land on main).
2. `bun install`, then on Windows `pwsh -NoProfile -File ./scripts/build-sandbox-helper-win32.ps1` (a fresh
   worktree has no helper). Editor diagnostics in a fresh worktree are stale: trust `bun run typecheck`.
3. Re-read `CURRENT_SCHEMA_VERSION` (`index/local-index.ts:290`). The plan assumes 93 and a free V94. The spec
   says numbers follow merge order; if IC2 or another slice merged first, renumber every `V94`/`94`, file
   names included. Also re-run `git grep -n "item_history" -- packages` (expected: nothing) and
   `git grep -n "\[index\]" -- packages` (expected: nothing).

### Task 1 - Schema V94 `item_history`

Files: `index/item-history-v94-sql.ts` (new), `index/migrations/runner.ts`, `index/local-index.ts`,
`index/migrations/runner.test.ts`, `index/migrations/runner-v94.test.ts` (new).

1. `runner-v94.test.ts` first, modeled on `runner-v93.test.ts`:
   - a database migrated to `CURRENT_SCHEMA_VERSION - 1` then to current gains an empty `item_history`;
     `PRAGMA user_version` equals `CURRENT_SCHEMA_VERSION`; `CURRENT_SCHEMA_VERSION` equals
     `maxRegisteredIndexedSchemaVersion()` and is `>= 94`;
   - the columns are exactly `id, item_id, service, type, key, old_value, new_value, observed_at_ms,
     source_at_ms` (`PRAGMA table_info`), `item_id`/`service`/`type`/`key`/`observed_at_ms` NOT NULL, the
     others nullable, and the three indexes exist (`PRAGMA index_list`), including `item_history_observed`;
   - NO foreign key and NO trigger: `PRAGMA foreign_key_list(item_history)` is empty; insert an `item` row and
     history rows, `DELETE FROM item`, the history rows survive (the point of the design);
   - `EXPLAIN QUERY PLAN` for `DELETE FROM item_history WHERE id IN (SELECT id FROM item_history WHERE
     observed_at_ms < ? ORDER BY observed_at_ms LIMIT 5000)` mentions `item_history_observed` (red-prove by
     dropping the index in a scratch DB);
   - re-running the step is idempotent (`IF NOT EXISTS`).
   Run `bun test packages/gateway/src/index/migrations/runner-v94.test.ts`: expected RED (no table).
2. `item-history-v94-sql.ts` exports `ITEM_HISTORY_V94_SQL` (an array, one statement per element, as V93):
   ```sql
   CREATE TABLE IF NOT EXISTS item_history (
     id INTEGER PRIMARY KEY,
     item_id TEXT NOT NULL,
     service TEXT NOT NULL,
     type TEXT NOT NULL,
     key TEXT NOT NULL,
     old_value TEXT,
     new_value TEXT,
     observed_at_ms INTEGER NOT NULL,
     source_at_ms INTEGER
   );
   CREATE INDEX IF NOT EXISTS item_history_item ON item_history (item_id, observed_at_ms);
   CREATE INDEX IF NOT EXISTS item_history_type ON item_history (service, type, observed_at_ms);
   CREATE INDEX IF NOT EXISTS item_history_observed ON item_history (observed_at_ms);
   ```
   Header comment: the writer module is the only writer (static D46(b)); NO foreign key and NO delete trigger
   by design (a delete must not erase the history that says the item existed; a service erasure deletes by
   `deleteItemHistoryForService`); no backfill (nothing earlier is recoverable); `observed_at_ms` plays the role
   of the checklist's `created_at`; the third index serves pruning.
3. `runner.ts`: import it (next to `BRIEFING_V93_SQL`, `:15`) and add
   `simpleStep(93, 94, "item history, sync-time state changes (Phase 10 IC1)", ITEM_HISTORY_V94_SQL)` after
   `:784`. `local-index.ts:290`: `CURRENT_SCHEMA_VERSION = 94`.
4. `runner.test.ts:825-828` ("CURRENT_SCHEMA_VERSION is 93 ...") becomes 94 in the name and the assertion. Run
   `git grep -nE "(toBe|toEqual)\(94\)|user_version: 94"` and `git grep -nE "(toBe|toEqual)\(93\)"` over
   `packages/` and `scripts/`: only `runner.test.ts` and `scripts/lib/preflight-gates.ts`/
   `scripts/structure-audit/check-status-drift.test.ts` hits were seen at plan time; fix any real pin, leave
   unrelated 93s alone.
5. GREEN: the V94 test, then `bun test packages/gateway/src/index` (fresh-build and coverage runner tests build a
   database to `CURRENT_SCHEMA_VERSION`). Then `bun run audit:status-drift` is RED until the docs task bumps
   "schema V93": note it, do not fix the docs yet.

### Task 2 - The tracked set `index/item-history-keys.ts`

1. `item-history-keys.test.ts` first:
   - **writer-derived pins (the memory note: queries filter on keys no connector writes):** for every spec
     row, build a REAL metadata object from the REAL writer and assert each tracked key and the `born` key are
     present: `buildPagerdutyMetadata` is module-private, so drive `syncPagerdutyIncidentItems`
     (`pagerduty-sync.ts`) with a recording `SyncContext` (`connectors/connector-sync-test-helpers.ts`
     `syncTestContext`); `extractPrMetadataForIndex` (exported, `github-sync.ts:138`) for GitHub; `
     bitbucketPrMetadata` (exported, `bitbucket-sync.ts:121`); `gitlabMrMetadata` (exported, `_lib/gitlab/events.ts:143`);
     `mapSentryIssueToItem` (`sentry-issue-mapping.ts:53`), `mapMonteCarloIncidentToItem` (`monte-carlo-dq-mapping.ts:20`) and
     `mapBigeyeIssueToItem` (`bigeye-dq-mapping.ts:20`); Jira and Linear through their syncables with fake replies
     (`jira-sync.test.ts` and `linear-sync.test.ts` show the fixtures). A key that no writer produces fails
     the test (this is the guard against a spec table that names fiction);
   - `normalizeHistoryValue`: string, number, boolean, null, undefined (not recorded), array (sorted, comma
     joined, order-insensitive), object with `id` / with only `name` / with neither, nested object -> null,
     256-character cap including a surrogate pair at the boundary (never splits it);
   - `specFor("github", "pr")` returns the spec, `specFor("slack", "message")` undefined; `ITEM_HISTORY_SPECS`
     keys all match `^[a-z_]+:[a-z_]+$` (the class SQL binds them, but the closed shape is asserted);
   - the `sourceAt` rule returns `merged_at` only for a merged transition.
   RED first (module missing).
2. Implement `ITEM_HISTORY_SPECS` (the table above, frozen), `specFor`, `normalizeHistoryValue`,
   `historyKeysOf(spec)`. No `??` default that cannot be reached; no `err instanceof Error ? ... : ...`.
3. GREEN: `bun test packages/gateway/src/index/item-history-keys.test.ts`.

### Task 3 - The writer `index/item-history.ts`

1. `item-history.test.ts` first (real SQLite via `openMemoryIndexDatabase`/`LocalIndex.ensureSchema`, no mocks at
   the DB layer):
   - untracked pair: `readItemHistoryBefore` returns `undefined` and a counting wrapper around `db.query` sees
     ZERO calls (the cost bound);
   - tracked, no prior row: one `__created` row with `old_value`/`new_value` NULL and `observed_at_ms ===
     syncedAt`, no key rows;
   - tracked, identical metadata JSON: zero rows and no `JSON.parse` (spy on `JSON.parse` through DI of the
     parser, or assert via a poisoned old metadata string that equals the new one);
   - a changed `status` writes one row with both values, `service`/`type`/`item_id` filled; two changed keys
     write two rows; an unchanged tracked key writes none; an untracked key changing (title-like) writes none;
   - an absent non-`always` key records nothing (a Jira `due_at_ms` omitted: no row), an absent `always` key
     records `old -> NULL` (a Sentry `assignedTo` cleared), an explicit `null` records `old -> NULL`;
   - array normalization (re-ordered `assignee_emails`: no row); a 300-character value is stored as 256;
   - `source_at_ms`: PR `state: open -> merged` with `merged_at` set carries it; `open -> closed` carries NULL;
   - malformed OLD metadata JSON: no throw, no rows; malformed NEW cannot happen (the caller serialises it);
   - `recordItemDeleteHistory` writes `__deleted` for tracked and nothing for untracked;
   - `deleteItemHistoryForService` removes exactly that service's rows;
   - `pruneItemHistory`: with 12,001 rows older than the cutoff and `batchSize 5000`, three `DELETE` batches run
     (assert the batch sizes through the returned `{ deleted, batches }`), rows at or newer than the cutoff
     survive, `maxBatches` stops early and reports `more: true`;
   - the table is not written by anything else: `git grep` is the static rule's job (Task 5).
   RED first.
2. Implement the five functions with `dbRun` (I14), bound parameters (I9), a code-unit comparator wherever an
   ordering is needed (no bare `.sort()`, Sonar S2871), each function under cognitive complexity 15. The module
   imports nothing from `item-store.ts` (`item-store.ts` imports it).
3. GREEN: `bun test packages/gateway/src/index/item-history.test.ts`.

### Task 4 - Wiring the chokepoint, the delete path and the erasures

Files: `index/item-store.ts`, `index/item-store.test.ts`, `index/local-index.ts`, `commands/data-delete.ts`
(+ tests).

1. Tests first (`item-store.test.ts` additions, real SQLite):
   - `upsertIndexedItem` for a tracked pair: first call writes `__created`; a second call with a changed
     `status` writes the change row IN THE SAME TRANSACTION (force the history insert to throw by planting a
     `BEFORE INSERT ON item_history` trigger that `RAISE(ABORT)`s, and assert the item row is unchanged: the
     savepoint rolled the pair back); an untracked pair's behaviour and statement count are unchanged;
   - every route reaches the writer: `upsertIndexedItemForSync`, a direct `upsertIndexedItem` caller, and
     `upsertNimbusItemIntoItemTable` (the spec's "all reach it");
   - `deleteItemByPrimaryKey` writes `__deleted` for a tracked item, nothing for an untracked or missing one;
     `deleteItemByServiceExternal` and `replaceItemSetRows` inherit it;
   - `deleteAllItemsForService` and `LocalIndex.removeConnectorIndexData` (`local-index.ts:497`) leave NO
     history rows for that service and no `__deleted` rows; `runDataDelete` (`commands/data-delete.ts:88`)
     likewise (extend `data-delete.test.ts`, which already seeds `chat_read_marker`);
   - a re-created item (deleted, then upserted again) yields `__created`, `__deleted`, `__created`.
   RED first.
2. `upsertIndexedItem` (`item-store.ts:65`): compute `before = readItemHistoryBefore(...)` after the 64 KB
   guard; when `before === undefined` run the existing body unchanged; otherwise wrap `dbRun(INSERT ...)` and
   `recordItemUpsertHistory(...)` in `db.transaction(() => ...)()`; `syncGraphFromIndexedItem` stays outside it,
   as today. `deleteItemByPrimaryKey` (`:263`) selects `service, type` with the existing `id` read and calls
   `recordItemDeleteHistory` before `DELETE`. A new optional trailing parameter `nowMs = Date.now()` on
   `deleteItemByPrimaryKey` serves tests. `deleteAllItemsForService` (`:282`) and `data-delete.ts` call
   `deleteItemHistoryForService` in the same transaction as their item delete.
3. GREEN: `bun test packages/gateway/src/index/item-store.test.ts packages/gateway/src/index/local-index.test.ts
   packages/gateway/src/commands/data-delete.test.ts packages/gateway/src/index/item-set-store.test.ts`.

### Task 5 - Static rule D46(b) `item-history-confined`

Files: `scripts/structure-audit/check-nimbus-invariants.ts` and its `.test.ts`; `docs/SECURITY-INVARIANTS.md`
(Task 15).

1. Pattern to mirror: `checkChatReadMarkerConfinement` (`check-nimbus-invariants.ts:993`, constants at `:982-991`,
   wiring at `:4926`, anchors at `:4599`) with `work-snapshot-confined` (`:944`) as the second reference. D45
   (`briefing-confined`, `:2401`) is a different shape (import and network confinement) and is not the model.
2. Tests first in `check-nimbus-invariants.test.ts`, a `describe("D46(b) - item_history is written only by its
   module", ...)` in the shape of the chat-read-marker block (`:5699-5776`): a GOOD fixture set (the module with
   `INSERT INTO item_history` / `DELETE FROM item_history`; `index/item-store.ts` naming the two `record*`
   functions; `index/local-index.ts` and `commands/data-delete.ts` naming `deleteItemHistoryForService`;
   `index/item-history-retention.ts` naming `pruneItemHistory`; a reader `SELECT ... FROM item_history` in
   `agents/_lib/x.ts`; the DDL file), the control `checkItemHistoryConfinement(GOOD) === []`, then single
   violations each asserting exactly `item-history-confined`: `dbRun(db, "INSERT INTO item_history ...")` in a
   syncable; `DELETE FROM item_history` in an RPC; `UPDATE item_history`; `INSERT OR REPLACE INTO item_history`;
   `DROP TABLE item_history`; `ALTER TABLE item_history`; quoted/bracketed/newline-split forms
   (`INSERT\n  INTO\n  item_history`); a syncable naming `recordItemUpsertHistory`; a file other than the two
   deleters naming `deleteItemHistoryForService`; a file other than the retention module naming
   `pruneItemHistory`. Non-violations: the word in a comment, reads, test files. A real-repository test feeds
   `iterateSourceFiles()` and expects `[]`. RED first.
3. Implement `checkItemHistoryConfinement(files)` with `D46_SRC`, `D46_STORE = index/item-history.ts`,
   `D46_DDL = index/item-history-v94-sql.ts` (allow-listed only so a synthetic set can carry it: the real scan
   never visits `-sql.ts` files, `scripts/structure-audit/lib.ts:344`; say so in a comment), the write-verb regex
   as in `D24_CRM_WRITE_RE` with `item_history`, and three name regexes. Wire it next to the marker check in
   `run()` (`:4926`) with an `::error ...::D46(b) item_history written outside its module ...` line and
   `exit = 1`. Add `index/item-history.ts`, `index/item-store.ts` and `index/item-history-retention.ts` to
   `RULE_ANCHORS` (`:4599`) so a moved file fails loudly instead of the rule passing over nothing.
4. State in the rule's comment and in `SECURITY-INVARIANTS.md`: D46 has only sub-rule (b) after IC1; (a) and (c)
   are reserved by the incident-engine spec for IC3 and IC5; stated bound: a text scan, a dynamically composed
   table name evades it (as D33(b) says), and the retention module's batch SQL is the one place that DELETEs
   rows other than by service (it lives in `item-history.ts`, which the retention module only calls).
5. `bun test scripts/structure-audit/check-nimbus-invariants.test.ts` GREEN; `bun run audit:invariants` GREEN on
   the real tree (it fails if Task 3 or 4 put an `INSERT INTO item_history` anywhere but the module).

### Task 6 - Config `[index] history_retention_days`

Files: `config/index-toml.ts` (new), `config/index-toml.test.ts` (new), `config/config-explain.ts`.

1. Tests first: default 180 with no file and no section; `[index]\nhistory_retention_days = 30` reads 30; 7 and
   3650 accepted; 6, 3651, 0, -1, `abc`, `1.5`, `"30"` fall back to 180 AND call the fallback sink with a
   message naming the key and the range; a key in another section is ignored; inline `# comment` stripped; CRLF;
   unknown `[index]` keys ignored; `[index.something]` does not leak. In `config-explain.test.ts`: `probeSection`
   on an out-of-range value reports the fallback (the existing "SECTION_LOADERS has a key for every section id"
   test goes red until the loader is registered).
2. `config/index-toml.ts`: `NimbusIndexToml = { readonly historyRetentionDays: number }`,
   `DEFAULT_INDEX_CONFIG`, `INDEX_HISTORY_RETENTION_MIN = 7`, `_MAX = 3650`, `parseNimbusTomlIndex(source,
   onFallback?)` with the primitives from `config/toml-primitives.ts` (`isTableHeader`, `parseIntDec`,
   `splitKeyValue`, `stripComment`), `loadNimbusIndexFromConfigDir(configDir)` over `layeredConfigText` with
   `sectionFallbackSink(configDir, "index")`. Header comment: the section is new in IC1; today it holds one key.
3. `config/config-explain.ts`: `index: loadNimbusIndexFromConfigDir` in `SECTION_LOADERS` (alphabetical, between
   `identity` and `lan`).
4. GREEN: `bun test packages/gateway/src/config`.

### Task 7 - Retention: batched prune and the daily tick

Files: `index/item-history.ts` (the batch SQL, Task 3), `index/item-history-retention.ts` (new) + test,
`platform/assemble.ts`.

1. Tests first (`item-history-retention.test.ts`, injected clock and injected yield, real SQLite):
   - `runItemHistoryPrune` deletes rows older than `now - days * 86_400_000` in batches of 5,000, calls the
     injected `yieldToEventLoop` between batches (assert call count `batches - 1`), stops at `maxBatches` (40)
     and reports `more`; a cutoff in the future of every row deletes everything; an empty table is a no-op;
   - the retention value is read through a closure EVERY tick, so an edited `nimbus.toml` applies without a
     restart (change the closure's return between two ticks);
   - `startItemHistoryRetention(db, opts)` runs one pass at start (not awaited: the caller must not block
     boot), then every 24 h via an injected timer factory; a throwing pass never escapes (swallowed like
     `startToolCallLogRetention`, `db/tool-call-log-retention.ts:81`); `stop()` clears the timer;
   - a pass never runs inside a sync: the module imports nothing from `sync/` or `connectors/`.
2. Implement it as the sibling of `db/tool-call-log-retention.ts` / `computer-use/cu-snapshot-retention.ts`
   (`DAY_MS` cadence, `{ stop }` handle) with async batching: each batch is one statement
   `DELETE FROM item_history WHERE id IN (SELECT id FROM item_history WHERE observed_at_ms < ? ORDER BY
   observed_at_ms LIMIT ?)` (in `item-history.ts`), then `await yieldToEventLoop()` (`setTimeout(0)`), so a 5M-row
   backlog drains across event-loop turns instead of one blocking statement.
3. `platform/assemble.ts`: next to `startToolCallLogRetention` (`:3965`) add
   `const itemHistoryRetention = startItemHistoryRetention(db, { retentionDays: () =>
   loadNimbusIndexFromConfigDir(paths.configDir).historyRetentionDays })` and
   `sidecarStops.push(() => itemHistoryRetention.stop())`. Demo-rooted gateways (I41) run it too (their DB is
   their own); no network, no vault, no model.
4. GREEN: `bun test packages/gateway/src/index/item-history-retention.test.ts`.

### Task 8 - The time parser `util/point-in-time-parse.ts`

1. Tests first (pure; the zone and `nowMs` are PARAMETERS so the file is identical on all three OSes):
   - `2026-11-11T09:00:00Z`, `2026-11-11T09:00:00+02:00`, `2026-11-11T09:00` and `2026-11-11` (the last two in
     the given zone), a space separator form;
   - `yesterday-09:00` and `today-14:30` in `Europe/London` and `America/New_York` across a DST change (a
     nonexistent local time resolves to the offset before the gap, via `wallToInstantMs`, `util/zoned-time.ts:65`;
     do not re-test that function, assert the parser calls it with the right wall time);
   - `-2h`, `-30m`, `-1d`, `-90s` via `parseRelativeSinceToWindowMs`-style arithmetic (`-1w` added: the parser
     owns its unit table; do not widen `parseRelativeSinceToWindowMs`, other callers pin it);
   - refusals with a message that names the accepted forms: empty, `yesterday` (no time), `yesterday-25:00`,
     `today-09:60`, `tomorrow-09:00`, `-0h` is accepted as now, `+2h`, a malformed ISO, an unknown zone, an
     instant in the future of `nowMs`, an instant before 2000-01-01;
   - whitespace is trimmed; keywords are case-insensitive.
   RED first.
2. Implement `parseAtTime(raw: string, nowMs: number, zone: string): number` (throws `AtTimeError` with a fixed
   message; the IPC layer maps it to `-32602`). `wallOfInstant` (`util/zoned-time.ts:88`) gives "today" and
   "yesterday" in the zone. Each branch is reachable from a test; no unreachable `??`.
3. GREEN: `bun test packages/gateway/src/util/point-in-time-parse.test.ts`.

### Task 9 - Reconstruction: `index/item-history-at.ts`

1. Tests first, every case through the REAL writer (Task 3/4 functions) so the history rows are not
   hand-inserted. Fixtures are built by upserting items with explicit `syncedAt`:
   - the full OUT/IN/GAP table of the design section, one test per arm: deleted-before-T OUT; `born > T` OUT;
     `born <= T` and covered IN; `born` unknown, `seen > T` GAP; `born` unknown, `seen <= T` IN; pre-history
     item (no `__created`) with `tracks` and `modified_at <= T` IN; pre-history item with `modified_at > T` GAP;
     pre-history item of a non-tracking type (Bigeye) before `H0` GAP and after `H0` IN; untracked type
     (`slack:message`) IN iff `modified_at <= T`, else GAP; a service with no history at all (H0 NULL);
   - values at T: the `old_value` of the first change after T for each key; a key changed twice after T uses the
     EARLIEST; a key never changed uses the current value; two keys independent;
   - `buildAtClause` and `buildAtGapClause` partition the set: for every fixture item, exactly one of
     in/gap/out (the classification is total and exclusive);
   - the SQL is bound end to end: no spec value or instant appears in `sql` text (assert `sql` contains no digit
     run longer than the `?` count implies, or simply that the T literal is absent); alias outside
     `{"i","item"}` throws;
   - malformed `metadata` JSON on one row does not raise (the `json_valid` guard); that row classifies by the
     non-metadata arms;
   - `earliestHistoryMs(db, services?)` returns `null` on an empty table and the minimum otherwise;
   - `annotateStateAt` returns the current basis for unchanged items, the history basis for changed ones, only
     tracked keys, and never a title or body;
   - `pointInTimeDisclosure` renders each line of the design section in order, including the empty-history
     variant, the history-starts-later variant, the zero-gaps variant and the singular/plural of the gap line.
   RED first.
2. Implement. Keep `buildAtClause` a pure builder (no `db` access except the H0 reads, passed as a prepared map
   so the builder itself is testable without a database). A function that must branch on classification is
   split by PHASE (existence, then state), not by helper-hunting, to stay under cognitive complexity 15.
3. GREEN: `bun test packages/gateway/src/index/item-history-at.test.ts`.

### Task 10 - Retrieval wiring (keyword, vector, hybrid, browse, fetch-more)

Files: `index/local-index.ts`, `index/item-list-query.ts`, `search/{vec-store,dual-search,hybrid,hybrid-internal,
hybrid-types}.ts` (+ their tests).

1. Tests first:
   - `item-list-query.test.ts`: `at` composes with `services`, `types`, `ids`, `idInSql`; the clause params are in
     the right positional order (a test with `idInSql` that carries its own `?`s); absent `at` leaves the SQL
     byte-identical to today (golden string);
   - `local-index.test.ts`: `searchRanked({ name, atMs })` FTS path and the no-name browse path exclude an item
     created after T even when it is the best textual match and the most recent (the spec's "a later item can
     never outrank an earlier one"), keep one that existed, and attach `asOf`; `searchRankedAsync` with `atMs` and
     no embedding runtime falls to the keyword path and returns the same set; `fetchMoreItems(..., atMs)` pages
     only admitted items in `modified_at DESC` order;
   - the vector arm (modeled on `search/vec-store-join-order.test.ts`, which builds the vec tables): with `at`,
     a post-T item whose chunk is the NEAREST vector is not returned and the next-nearest admitted item is; the
     requested `k` is 500 under `at` and unchanged without it (assert through the SQL/params the builder
     returns); the `EXPLAIN QUERY PLAN` join-order tests stay green (the clause is a trailing `AND`, the vec
     table is still the outer loop);
   - `hybridSearch` with `at`: RRF input contains only admitted ids (keyword and vector); federation's
     `buildItemListSql` call (`federation/query-gate.ts:144`) is unchanged (its test stays green untouched).
   RED first.
2. Implement per the design section's "where the clause lands" list. `IndexSearchQuery.atMs` is the single input;
   `LocalIndex` builds the clause once per call (`buildAtClause(this.db, atMs, "i")`) and hands the `{ sql,
   params }` to each arm. Under `at`, `searchRankedAsync` attaches `asOf` to every returned item via
   `annotateStateAt`.
3. GREEN: `bun test packages/gateway/src/index packages/gateway/src/search packages/gateway/src/federation`.

### Task 11 - IPC and CLI: `query` and `search`

Files: `ipc/diagnostics-rpc.ts`, `ipc/server/inline-handlers.ts`, `packages/cli/src/commands/{query,search}.ts`,
`packages/cli/src/lib/search-ranked-response.ts` (+ tests). No new method: `index.queryItems` and
`index.searchRanked` already route (`ipc/server/dispatchers.ts:2422`, `ipc/server/server.ts:226`), so there is no
routing change (memory note: a method needs routing, but this one has it). Neither method is on the Tauri
`ALLOWED_METHODS` list and the LAN denylist needs no change: a new optional PARAM changes neither (checked:
`gateway_bridge.rs` lists `engine.askStream`, not these).

1. Gateway tests first:
   - `diagnostics-rpc.test.ts`: `index.queryItems` with `at` returns admitted items, `asOf` and the gap member;
     `at` with `notTouching`, with `noDownstreamIncident`, with `sinceMs`, with `untilMs`, with a non-string, with
     an empty string, with a future instant: each `-32602` with a fixed message; `index.querySql` with a present
     `at`: `-32602`; with `at` absent: unchanged;
   - `inline-handlers` tests: `index.searchRanked` with `at` and `envelope: true` returns `asOf` and the
     disclosure lines in `notes`; `at` without `envelope`: `-32602`; bad `at`: `-32602`; no `at`: byte-identical
     response (the published `@nimbus-dev/client` still gets an array).
2. CLI tests first (`query.test.ts`, `search.test.ts`, `search-ranked-response.test.ts`): `--at <v>` is consumed as
   a valued flag and sent as `at`; `query --sql ... --at ...` throws before any IPC; `--at` with `--since`,
   `--not-touching`, `--no-downstream-incident` throws before any IPC; a response with no `asOf` for a request
   that sent `at` makes the command exit 1 with "this gateway does not support --at"; the disclosure prints
   through `formatGapLine`/stderr `note:` lines; `search` still rejects every other unknown flag; stdout stays
   the plain JSON array. `nimbus query` help text gains `--at`.
3. Implement the gateway param parsing in the style of `parseQueryItemsParams` (`:499`: present-but-unusable is
   rejected, never ignored) and the CLI flag handling (`takeFlag`, `query.ts:13`; `consumeSearchArg`,
   `search.ts:12`).
4. GREEN: `bun test packages/gateway/src/ipc packages/cli/src/commands/query.test.ts
   packages/cli/src/commands/search.test.ts packages/cli/src/lib`.

### Task 12 - `nimbus ask --at`

Files: `packages/cli/src/commands/ask.ts`, `ipc/server/inline-handlers.ts`, `ipc/agent-invoke.ts`,
`gateway-main.ts`, `engine/{run-ask,run-conversational-agent,agent,agent-request-context}.ts` (+ tests).

1. Tests first:
   - CLI (`ask.test.ts`): `--at <v>` is a valued flag consumed in `parseAskArgs` (never joined into the question,
     the comment at `:34` is the reason), forwarded as `invokeParams["at"]`; a missing value throws; the stderr
     warning and non-zero exit when the result carries no `asOfMs`;
   - handler: `dispatchAgentInvoke` rejects a bad/future `at` with `-32602` BEFORE the agent runs, puts
     `pointInTimeMs` on the payload and the request store; no `at` leaves the payload identical;
   - `run-ask` (the `run-ask-conversational.e2e.test.ts` harness style, `mock.module` of the router restored in
     `afterAll`; prefer DI for new seams): with `pointInTimeMs` the classifier is NOT called (`classifier:
     { called: false, reason: ... }`), `dispatchPlan` is never reached even when a mocked classifier would say
     "action", and with no agent and no router it throws the existing `no_api_key` error;
   - local-router context (`buildLocalIndexedContextForTest`, `run-ask.ts:1500`): the primary, quoted and
     fallback searches all carry `atMs`; the repo-slug pass does not run; context items carry `asOf`; no
     "N indexed" line;
   - agent tools (`engine/agent.ts`): with `pointInTimeMs` in the request store `toolsFor` returns exactly
     `searchLocalIndex`, `fetchMoreIndexResults`, `resolvePerson` (assert the key set; a census test fails if a
     new base tool is added without a decision), and with a connector-write executor, user-MCP executor and
     toolgen all PRESENT in the same store none of their tools appears; `searchLocalIndex` passes `atMs`;
   - disclosure: `appendDeterministicDisclosures` appends the point-in-time block after the model reply and
     streams it as a final chunk; the block is identical on the router and agent paths; the model is never
     asked for it (the prompt contains no disclosure text);
   - the result echoes `asOfMs`.
   RED first.
2. Implement per the design section. `AgentRequestContext` gains `pointInTimeMs?: number` and a getter beside
   `getAgentRequestSessionId`. `runAskInner` gets one new early branch after the empty-index guard, factored
   with the `--devil` branch into a shared helper so the two cannot drift (the same lesson as
   `answerConversationally`).
3. GREEN: `bun test packages/gateway/src/engine packages/gateway/src/ipc packages/cli/src/commands/ask.test.ts`.

### Task 13 - Acceptance test (integration over real SQLite)

File: `packages/gateway/test/integration/index/point-in-time.acceptance.test.ts`. Layer: INTEGRATION (in-process,
real SQLite file, real `LocalIndex.ensureSchema`, no mocks at the DB layer), the layer of
`test/integration/briefing/briefing.acceptance.test.ts`. An e2e with a gateway subprocess is not used because
`nimbus ask` needs a model and the other two commands reach the same handlers this test calls directly; the CLI
flag plumbing is covered by the command unit tests of Task 11/12.

1. The scenario (all history written by the REAL writer through the production sync capability set,
   `testing/briefing-fixtures.ts` `seedItem`-style helper over `syncTestContext`, with explicit `syncedAt`):
   - T = `2026-11-11T09:00` in `Europe/London`, now = `2026-11-12T10:00`;
   - `payment-service` PRs written with the REAL `extractPrMetadataForIndex` (`github-sync.ts:138`): PR 1 opened
     before T, still open now; PR 2 opened before T, merged at 11:30 on 11-11 (synced at 11:35); PR 3 opened
     before T, closed at 08:00 on 11-11 (synced 08:05); PR 4 opened at 12:00 on 11-11 (after T), open now;
     PR 5 opened before T but first synced at 11-11 10:00 (backfilled after T); PR 6 pre-history (inserted with
     `syncedAt` before the first history row, `modified_at` before T, never changed); PR 7 pre-history, modified
     after T, never observed changing (a GAP);
   - the expected answer for "PRs open at T": PR 1, PR 2 (its merge came later), PR 6; NOT PR 3 (closed before),
     NOT PR 4 (created after), PR 5 and PR 7 are GAPS (counted, not shown). Assert state values:
     PR 2 shows `state: open`, `merged: false` at T and `merged` now; `source_at_ms` of its change row equals
     `merged_at`;
   - a PagerDuty incident acknowledged before T and resolved after T reads `acknowledged` at T;
   - the honesty line appears and names the earliest history row when it is later than T (a second run with T
     earlier than the first history row), and is absent when T is covered.
2. Assertions, per entry point: `LocalIndex.searchRankedAsync({ name: "payment-service", itemType: "pr", atMs })`
   (FTS path, semantic off) AND with a deterministic fake query embedding plus real vec tables for one chunk per
   PR (vector path; skip with a named reason only if `sqlite-vec` cannot load, as `vec-store-join-order.test.ts`
   does); `rpcIndexQueryItems`-level (`index.queryItems` with `at`) including the `gaps` member and `asOf`;
   `rpcIndexSearchRanked` with `at` and `envelope`; `buildLocalIndexedContextForTest` (the `ask` local-router
   path); and the agent `searchLocalIndex` tool body through its test seam. Each returns the SAME admitted set.
3. Cross-checks: a later PR that is the best keyword match and the most recent never appears and never displaces
   an admitted one; `nimbus query --sql` with `at` refused; removing the connector (`removeConnectorIndexData`)
   leaves no `item_history` for it; running the retention prune with `history_retention_days = 7` drops rows older
   than 7 days and the `--at` answer for an older T then reports "history starts" later than T.
4. `bun test packages/gateway/test/integration/index/point-in-time.acceptance.test.ts` (the `test/` tree is
   loaded only by the whole-repo run, so also run it on its own).

### Task 14 - Coverage and cleanup

- The floor is 85 % line and 80 % branch PER NEW FILE (`audit:coverage-floor`, Linux-authoritative; the
  `test:coverage:*` scripts are not the gate). New files: `item-history-keys.ts`, `item-history.ts`,
  `item-history-retention.ts`, `item-history-at.ts`, `index-toml.ts`, `point-in-time-parse.ts`. For each, before
  pushing, list every `?:`, `??`, `&&`/`||` and early return and name the test that takes each arm. Do not write
  a `??` default that cannot be reached, and do not write `err instanceof Error ? err.message : String(err)`
  (an unreachable branch under test): throw fixed messages or use the existing `fallbackMessage`
  (`config/layered-config.ts`). The unreachable-defensive-branch trap is the usual floor failure.
- Biome (`preflight:fast`), no `any`, no bare `.sort()` (comparators), every new function under cognitive
  complexity 15, `dbRun`/`dbExec` only (I14), identifiers never interpolated into SQL (I9).
- `git grep -n "item_history" -- packages/gateway/src` outside the allowed files is the same check the static
  rule runs; do it by hand once.
- Cross-platform: no path separators are built here; the time tests pass `zone` and `nowMs` explicitly;
  `bun run audit:cross-platform`.
- If Docker is available run `bun run verify:docker --changed`; otherwise say so in the PR.

### Task 15 - Docs (the five core docs, every PR) and CHANGELOG

- `CLAUDE.md` and `GEMINI.md` (identical edits): the status paragraph gains one "Phase 10 IC1" sentence (item
  history V94: the allowlisted state-change rows written in `upsertIndexedItem`, no foreign key, retention
  `[index] history_retention_days` default 180 pruned daily in 5,000-row batches; `--at` on `nimbus ask`,
  `nimbus query` and `nimbus search`; `query --sql` refuses it; static D46(b); no new invariant, HITL type or
  egress class; stated bounds in short); `schema V93` becomes `schema V94` (CLAUDE.md line 8 says "schema V93"
  once in the status paragraph and once as "Invariants I1–I55; schema V93"; `audit:status-drift` compares both
  with `CURRENT_SCHEMA_VERSION`, run it and fix every surface it names); the "Static complement" paragraph's
  "rules D10–D45" becomes "D10–D46" and D46 joins the list of rules tied to no invariant. The invariant
  ceiling I1–I55 does not change.
- `docs/roadmap.md`: the Phase 10 *Point-in-time index queries* row (`:2028`) becomes `[x]` with a dated
  sub-note: delivered by IC1, with the stated deviations (new `item_history`, so the row's "no new data
  collection required" is false; `--at` also on `nimbus search`; `--sql` refuses it; titles and bodies as of
  now; gaps counted); the acceptance criterion at `:2062` is met by the acceptance test of Task 13. The M8 row
  (`:3004`) and the `:2867` dependency are rewritten per deviation 2. The incident-engine rows IC2-IC10 stay
  `[ ]`.
- `docs/architecture.md`: a `Table item_history (V94)` pointer next to the V93 one (`:994`); a short "Item
  history and point-in-time queries" subsection (the writer in `upsertIndexedItem`, the tracked set and how it was
  derived, normalization, the reconstruction rule with its OUT/IN/GAP arms, the SQL clause and where it lands, the
  vector-arm recall bound, retention, the disclosure); the IPC catalogue entries for `index.queryItems`,
  `index.searchRanked` and `agent.invoke` gain the `at` param; the D-rules mention gains D46(b). The stale
  "Latest applied migration: V85" paragraph at `:4139` is NOT in scope (it is not a `schema V<N>` claim and
  `audit:status-drift` does not read it); do not rewrite it.
- `docs/README.md`: the Phase 10 status paragraph (`:445` area) gains the IC1 sentence.
- `docs/cli-reference.md`: `--at <time>` for `nimbus ask` (`:393`), `nimbus search` (`:434`, its flag table, and
  its "no other flags" note which currently says time filtering is unavailable) and `nimbus query` (`:469`):
  accepted forms (`2026-11-11T09:00Z`, `2026-11-11T09:00` in the gateway zone, `yesterday-09:00`, `today-14:30`,
  `-2h`), what is reconstructed and what is as of now, the honesty and Gaps lines, `--sql` and `--since` and the
  negation flags refusing it, the ask-path restriction (no live tools, no plan dispatch, no writes), the
  configuration table gets `[index] history_retention_days` (default 180, 7 to 3650; the table at `:1200` is
  the model).
- `docs/CHANGELOG.md`: a dated entry in the existing style at the top of "Post-Phase-6 deliveries": what the
  owner gets (ask, query and search can answer as of an earlier time, with the disclosure; history begins at the
  upgrade), schema V94, the config key, static D46(b), no new invariant, the stated bounds, and the 14
  deviations in short.
- `docs/SECURITY-INVARIANTS.md`: a `## D46` section after D45 (Statement, Why, Stated bounds, Enforcement), the
  header "Current ceiling" line "static rules D10–D45" becomes "D10–D46".
- The three `CEILING_RANGE_SURFACES` that `audit:status-drift` (`scripts/structure-audit/check-status-drift.ts`)
  holds to `D10–D<max>`: CLAUDE.md (and GEMINI.md, its mirror), `.claude/commands/nimbus-commands.md` (`:185`,
  "static invariant complement D10–D45") and `.claude/commands/nimbus-file-map.md` (`:311`) all move to
  `D10–D46`; run `bun run audit:status-drift` after the edit.
- `docs/schema-reference.md`: the V94 `CREATE TABLE` and indexes with a dated header comment (model: the V93 entry
  at `:1339`).
- `.claude/commands/nimbus-db-migrations.md` (the "Newest" line, `:34`), `.claude/commands/nimbus-file-map.md`
  (one row for the new files; gated by `audit:doc-refs`, which resolves every path they cite) and
  `.claude/commands/nimbus-mcp-sink.md`/others only if a path they cite moved (none expected).

### Task 16 - Final verification (run sequentially, never beside each other; a failing step hides later ones, so run each)

1. `bun run preflight:fast` (types, Biome, static rules incl. `audit:invariants`, `audit:status-drift`,
   `audit:doc-refs`).
2. `bun test packages/gateway/src`
3. `bun test packages/gateway/test packages/cli` (a `src` run does not load `test/`).
4. `bun test scripts`
5. `bun run typecheck` and `bun run typecheck:tests` (the latter covers `packages/gateway/test/**`; the baseline
   must not grow).
6. `bun test scripts/structure-audit/check-nimbus-invariants.test.ts` and `bun run audit:invariants` once more
   after any later edit.
7. `bun run preflight` if time allows (full CI parity); `bun run verify:docker --changed` if Docker is available
   (its one known red exec-e2e is the harness).
8. Known LOCAL baselines (not this branch): six migration e2e tests fail when run alongside `packages/cli/src` in
   one process (reproducer in the memory note `migration-e2e-fails-beside-cli-src-in-one-process`); five
   `install.ps1`/gpg tests fail on this machine; on Windows the sandbox helper must be built first
   (`pwsh -NoProfile -File ./scripts/build-sandbox-helper-win32.ps1`) or the sandbox suites fail for that reason.
   Do not run the sandbox tests beside a background `preflight` (they share an ACL ledger). Anything else red is
   this branch.
9. Before opening the PR re-check `git rev-parse --abbrev-ref HEAD`, then strip `docs/superpowers/**` from the
   branch.

## Spec coverage (spec § 5.1 and the IC1 row of § 4, mapped to a task STEP)

| Requirement | Where implemented |
| --- | --- |
| Table `item_history` with the listed columns (V94) | Task 1 step 2 (DDL), step 3 (`simpleStep(93, 94, ...)`, `CURRENT_SCHEMA_VERSION`) |
| Indexes `(item_id, observed_at_ms)` and `(service, type, observed_at_ms)` | Task 1 step 2 (plus the third, deviation 10) |
| A row means old -> new of a key at `observed_at_ms`; `source_at_ms` when the provider gives it | Task 3 step 1/2 (`recordItemUpsertHistory`); `sourceAt` rules, Task 2 |
| Pseudo-keys `__created` and `__deleted` | Task 3 (`recordItemUpsertHistory`, `recordItemDeleteHistory`); Task 4 step 2 (delete path) |
| Writer only in `index/item-history.ts`, called from `upsertIndexedItem` and the delete path, same statement sequence | Task 4 step 2 (savepoint around read, upsert, history); Task 3 |
| Static D46(b) pins the single writer | Task 5 (steps 2-5) |
| Deployments need no history | Design (not tracked; `deployment_items` untouched); Task 2 table has no entry |
| Allowlist per `(service, type)` (`ITEM_HISTORY_KEYS`) of state keys | Task 2 step 1/2 (`ITEM_HISTORY_SPECS`, derived from the writers, with the writer-derived pin test) |
| Bodies, titles and free text never recorded; values capped at 256 characters | Task 2 (`normalizeHistoryValue`, key lists), Task 3 step 1 (cap and "untracked key changes write nothing") |
| NO foreign key to `item` | Task 1 step 1 (`foreign_key_list` empty, survive-delete test) and step 2 |
| Retention `[index] history_retention_days` (180), boot + daily tick, batches of 5,000, never inside a sync | Task 6 (config), Task 7 (batched prune, tick, `assemble.ts` wiring) |
| Honesty: readers say when history starts later than T | Task 9 (`pointInTimeDisclosure`); consumers in Tasks 11, 12 |
| `--at` on `nimbus ask`, `nimbus query` and `nimbus search` | Task 11 (query, search), Task 12 (ask) |
| Time forms: absolute ISO, `yesterday-09:00`, `today-HH:MM`, `-2h`, gateway zone | Task 8 |
| `nimbus query --at` composes with its structured filters; `--sql` refuses `--at` | Task 11 steps 1-3 |
| Retention keeps an item only if it existed at T (`__created` or provider creation <= T, no earlier `__deleted`); each tracked key shown as at T | Task 9 (OUT/IN rules, value-at-T), annotated by `annotateStateAt` (Task 9/10) |
| Unreconstructable item excluded and counted in `## Gaps` | Task 9 (`buildAtGapClause`, disclosure), Task 11 (`excludedUnplaceable`), Task 12 (deterministic block) |
| The filter runs in SQL before ranking | Task 10 (clause in FTS, browse, hybrid BM25, vector arm, fetch-more); vector recall bound, deviation 3 |
| The answer states that bodies and titles are as of now | Task 9 (first disclosure line); Tasks 11, 12 print it |
| Acceptance (§ 1, § 7): seeded timestamped history, the filter excludes items created/modified after T | Task 13 |
| IC1 updates the five core docs and CHANGELOG | Task 15 |

## Risks / open questions

- **Owner / reviewer decisions to look at:** (1) D46 introduced with only sub-rule (b) (deviation 11); (2) a third
  index (deviation 10); (3) `history_retention_days` has no "0 = off" and a 7-day floor (deviation 1); (4) an
  erasure (`connector remove`, `nimbus data delete`) deletes that service's history instead of writing
  `__deleted` (deviation 9); (5) `--at` on `ask` withdraws the live tools and the plan route for that turn
  (deviation 14) and `engine.askStream` is not covered; (6) the M8 roadmap row is rewritten (deviation 2).
- **Vector recall under `--at`** (deviation 3): a query whose nearest 500 chunks are all newer than T gets no
  vector hits. The keyword arm is exact. Fixing it needs filtering inside the `vec0` query (sqlite-vec metadata
  or partition keys), which is a dependency decision and is not in IC1.
- **Gap count scope:** exact for `query`; keyword-match scope for `ask` and `search` (vector-only candidates that
  the filter drops are not counted). Stated in the disclosure and the docs.
- **The upgrade day:** history starts at V94, so for the first days most T values fall before history. That is
  correct and disclosed, but the first demonstrations of `--at` will show many Gaps for connectors whose items
  predate the upgrade and whose `modified_at` is not a change clock (Sentry, Monte Carlo, Bigeye).
- **Observation clock, not provider clock:** `observed_at_ms` is `syncedAt`. A change made before T and synced
  after T reads as "unchanged at T" for a type that is `modifiedAtTracksChange: false`. Stated bound.
- **First sync of a connector after T:** an item the connector first sees after T gets `__created` after T, so it
  is a GAP when its birth time is unknown and OUT only when the provider's creation time is known to be after T.
- **IC2 must register `jira:alert`** (and PagerDuty `resolved_at_ms` as a tracked key and `source_at` source) in
  `ITEM_HISTORY_SPECS`; IC3's assembly reads the table and must treat `__created` as an observation time. Both
  are noted for the IC2/IC3 plans.
- **Older CLI/gateway skew:** guarded by the `asOf`/`asOfMs` echo checks (Tasks 11, 12); an older gateway that
  ignores `at` can never silently answer from current data through the first-party CLI. A third-party client
  that passes `at` to an older gateway is outside the guard.
- **Sync cost:** one PK read and a savepoint per tracked upsert. If a connector's initial sync of 100k PRs shows
  a measurable slowdown, the first mitigation is batching the old-metadata read per `writeBatch` page, not
  dropping the savepoint. Measure once on a seeded 50k-PR index before the PR (record the number in the PR).
- **Live reply shapes** for every writer above are read from the mappers and their tests, not verified against
  live accounts.

## PR

Title (conventional commit, no `!`; nothing here requires a user to act):

`feat(gateway): record item state changes in item_history and answer ask, query and search as of an earlier time with --at`

Description: the data added, the 14 deviations (short), the stated bounds, the verification output, and the
dependencies: IC2 registers the alert type and PagerDuty resolution key; IC3 and later read the table. End with
the attribution lines from the session. No `Release-As:` trailer.

## Review log

Round 1 (Antigravity, 2026-11-12), applied: three stale line citations corrected (`briefing-toml.ts:262` and
`:292`, `diagnostics-rpc.ts:685`); the docs task names all three `CEILING_RANGE_SURFACES` that
`audit:status-drift` holds to the static-rule ceiling.
