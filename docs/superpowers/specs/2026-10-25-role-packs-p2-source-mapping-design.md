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
to state this bound. Stated as a bound.

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
  names only). Same type, same kind: a plain union. (My calls.)
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
- Removing a mapping deletes nothing — not the records, not the catch-up row. Re-adding finds the
  row `done` and the records still there, so it re-mines nothing.
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
  stay right. `countByStatus` and `loadDecisionCandidates` use the same filter so the brief's
  numbers agree with its entries.
- **Orphans pass through:** a record whose source item no longer exists (`source_item_id` has no
  foreign key, `index/decisions-v47-sql.ts:11-14`) is shown exactly as today.
- **Owner-accepted agent decisions are never hidden** (`'agent'` provenance, written by
  `mcp-sink/capture-native.ts:150` with whatever item the agent referenced), matching how
  `clearDecisions` (`decision-store.ts:351-363`) already treats them as non-derivable.

Glossary:
- `glossary-reconcile.ts:37-79` demotes and unprojects a term that falls below `min_doc_freq`.
  Reconcile computes its statistics over the **known** set, so removing a mapping never demotes a
  term and re-adding never re-consolidates it.
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
authority and would trip it. V74 adds `decision_record.scored_kind` (nullable; backfilled from the
built-in table for existing rows); the check recomputes with the stored kind, so only a genuine
formula change is reported. A record re-scored by `--refresh` stores its current kind.

## 8. Google Docs text (PR 3)

Drive writes every non-folder as `google_drive:file`, PDFs and images included, with the MIME type
in `metadata.mimeType` (`connectors/google-drive-sync.ts:150`). Mapping that type would mine file
names. Calls:

- Items with MIME `application/vnd.google-apps.document` are written as type **`doc`**; text comes
  from the Drive export endpoint as `text/plain`. Other files stay `file`, metadata only, unchanged.
  `metadata.mimeType` and `metadata.size` stay on every row (the media pipeline reads them,
  `multimodal/media-source-registry.ts:128,172`).
- Body under the existing depth chokepoint (`upsertIndexedItemForSync`, V48/V49): `google_drive:doc`
  joins the long-body prose types so `full` depth stores up to `BODY_MAX_PROSE` (16,384). Whether it
  joins `PROSE_HEAVY_TYPES` (remote 1536-dim embedding when an OpenAI key exists) or the local-only
  prose set is the builder's call; the default is whatever `notion:page` does.
- Export only when a Doc is new or its `modifiedTime` changed; never for other MIME types. A text
  variant of `fetchGoogleJson` (`google-sync-shared.ts:38`) goes through the same rate limiter and
  401 handling.
- Egress: the export calls run inside the Drive sync run and share its one `sync.run` row
  (`sync/scheduler.ts:996`); no new coverage class.
- Existing Docs: the changes cursor only sees changed files, so a one-time re-list of Docs
  (`mimeType = 'application/vnd.google-apps.document'`) rewrites them as `doc` with text, resumable
  through the cursor, bounded per run. The old `file` rows for those Docs are replaced (same item id
  if the id scheme allows, otherwise deleted after the `doc` row lands). Exports per run are capped;
  the cap value is the builder's.
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
   embedding rule.
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

## 11. Left to the builder

File and module names; whether pack install/remove triggers the passes; the catch-up batch size and
the Docs export cap; the exact email/calendar type list (derived from the writers); PROSE_HEAVY vs
local-only for Docs; the `doc` row id scheme; wording of the prompt line and `config explain` rows.
