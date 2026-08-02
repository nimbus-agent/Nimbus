# Full-body store — lifting the 512-character index cap

**Date:** 2026-08-02
**Slot:** Spine S1 (Local Brain) — substrate, not a new agent
**Roadmap:** [Spine S1 — Local Brain](../../roadmap.md#spine-s1--local-brain)
**Status:** design approved 2026-08-02; implementation on `dev/asafgolombek/full-body-store`

## Summary

`item.body_preview` is the only body text the local index stores, and it is hard-clipped
to 512 characters for every item from every connector. That single clamp bounds keyword
search, semantic search, `nimbus glossary` and `nimbus decisions` simultaneously.

This slice adds an `item.body` column holding up to 16 KiB for prose item types, points
FTS5 at it, and leaves the embedding pipeline untouched so the volume of text leaving the
machine is unchanged. One migration (**V48**). No new security invariant. No new connectors.

## Motivation

`nimbus decisions` shipped 2026-08-02 with a stated recall ceiling: a decision expressed
later than 512 characters into a thread is invisible to it. `nimbus glossary` has the same
ceiling and does not state it. Both were accepted at the time as a property of the agent.

They are not. They are a property of the substrate, and the substrate bounds more than the
two agents:

| Site | What the 512-char clamp costs |
| --- | --- |
| `index/item-store.ts:37` | `clipPreview()` — the clamp itself, applied to every upsert |
| `index/unified-item-v3-sql.ts:36` | `item_fts` is external-content FTS5 over `item(title, body_preview)` — **keyword search is capped** |
| `embedding/pipeline.ts:93` | embeds `title + body_preview` — **semantic search is capped** |
| `embedding/chunker.ts` | 512 chars ≈ 128 tokens against a 256-token chunk budget, so `chunkText` returns exactly one chunk for essentially every item — the chunking and overlap machinery is inert in practice |
| `glossary/`, `decisions/` | both mine `body_preview`; hence the stated ceilings |

Building a fourth implicit-knowledge agent (`pre-mortem`, `negotiate`) on this substrate
would write the same disclaimer into a fourth brief. Raising the ceiling improves two
agents already in users' hands and removes the disclaimer from the next two.

## Decisions taken

Recorded so they are not relitigated during implementation.

1. **Bounded raise, prose types only.** 16 KiB for `PROSE_HEAVY_TYPES`, 512 elsewhere — not
   unbounded full bodies, and not a uniform rule across all 113 connector mappings. Most
   connectors put synthetic text in this field (`aws-sync.ts` an ARN; `argocd-application-mapping.ts`
   `"name — Synced/Healthy"`); storing more of it buys no recall.
2. **Search and agents read the expanded body; embeddings do not.** FTS5 is local and free.
   The embedder is not: prose types route to OpenAI when `openai.api_key` is set, so a 32×
   body would ship 32× more private text off the machine on the next embed pass. Semantic
   recall over long documents becomes a separate, explicitly-costed decision rather than a
   silent side effect of this one.
3. **Forward-only, with an opt-in re-fetch.** The truncated text is gone — connectors fetched
   it, clamped it, stored 512 characters. Unlike a re-embed (local recompute over data still
   held) recovering a body means re-fetching from the source API. New and re-synced items get
   full bodies automatically; a `body_complete` marker records which rows are still short; and
   `nimbus index rebody` lets the user force the expensive re-fetch when they want it.
4. **A separate `body` column, not a widened `body_preview`.** See Architecture — this is what
   makes decision 2 structural rather than a clamp someone must remember.
5. **16 KiB is a constant, not configuration.** No `nimbus.toml` knob until someone asks for one.

## Architecture

### The invariant

`body_preview` becomes a **derived prefix of `body`, never written independently.**

```text
connector ──▶ upsertIndexedItem({ body })  ──▶  body         = clamp(body, capFor(type))
                                                body_preview = body.slice(0, 512)
                                                body_complete = declaredFull && !clamped
```

One body input, one clamp site, one derivation. No code path can make the two columns
disagree, so `body_preview` remains exactly what every current reader already assumes it is.

That is the whole argument for a second column over widening the first. Decision 2 —
"embeddings stay bounded" — stops being a clamp a future contributor could delete and
becomes a consequence of `embedding/pipeline.ts` not being modified at all. The same holds
for `federation/query-gate.ts`, `engine/run-ask.ts`, `agents/why.ts`, `agents/expert.ts`
and `agents/impact.ts`: every existing reader keeps its current bounded behaviour with zero
edits. Only `glossary` and `decisions` move to `body`.

### V48 migration

```sql
ALTER TABLE item ADD COLUMN body TEXT;
ALTER TABLE item ADD COLUMN body_complete INTEGER NOT NULL DEFAULT 0;
UPDATE item SET body = body_preview;

DROP TRIGGER item_fts_insert;
DROP TRIGGER item_fts_delete;
DROP TRIGGER item_fts_update;
DROP TABLE item_fts;
CREATE VIRTUAL TABLE item_fts USING fts5(
  title, body, content='item', content_rowid='rowid'
);
INSERT INTO item_fts(item_fts) VALUES('rebuild');
-- triggers recreated over new.body / old.body
```

Authored as `index/body-store-v48-sql.ts` and wired as
`simpleStep(47, 48, "item.body + body_complete; item_fts over body (full-body store v48)", BODY_STORE_V48_SQL)`
in `index/migrations/runner.ts`, matching every migration since V33.

**`UPDATE item SET body = body_preview` before the rebuild is load-bearing.** FTS5
external-content tables pull columns *by name* from the content table. Rebuilding against a
`body` that is still `NULL` would silently reduce every existing row's keyword coverage to
its title alone. Seeding it first makes the upgrade strictly non-regressive: old rows keep
exactly today's 512 characters of coverage and gain more only when re-synced.

### Caps

A single SSoT constants module:

- `BODY_MAX_PROSE = 16384` — applied when `` `${service}:${type}` `` is in `PROSE_HEAVY_TYPES`
  (`embedding/routing.ts`, ~24 entries).
- `BODY_MAX_DEFAULT = 512` — everything else. Unchanged from today.

16 KiB comfortably covers real Slack threads, tickets, PR descriptions and normal wiki
pages. Long email chains and large Confluence pages still clip; that is what `body_complete`
is for.

### `body_complete`

`0` means "not known complete" and is the default, including for every row migrated from
V47. The store sets `1` only when a connector explicitly declares it passed an untruncated
source body *and* the clamp did not fire.

That default is what makes the connector work safely incremental: an unmigrated connector
reports as truncated, which is exactly true, rather than claiming a completeness it does not
have.

## Write path

### Store API

Rather than rename `bodyPreview` across 113 files, add a second, opt-in field and leave the
existing one meaning precisely what its name says. On `upsertIndexedItem` and the
`upsertIndexedItemForSync` wrapper the sync handlers call:

- `bodyPreview?: string` — unchanged. Clamped to 512, `body_complete = 0`.
- `body?: string` — "this is the untruncated source body". Clamped to the type's cap,
  `body_complete = 1` if it fit.
- Supplying both is a type error (a discriminated union on the input type, not a runtime check).

The diff is therefore proportional to the connectors that matter. The ~89 non-prose
connectors are untouched, and so is every prose connector until it is migrated.

### Connector reality

The prose connectors split in two, and the split is the main sizing risk in this work.

**Already fetch the full text — a one-line change each (in scope):**

Slack, Discord, Teams, Linear (`linear-sync.ts:175`), Jira (`jira-sync.ts:261`), GitHub
issues (`github-sync.ts:207,247`), Bitbucket (`bitbucket-sync.ts:137`), Obsidian
(`obsidian-sync.ts:75`, already slicing at 4096), Zoom transcripts, Snyk, `nimbus:web_clip`,
`nimbus:research_brief`.

**Index a provider-supplied stub or nothing — a real fetch change each (follow-ups):**

| Connector | Current state | What it needs |
| --- | --- | --- |
| Notion | `notion-sync.ts:201` passes `bodyPreview: ""` — pages are title-only | paginated `GET /v1/blocks/{id}/children` per page |
| Confluence | `confluence-sync.ts:141` passes `bodyPreview: ""` | `body.storage` expand |
| Gmail | `_lib/gmail/api.ts:149` indexes the API's ~200-char `snippet` | `format=full` plus MIME part decoding |
| Outlook | `outlook-sync.ts:47` indexes Graph's own `bodyPreview` field | `body.content` |
| IMAP / Apple / Fastmail / ProtonMail | `_lib/imap-client.ts:19` fetches `PREVIEW_FETCH_BYTES = 2048` from the server | a larger partial fetch, per-provider |

One footgun in the left column: Slack (`slack-sync.ts:266`), Teams (`_lib/teams/api.ts:54`)
and Discord derive the item **title** from the same local that holds the preview, via
`shortIndexedMessageTitleFromPreview`. Widening that local to 16 KiB would feed the whole body
into a title deriver that today only ever sees 512 characters. The full text must be bound to a
new local passed as `body`, leaving the existing short slice feeding `title` untouched.

Each right-column entry is a new API shape, more bytes on the wire per item, and its own
rate-limit conversation. They are deliberately **not** in this slice; each becomes a small
independent PR after the substrate lands. Notion and Confluence go first — the Wave 5
roadmap entry for `nimbus glossary` currently claims it mines "Slack threads + Confluence/Notion
pages", which cannot be true while both index no body at all.

## Read path

### The one hard break

`search/hybrid-internal.ts:61` builds column-qualified FTS5 MATCH expressions:

```ts
return `(title : "${escaped}"* OR body_preview : "${escaped}"*)`;
```

FTS5 errors on an unknown column inside a MATCH, so this must become `body :` **in the same
commit as the migration** or every hybrid search fails at runtime.

Every other `item_fts` consumer is unqualified and unaffected: `glossary/glossary-store.ts:117,137`,
`index/local-index.ts:540`, and `ipc/http-server.ts:503`'s `snippet(item_fts, 0, …)` which
addresses title by index.

### Explicit column lists

Four sites use `SELECT *` / `SELECT i.*` against `item`. Adding a column silently changes
three response shapes, so each becomes an explicit list:

| Site | Shape after this slice |
| --- | --- |
| `index/item-list-query.ts:37` → `GET /v1/items` | `body_preview`. A 50-row list must not become 800 KB of bodies. |
| `ipc/http-server.ts:144` → `GET /v1/items/<id>` | `body`. The one place the full text is wanted; bearer-authed on loopback. |
| `index/local-index.ts:539` (`ItemRow`) | `body_preview`. Search results are ranked previews, not documents. |
| `index/local-index.ts:453`, `:698` | `body_preview`. Author/type listings, same reasoning. |

### Deliberate non-changes

Stated here so a later reader does not "helpfully" fix them:

- **`embedding/pipeline.ts` keeps reading `body_preview`.** No re-embed, no new
  `embedding_chunk` rows, and the text reaching OpenAI is bit-for-bit what it is today.
- **`federation/query-gate.ts:51` keeps reading `body_preview`** and slicing to
  `SNIPPET_MAX = 280`. No federated peer sees more than it does today. Worth pinning down
  given **I17** sits on that function.

### Agents

`glossary` and `decisions` switch to `body` and report honestly: both count sources where
`body_complete = 0` and state the count in the brief — *"37 sources, 4 truncated"* — replacing
the current blanket disclaimer with a per-brief number.

The separate 0.86 confidence ceiling in `decisions` (`migration`/`iac` evidence specified in
V47 but never emitted, because no connector indexes changed-file paths) is unrelated to this
slice and is unchanged by it.

## Backfill — `nimbus index rebody`

A long-running command mirroring `index reembed`: `index.rebody` over IPC on the existing
`ipc/_lib/long-running.ts` `LongRunningJobRegistry` (jobId + AbortController + progress
notifications), with `--service`, `--type`, `--limit` and `--dry-run`. It clears the
per-connector watermark for prose types and drives a re-sync, so items return with `body`
populated and `body_complete = 1`.

**Not renderer-exposed.** `index.reembed` is not in the Tauri allowlist either — only
`index.metrics` is, and `index.rebuild` / `index.querySql` are explicitly asserted
*un*-allowed at `ui/src-tauri/src/gateway_bridge.rs:464-466`. `ALLOWED_METHODS` stays at
**103** and this slice touches no **I7** surface.

### `rebody` will not appear in `nimbus prove`

It puts real traffic on the wire, but the egress ledger's chokepoint is the executor's
`connectors.dispatch` path (**I29** / **D22**), and connector syncs do not go through it and
never have. That is the status quo for every sync. It is recorded here because this slice
adds a *user-typed, network-heavy* command, and a user may reasonably expect `prove` to show it.

### Data-minimization fix (required, not optional)

`connectors/reindex.ts:25` implements the `metadata_only` reindex depth — the path that exists
so a user can strip indexed bodies — as:

```ts
input.index.rawDb.run(`UPDATE item SET body_preview = NULL WHERE service = ?`, [input.service]);
```

Adding a `body` column makes this leave up to 16 KiB of exactly the text the user asked to be
removed. **V48 must extend it to null `body` and reset `body_complete = 0` in the same
transaction.** This is the one place in the design where getting it wrong is a privacy
regression rather than a missing feature.

## Testing

**Guards against erosion** — the properties this design protects are non-changes, which is the
kind of thing a well-meaning refactor undoes. Both are source-scanning guards asserting the
concrete call shape, and both are red-proved by temporarily breaking them:

- `embedding/pipeline.ts` and `embedding/create-routing-runtime.ts` still select
  `body_preview` and never `body`.
- `federation/query-gate.ts` still selects `body_preview` and still slices to `SNIPPET_MAX`.

**Migration** (`index/migrations/runner-v48.test.ts`, following `runner-v47.test.ts`):

- a fresh database reaches 48; upgrading from 47 is idempotent;
- **an item indexed at V47 with a 512-character `body_preview` is still findable by a keyword
  at character 400 after upgrading** — this asserts the seed-then-rebuild ordering, the single
  step that could silently gut every existing user's keyword search.

**Feature:**

- the derived-prefix invariant holds for every write path: `body_preview === body.slice(0, 512)`;
- a prose item keeps a term at character 5,000 findable via hybrid search;
- a non-prose item still clamps at 512;
- `GET /v1/items` carries no `body` key; `GET /v1/items/<id>` does;
- `metadata_only` reindex clears `body`, `body_preview` and `body_complete` together.

New files under `packages/gateway/src/` must clear the ≥80 % line + branch coverage floor
(`audit:coverage-floor`, Docker-Linux-authoritative).

## Security invariants

**This slice adds none, deliberately.** It widens a storage field and introduces no new
chokepoint; every existing gate — **I13** write allowlist, **I17** federated shape, **I29**
dispatch chokepoint — is untouched, and the properties worth protecting are the non-changes
covered by the source-scanning guards above. Adding an I-number for the absence of a change
would dilute what an invariant means in this codebase.

## Rollout

Three PRs, in order:

1. **Substrate** — V48, store API, FTS rebuild, the `hybrid-internal.ts:61` MATCH fix, explicit
   column lists, the `reindex.ts` minimization fix, both guards. No connector changes, so `body`
   is a copy of `body_preview` and observable behaviour is identical to today. Nothing can regress.
2. **Twelve connectors** flip `bodyPreview:` → `body:`. This is where recall actually improves.
3. **`index.rebody`** plus its CLI surface, which is only useful once (2) has landed.

Then the follow-ups from the right-hand column above, Notion and Confluence first.

## Documentation

Landing with the PRs above: `docs/CHANGELOG.md`; the S1 block in `docs/roadmap.md`; the Wave 5
`glossary` and `decisions` entries, both of which currently state caps that stop being true;
`docs/schema-reference.md` for V48; and the `nimbus-db-migrations` skill.

## Out of scope

- Unbounded full-document storage.
- Any change to what the embedding pipeline sees, and therefore to embedding egress.
- The five right-column connectors (Notion, Confluence, Gmail, Outlook, the IMAP family).
- Issues [#1005](https://github.com/nimbus-agent/Nimbus/issues/1005) and
  [#1006](https://github.com/nimbus-agent/Nimbus/issues/1006). #1005 (clip bodies truncated to
  512 while `wordCount` reports the full length) is largely *resolved* by this slice for the
  storage half, but its reporting half and #1006 (`web_clip` routing to OpenAI against a
  local-only store listing) are separate and stay with the web-clipper workstream.
