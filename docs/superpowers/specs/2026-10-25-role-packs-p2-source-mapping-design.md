# Role packs — Project 2: source mapping (design)

Date: 2026-10-25. Parent: `2026-10-21-role-packs-overview-design.md` § 5 Project 2 (read it first;
this document narrows it and records the calls made since). Code facts below are from `origin/main`
at `7a14406a`; paths are under `packages/gateway/src/` unless stated.

## 1. Intent

The decisions and glossary passes only read items from a hardcoded list of `service:type` pairs.
Anything else — an extension's items, Google Docs, a source a role needs — is invisible to them, and
three more places inside `decisions/` hardcode services too. That blocks the PM pack (it suggests
Google Drive and runs a nightly decisions job, but Drive items carry no text), blocks extensions, and
blocks unbundling connectors (each one moved out would go dark to both passes).

Project 2 makes both passes find their inputs by **item kind** through a mapping that the built-in
table, role packs and the owner's own config contribute to — with no agent code change per source.

## 2. Goals, non-goals, anti-goals

Goals:
1. Both passes, and the three hardcoded decision helpers, key on kind, not service.
2. A pack or the owner adds a source with one mapping entry; the owner can also remove a built-in one.
3. A newly mapped type's already-indexed items are mined; removing a mapping hides its rows without
   deleting them, and re-adding brings them back without re-mining.
4. Google Docs carry their text into the index.
5. With no packs and no owner entries, behaviour is byte-for-byte what it is today.

Non-goals:
- Extensions declaring their own mappings (overview § 5: needs run-grant approval, registry trust work).
- Moving `standup`, `oncall`, `changelog`, DORA, graph populators onto kinds (unbundling programme).
- Text for Drive files other than Google Docs (PDF, Sheets, Slides).
- Any desktop UI for mappings (the CLI `config explain` is the read surface).

Anti-goals (a failure even if it works):
- A pack silently widening mining into a personal inbox or calendar.
- A pack downgrading or removing a source the owner relies on.
- Existing decision/glossary rows or owner vetoes being deleted or rewritten by a mapping change.
- `nimbus decisions` reporting "stale score" rows merely because a mapping changed.
- A Drive sync that now pulls every file's bytes.

## 3. Kinds

Five kinds: `message`, `doc`, `ticket`, `commit`, `note`. What each pass reads:

| Pass      | Kinds                                   |
| --------- | --------------------------------------- |
| decisions | message, doc, ticket, note              |
| glossary  | message, doc, ticket, commit, note      |

What a kind means inside `decisions/` (replacing the service checks):

| Use                                   | Today (service-keyed)                                   | After (kind-keyed)                 |
| ------------------------------------- | ------------------------------------------------------- | ---------------------------------- |
| `sourceAuthority` (`decision-confidence.ts:15`) | notion/confluence page, obsidian note → 1; `*:issue` → 0.6; else 0.3 | doc → 1; ticket → 0.6; message, commit, note → 0.3 |
| ADR corroboration (`decision-corroborate.ts:186`) | `IN ('notion:page','confluence:page','obsidian:obsidian_note')` | items whose type maps to `doc` |
| Ticket-key matching (`decision-service-scope.ts:105`) | `service` is jira or linear | type maps to `ticket` **and** metadata carries `key` or `identifier` (the existing `ticketIdentifier`) |

`note` is the lower-trust kind the owner asked for: highlights, clips, personal notes. Both passes
read it; it scores like a message and never counts as an ADR.

Ticket matching, my call: the `row.service` jira/linear check (`decision-service-scope.ts:111`) is
replaced by the kind check. That also admits `github:issue`/`gitlab:issue`, which today never match.
That is safe only because the identifier comes from `key`/`identifier` metadata, which neither
writes (checked: `connectors/github-sync.ts:411-416` writes `{number, repo, state, user}`; the
GitLab sync writes neither field); a new ticket source matches only if its connector writes one of
those two fields. The doc comment at `:93-101` (Jira and Linear write disjoint metadata) is updated
to state this bound. Stated as a bound. `matchesTicketKey`'s query (`:106`) selects
`service, metadata` today; it must select `service, type, metadata` to resolve the kind.

Authority note: today any `*:issue` scores 0.6, including types outside both source sets
(`wiz:issue`). Under kinds an unmapped type is never a source, so it is never scored; the change is
unobservable.

`maxReachableConfidence` (`:139`) uses `serviceType: "notion:page"`; it moves to a `doc`-kind input
and must still read 1.0 (`confidence-ceiling.test.ts`).

### Built-in table

One table, `sources/source-kinds.ts` (new directory; name is the builder's call), mapping
`service:type` → kind. It must reproduce today's two sets exactly:

- message: `slack:message`, `discord:message`, `teams:message`
- doc: `notion:page`, `confluence:page`, `obsidian:obsidian_note`
- ticket: `linear:issue`, `jira:issue`, `github:issue`, `gitlab:issue`
- commit: `github:commit`, `gitlab:commit`, `filesystem:git_commit`

Derived: the decisions set = types whose kind is in the decisions row above; same for glossary.
Since built-ins hold no `note` entries and commits are glossary-only, both derived sets equal
today's literal sets. A test pins that equality against the literals copied from
`decision-source-types.ts:13` and `glossary-source-types.ts:23`, so a dropped entry fails the build.
The service-qualified filter rule in those files' comments (never filter on the bare type) carries
over unchanged.

Email and calendar types stay absent from the built-in table (existing posture).

## 4. Who contributes mappings

Effective mapping = built-in ∪ pack entries ∪ owner entries, minus owner exclusions.

**Packs** — a new pack-settable LIST key:

```toml
[sources]
map = ["readwise:highlight=note", "google_drive:doc=doc"]
```

- Entry grammar `service:type=kind`; `service` and `type` lowercase `[a-z0-9_]+`, kind one of the
  five. Strict list syntax like `parseAgentNameList` (`config/pack-settable.ts:107`); cap 64 entries.
- Lists union across packs (`PACK_SETTABLE_LISTS`, `pack-settable.ts:135`).
- **Add-only.** A pack entry naming a type the built-in table already maps is refused at pack
  validation (before the prompt), whatever kind it names. Two packs naming the same new type with
  **different** kinds is a conflict and the second install is refused before its prompt — the first
  list key that is conflict-checked (`packs/pack-layer-store.ts:208` today checks scalars and job
  names only). Same type, same kind: a plain union. (My calls.) `CleanPack`
  (`pack-layer-store.ts:134`) carries only `scalars` and `jobNames`, so it gains the pack's source
  mappings and `conflicts()` (`:206`) compares them across the other active packs.
- **`nimbus:*` is refused for every layer, packs and owner alike.** Gateway-written types are not
  source material: `nimbus:capture` must never be extraction input (I28; pinned today only against
  the two literal sets, `security-invariants.test.ts:2926`), and `nimbus:glossary_term` would feed
  the glossary its own output. The entry parser refuses any `service` of `nimbus`, and the
  effective-set resolver drops one again as a second check. The I28 test is rewritten in the same
  commit to assert the resolver can never yield a `nimbus:*` type for any combination of layers,
  with I28's docs entry updated (triple rule). Bound: this also keeps `nimbus:web_clip` out; mining
  clips would be a separate, owner-approved feature.
- **Personal sources refused for packs.** A pack may not map an email or calendar type
  (gmail/outlook/apple mail/calendar item types — the builder derives the list from the connectors
  that write them and keeps it in one constant). The owner may.
- The existing `pack.install` prompt already shows the defaults text verbatim (I47); the prompt also
  gets one plain line listing the sources the pack adds, the way it lists visible agents today
  (`packs/pack-prompt.ts:60,94`).
- `pack.list` rows carry `sourceMappings` beside `visibleAgents` (`pack-install.ts:494`).

**Owner** — base and profile `nimbus.toml`:

```toml
[sources]
map = ["gmail:email=message"]
exclude = ["slack:message"]
```

- `map` adds or **re-kinds** any type, built-in included (the owner outranks everything).
- `exclude` removes any type from the effective mapping, built-in or pack-added.
- `exclude` is not pack-settable. Profile beats base for the same type, mirroring
  `catalog/agent-visibility.ts`'s `decide` (`:119`). Within one layer, `exclude` beats `map`.
- Owner vs pack, my call: the owner silently wins. A pack install is never refused because of the
  owner's files (the conflict check stays pack-vs-pack and pack-vs-built-in); an owner entry that
  re-kinds or excludes a pack-added type simply overrides it, and `config explain` shows the
  shadowed pack entry. A pack entry equal to an owner entry is a plain union.

**Extensions / migration.** Nothing new is needed for v1: a migrated connector's items keep the
legacy service id (`connectors/extension-sync/extension-identity.ts:46`, e.g. `readwise`), so any built-in or pack entry keyed
on that service keeps working across unbundling. An unbound extension indexes as `ext_<slug>` and is
mapped like any other type. Readwise has no built-in entry today and gets none here; the proof
(§ 9) maps it through a pack/owner entry.

`nimbus config explain` shows the effective mapping with each entry's layer, like agent visibility.

## 5. Liveness

Today both passes read their config once at boot (`platform/assemble.ts:756,791`). The mapping
must not: a pack install or an owner edit takes effect without a restart.

- Each pass run resolves the effective mapping from the layered config snapshot at its start.
- Every read (`nimbus decisions`, `nimbus glossary`, their IPC and brief paths, `negotiate`'s
  decision join at `agents/negotiate.ts:702`) resolves it at call time.
- A change is picked up by the next pass run; the builder decides whether pack install/remove also
  triggers the passes (the existing debounced `trigger()` at `assemble.ts:934`). Either way the read
  side reflects it immediately.

## 6. Catch-up for newly mapped types

The passes keep one composite cursor each (`decision_pass_state` / `glossary_pass_state`,
`modified_at` + `id`). A type mapped after its items were synced sits behind that cursor forever.

Design (schema **V74**): a per-pass, per-type state table, e.g.
`source_catchup_state(pass, service_type, watermark_ms, watermark_id, done)`.

- At the start of a run, any effective type with no `done` row is a catch-up type. The run scans
  those types' items from the beginning up to the main cursor, with their own composite cursor, in
  bounded batches alongside the main delta scan; `done` is set when it reaches the main cursor.
- Built-in types are seeded `done` by the migration (they are already covered by the main cursor),
  so an upgrade triggers no re-scan.
- Removing a mapping deletes nothing — not the records. But the main cursor keeps moving while the
  type is unmapped and never sees that type's items, so items modified in that window would be
  missed forever. So when a run finds a type with a catch-up row that has left the effective set, it
  clears `done` and sets the row's cursor to the main cursor at that moment. On re-add the catch-up
  scans only from there to the current main cursor: nothing mined before removal is re-mined, and
  nothing changed while unmapped is skipped.
- Catch-up runs inside the pass run, sequentially with the delta scan, not concurrently. It
  re-checks the effective set between batches and stops a type that left it.
- Idempotent: an item already holding a decision record or contributing to a term is not
  duplicated; owner vetoes (`status='vetoed'`) survive untouched.
- The glossary computes term statistics live over FTS (`glossary-store.ts:106,137`), so for glossary
  "catch-up" means the term-candidate scan, not a stats backfill.

## 7. Hiding rows that are no longer mapped

Two sets matter from here on (my calls, from the builder check):
- **effective set** — what is mapped now (§ 4); drives scanning and what reads show.
- **known set** — every type that has ever been mapped: built-ins plus every type with a
  `source_catchup_state` row (§ 6). Drives stored statistics, so a mapping change never rewrites
  stored rows.

Mining stops for an unmapped type: the delta and catch-up scans use the effective set, and so do
the pending queues (`decision-store.ts:161` `selectPendingByPriority` and the glossary's
`selectPendingBatch`), so `exclude = ["slack:message"]` spends no further model calls on queued Slack
candidates; those rows stay `pending` and resume if the type is mapped again.

Decisions:
- A `decision_record` is shown, counted and used in stats/gaps when its source's `service:type` is
  in the effective decisions set. `listDecisions` (`decision-store.ts:272`) has no item join today;
  it gains a LEFT JOIN to `item` with the filter in SQL (not post-filtering), so `limit` and counts
  stay right. It selects `SELECT * FROM decision_record` today; with the join it must project
  `d.*` only, or the item's columns shadow the record's. Shape:
  `LEFT JOIN item i ON i.id = d.source_item_id WHERE (i.id IS NULL OR (i.service || ':' || i.type) IN (…))`. `countByStatus` and `loadDecisionCandidates` use the same filter so the brief's
  numbers agree with its entries.
- **Orphans pass through:** a record whose source item no longer exists (`source_item_id` has no
  foreign key, `index/decisions-v47-sql.ts:11-14`) is shown exactly as today.
- **Owner-accepted agent decisions are never hidden** (`'agent'` provenance, written by
  `mcp-sink/capture-native.ts:150` with whatever item the agent referenced), matching how
  `clearDecisions` (`decision-store.ts:351-363`) already treats them as non-derivable.

Glossary:
- `glossary-reconcile.ts:37-79` demotes and unprojects a term that falls below `min_doc_freq`.
  Reconcile computes its statistics over the **known** set, so removing a mapping never demotes a
  term and re-adding never re-consolidates it. `computeTermStats` and `topSources`
  (`glossary-store.ts:106,137`) hardcode `glossarySourceFilter()` today; they take the source set as
  a parameter so reconcile passes the known set and reads pass the effective set.
- Reads (`nimbus glossary`, its brief and IPC) show a term when it has at least one occurrence in
  the **effective** set, and display `doc_freq`/`service_spread`/top sources recomputed over the
  effective set for the listed terms only (bounded by the list size; the builder measures the cost
  against today's list path).
- Manual and agent-accepted terms (`definition_source` manual/agent) are never hidden by mapping.
- **Search copies:** a consolidated term is also an indexed `nimbus:glossary_term` item
  (`glossary-project.ts`) that `nimbus ask` finds. A term hidden by mapping is unprojected, and
  re-projected from its stored row when it is shown again — a derived item only, no model call;
  the `glossary_term` row itself is untouched. The `nimbus wow` tour selector
  (`agents/_lib/tour-selectors.ts`) and the fleet `terms` sweep (`fleet/fleet-sweep-enumerators.ts`)
  use the same effective-set rule.

Nothing in `decision_record` or `glossary_term` is deleted or rewritten by a mapping change. Rows
reappear when the type is mapped again.

### 7.1 Where a term's search copy is embedded (owner's choice: option C)

A projected `nimbus:glossary_term` is in `PROSE_HEAVY_TYPES` (`embedding/routing.ts`), so with an
OpenAI key its text is embedded remotely. A mapped source whose own items embed locally (say
`readwise:highlight`, in neither routing set) would otherwise leak derived text off the machine
through its terms.

Rule: **a term's search copy is embedded remotely only if every contributing source type is itself
remote-eligible.** Remote-eligible means: in `PROSE_HEAVY_TYPES`, or a **built-in** table type
(grandfathered — built-in commit types are not prose-heavy, and today every term embeds remotely, so
goal 5 requires built-ins to keep that). A type in `LOCAL_ONLY_PROSE_TYPES`, or a pack- or
owner-added type in neither set, makes every term it contributes to local-only.

- Contributing types are the distinct `service:type` values of the term's occurrences over the
  known set, computed where `computeTermStats` already runs; re-evaluated on each reconcile and
  re-projection. A term that changes routing is re-projected and re-embedded.
- Suggested mechanism (builder's call): project a local-only term as a second item type, e.g.
  `nimbus:glossary_term_local`, in `LOCAL_ONLY_PROSE_TYPES`, so routing stays type-based and the
  disjointness test still guards it; every reader of `nimbus:glossary_term` (search, `ask`,
  projection cleanup) then reads both types.
- Decisions are not projected as search items, so the rule does not apply to them.
- The `pack.install` prompt's sources line says that terms mined from a local-only source stay
  local.

**Stale-score check.** `agents/decisions.ts:260-273` recomputes each row's confidence and flags a
difference above 0.005 as "scored on the previous scale". An owner re-kinding a type changes its
authority and would trip it. V74 adds `decision_record.scored_kind` (nullable). The migration backfills it
from the built-in table only — each row's source `service:type` looked up in that table, so the
values are exactly today's kinds; a row whose source is gone, or whose type is not built-in, stays
NULL. The check recomputes with the stored kind, and with the current kind when it is NULL (today's
behaviour), so only a genuine formula change is reported. A newly scored or `--refresh`-rescored
record stores its current kind. The check also stops issuing a per-row `SELECT service, type`
(`agents/decisions.ts:32`) for rows that carry a kind.

## 8. Google Docs text (PR 3)

Drive writes every non-folder as `google_drive:file`, PDFs and images included, with the MIME type
in `metadata.mimeType` (`connectors/google-drive-sync.ts:150`). Mapping that type would mine file
names. Calls:

- Items with MIME `application/vnd.google-apps.document` are written as type **`doc`**; text comes
  from the Drive export endpoint as `text/plain` (`files/{id}/export?mimeType=text/plain`). Other
  files stay `file` (folders `folder`), metadata only, unchanged. `metadata.mimeType` and
  `metadata.size` stay on every row (the media pipeline reads them: `MIME_KEYED_SERVICES` and
  `SOURCE_BYTES_KEY`, `multimodal/media-source-registry.ts:82-86,172`, and the mime arm of
  `multimodal/media-discovery.ts`). A Doc's mime is neither image nor audio/video, so media discovery
  never selected a Doc and still does not.
- **Same item id, re-typed in place (owner's call).** `itemPrimaryKey` is `service:externalId`
  (`index/item-key.ts:7`), never the type, and `upsertIndexedItem` sets `type = excluded.type` on
  conflict (`index/item-store.ts:117`), so the `doc` upsert rewrites the old `file` row; nothing is
  deleted.
- **Routing (owner's call):** `google_drive:doc` joins `PROSE_HEAVY_TYPES` like `notion:page` —
  remote 1536-dim embedding when an OpenAI key exists, MiniLM otherwise. That also gives it
  `BODY_MAX_PROSE` (16,384), since `LONG_BODY_TYPES` is derived from the two routing sets
  (`index/body-caps.ts:27`), and makes it remote-eligible under § 7.1.
- **Re-routing an item must drop its old route's vector.** Each inner pipeline replaced only its own
  model's chunks (`embedding/pipeline.ts:137`), and `embedding_chunk` is `UNIQUE(item_id,
  chunk_index)` (`index/embedding-v6-sql.ts:14`), so with an OpenAI key a re-typed Doc's new embed
  would FAIL on that constraint and leave the file name's MiniLM vector as its only one — and on the
  backfill's drain loop, which re-selects a failed item, never finish. `SqliteEmbeddingPipeline.embedItem`
  clears every model's chunks for the item (the backfill calls the inner pipeline directly, so a
  router-level delete would not cover it).
- **When to export.** A Doc is exported unless its row already holds this revision's text:
  `ctx.bodyFetchState` (the Notion pattern, `connectors/notion-sync.ts:200`) gains `hasBody`, and the
  export is skipped only when a `bodyFetch` verdict is recorded, the body is present and
  `modifiedAt` is unchanged. `hasBody` matters because a `metadata_only` reindex NULLs the body but
  keeps the verdict (`connectors/reindex.ts`); Notion's identical skip reads it too. Never for other
  MIME types.
- **Depth.** At `metadata_only` nothing is exported (the chokepoint would drop it). The verdict
  (`bodyFetch: "complete" | "capped"`) is recorded only at `full`, so a `summary` row is exported
  again once the owner deepens the connector.
- **Export failures never fail the sync.** A text variant of `fetchGoogleJson`
  (`fetchGoogleText`, `connectors/google-sync-shared.ts`) shares its rate limiter and 401 handling
  and strips the leading UTF-8 byte-order mark Google puts on `text/plain` exports. A 401 still
  throws `UnauthenticatedError`. Any other failure (403 export-size limit or export disabled, 404,
  429, 5xx) indexes that Doc without text and no verdict, and the sync carries on. Non-401 failures
  carry their status (`GoogleHttpError`) so a 429/5xx can be told from a 403.
- **Cap (owner's call): 200 exports per `sync()` call** (`DOC_EXPORTS_PER_SYNC`). A changes or list
  page holds at most 100 files, so the cap binds only when a changes page and the re-list share a
  call. A Doc written without text because the cap ran out, or because its export failed
  transiently (429, 5xx, network), re-arms the re-list.
- Egress: the export and re-list calls run inside the Drive sync run and share its one `sync.run`
  row (`sync/scheduler.ts:996`); no new coverage class.
- **The one-time re-list.** The changes cursor only sees changed files, so existing Docs are re-listed
  once (`mimeType = 'application/vnd.google-apps.document' and trashed = false`), resumable through
  the cursor. State lives on the `delta` cursor as `docs`: `{ listToken }` while running,
  `{ doneAt: <depth> }` when finished. An ABSENT field means "not started", which is how every
  cursor written before this PR reads, so an upgraded install re-lists once and a fresh install
  re-lists once after its first drain (cheap: Docs it already exported are skipped by the check
  above). A depth change re-arms it (`doneAt` differs from the run's depth), as does a re-arm
  above.
  - Each call applies its changes page first, so the re-list never holds up the changes feed or lets
    its token expire. The re-list runs only once the feed is caught up, with the call's remaining
    budget, and never starts a list page it cannot finish (at least 100 exports left), since the next
    page's token is the only resume point. It also lists at most 5 pages per call
    (`DOCS_RELIST_PAGES_PER_SYNC`): a page of Docs already current spends no export, so the budget
    alone would let one call list a large Drive end to end.
  - **Scope:** a re-listed Doc is written only if it is already indexed or was modified inside the
    initial 30-day window. The re-list rewrites rows; it does not widen what Drive indexes.
  - A transient export failure inside the re-list does not re-arm it (a Doc that keeps failing would
    otherwise re-list the whole Drive on every sync). That Doc gets its text on its next edit, a
    depth change, or a cleared cursor.
- No SQL migration rewrites Drive rows: the connector itself writes `doc` from the first sync after
  upgrade, and the re-list is its own work, so a sync can never revert a row to `file`. A re-typed
  row is re-embedded under `google_drive:doc`'s routing on its upsert (`scheduleItemEmbedding`).
- **Not a built-in source kind.** `google_drive:doc` is not added to `sources/source-kinds.ts`; the PM
  pack maps it (below), so it is mined only where a pack or the owner says Docs count (goal: with no
  entries, outputs match today's).
- **`nimbus index rebody`:** `google_drive` stays out of `REBODY_IMPROVABLE_SERVICES`
  (`ipc/index-rebody-rpc.ts`). With `doc` declared-full and `file`/`folder` preview-only it is a
  mixed service, which that set excludes (like `zoom` and `nimbus`) because pending counts are
  grouped by service only.
- PM pack → **1.1.0**, adding `[sources] map = ["google_drive:doc=doc"]` to its defaults. Since
  update detection is digest-based (`pack-install.ts:483`), installed PM packs see an update.

## 9. Delivery and done-when

Three PRs, in order (owner's choice):

1. **Kinds, no behaviour change.** Built-in table, the five sites (two pass filters, three decision
   helpers) and the glossary store read kinds; the equality test against today's literals; the
   ceiling test still 1.0. No config key, no schema change. Its proof is that every existing
   decisions/glossary test passes unmodified.
2. **Mappings.** `[sources] map` (pack + owner) and `exclude` (owner), validation and conflicts,
   the prompt line, `pack.list` field, `config explain`, live resolution, V74 (catch-up state,
   `scored_kind`), the known/effective sets, read-time hiding, unproject/re-project, the § 7.1
   embedding rule, the `nimbus:*` refusal with the rewritten I28 test and docs.
3. **Google Docs.** `google_drive:doc`, export, the one-time re-list, PM pack 1.1.0.

Done when (from the overview, made concrete):
- An owner entry `readwise:highlight=note` makes highlights already in the index appear as glossary
  terms and decision candidates after the next pass, with no agent code change; the same holds for
  an `ext_*` type through a pack entry.
- Removing that entry hides those rows from `nimbus decisions`/`nimbus glossary` and their counts;
  re-adding shows them again without re-mining.
- `exclude = ["slack:message"]` hides Slack-sourced rows and stops Slack mining.
- With no entries, outputs match today's (PR 1's test suite unchanged).
- A Google Doc's text is in the index and a decision written in it is mined after installing PM 1.1.0.

## 10. Constraints inherited

All overview § 4 constraints, plus: no `any`; bound SQL params (I9) for the dynamic `IN` lists;
SQLite writes through `dbRun`/`dbExec` (I14); the pack layer is still written only by
`pack-install.ts` behind `pack.install` (I47/D36); cross-platform paths; docs + tests + wiring land
together. No new invariant is expected: the passes' local-LLM gating is unchanged, and the one path
by which mined text can leave the machine (remote embedding of a term's search copy, ledgered under
the `model` class) is bounded by § 7.1 so that derived text never travels further than its sources'
own items do.

Deferred: a team-baseline or org-policy layer for `[sources]`. The overview's order is defaults →
packs → team baseline → user, but no team-baseline config layer exists yet, and a signed org policy
(I22) has no `[sources]` lock-off. When either lands it sits above packs; until then `[sources]` is
set only by packs and the owner.

## 11. Left to the builder

File and module names; whether pack install/remove triggers the passes; the catch-up batch size; the
exact email/calendar type list (derived from the writers); wording of the prompt line and `config
explain` rows. (The Docs export cap, Docs routing and the `doc` row id scheme were settled by the
owner on 2026-10-25: 200 per call, `PROSE_HEAVY_TYPES`, same item id — see § 8.)
