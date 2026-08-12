# Sentry issue indexing — design

**Date:** 2026-08-12
**Branch:** `dev/asafgolombek/incident-attribution`
**Status:** approved, ready for an implementation plan

## Goal

Index Sentry issues as `sentry:error_issue` items, so that a later spec can attribute
them to people. Today `sentry-sync.ts` indexes **only** `sentry:project` items — one
request, no pagination, no issues — so there is nothing in the index for an attribution
pass to attach a person to.

This spec covers indexing **only**. It attributes nothing.

## Where this sits

This is Spec A of a two-spec decomposition under the "incident attribution" substrate
(sub-project C of the `nimbus negotiate` substrate, Spine S1):

| Spec | Scope |
| --- | --- |
| **A — this document** | Sentry issue indexing. `sentry:error_issue` items + graph entities. No person attribution. |
| **B — to follow** | Attribution across PagerDuty **and** Sentry: `person -> incident` and `person -> error_issue` edges, gap-note rewrites. |

The parent goal is that `nimbus negotiate` (and `expert`, `why`) can cite incident and
error-triage work instead of declaring it permanently unavailable. `negotiate`'s brief
currently carries an unconditional "incidents resolved — not available" note precisely
because no such evidence exists in the index.

**Attribution decisions already agreed for Spec B**, recorded here so Spec A's data
capture serves them:

- PagerDuty: assignee ∪ acknowledger → a "responded" edge; `last_status_change_by` →
  a "resolves" edge **only** when it is a `user_reference` present in the expanded
  assignee/acknowledger set. A `service_reference` (auto-resolve) attributes to nobody.
- Sentry: `assignedTo` → an "assigned" edge. Sentry **cannot** honestly say "resolved
  by" without a per-issue activity-feed request, which Spec B will decline and state.

## Verified facts

Everything below was checked against the tree or primary-source documentation during
design. Repo facts are file:line as of `origin/main` @ `3689401c`.

### Repo

| Fact | Evidence |
| --- | --- |
| Sentry indexes only projects | `connectors/sentry-sync.ts` — 105 lines, one `GET /organizations/{org}/projects/`, no pagination |
| Sentry writes no author | `sentry-sync.ts:94` — `authorId: null` |
| `error_issue` is a reserved, unused entity type | `graph/relationship-graph.ts:12` in `ITEM_LINKED_ENTITY_TYPES`; **no** `row.type === "error_issue"` branch in `graph/graph-populator.ts` (which dispatches on 14 types) |
| The graph populator dispatches on item type, not service | `graph/graph-populator.ts:835-900` |
| Index depth is per-connector runtime config, not a per-type registry | V21 `connector_depth` table; defaulted at V49; enforced in `index/item-store.ts:191-199` |
| A Link-header pagination helper already exists | `connectors/_lib/pagination.ts:44` `LinkHeaderPagination` |
| It is shared with Mendeley | `connectors/mendeley-sync.ts` |
| Person resolution from an email needs no migration | `people/linker.ts:28` `resolvePersonForSync` resolves-or-creates from `canonicalEmail` |
| `pagerduty:incident` is already prose-routed | `embedding/routing.ts:17` |

### Sentry API

Sourced from Sentry's public documentation. Note that `developer.pagerduty.com` and
some Sentry reference pages are JS-rendered and returned empty to a direct fetch, so
part of this is search-summary evidence rather than primary source. **The parser must
therefore tolerate every field being absent** — see "Failure behaviour".

| Fact | Consequence |
| --- | --- |
| `GET /organizations/{org}/issues/` lists issues org-wide | No per-project fan-out needed |
| The default query is `is:unresolved`; *"to return all results, use an empty query value"* | Without an explicit override we would index only **open** issues — backwards for attribution, where resolved issues are the evidence |
| `statsPeriod` *"only controls the stats key of the returned data and does not affect how many issues get returned, which will always return all issues (90D)"* | **`statsPeriod` must not be used for windowing.** Windowing goes through `query`'s search syntax (`lastSeen:-30d`) |
| `statsPeriod` defaults to `24h` | Every response carries inline stats arrays we never read; `collapse` drops them |
| `sort` accepts `date`, `freq`, `inbox`, `new`, `recommended`, `trends`, `user`; no documented direction control | Incremental sync must be newest-first-and-stop, not ascending-from-cursor |
| *"cursors will always be returned for both a previous and a next page, even if there are no results on these pages"*; stop when `rel="next"` carries `results="false"` | The existing `LinkHeaderPagination` **does not check `results`** and would loop to the page ceiling on every run |
| Issues carry a nullable `assignedTo` | Capturable in Spec A, resolvable in Spec B without a re-sync |

## Design

### Architecture

`sentry-sync.ts` becomes a **two-pass syncable**:

- **Pass 1 (unchanged):** `GET /organizations/{org}/projects/` → `sentry:project` items.
- **Pass 2 (new):** `GET /organizations/{org}/issues/` → `sentry:error_issue` items.

A new `connectors/sentry-issue-mapping.ts` holds the pure row→item mapping, following
`raindrop-collection-mapping.ts` / `readwise-book-mapping.ts` and their
`MappedRow<service, type>` shape. Keeping the mapping pure makes it testable with no
network and keeps `sentry-sync.ts` from growing into the file this kind of change
usually produces.

**No migration.** `error_issue` is already in `ITEM_LINKED_ENTITY_TYPES`, depth is
already per-connector, and nothing new is stored.

### Request shape

| Concern | Decision |
| --- | --- |
| Window **and** status | A single `query=lastSeen:-<initialSyncDepthDays>d` — **never `statsPeriod`** |
| Sort | `sort=date` (last seen), descending; stop early once `lastSeen` ≤ cursor |
| Payload | `collapse=stats` |
| Pagination | `Link` header, honouring `results="false"` |
| Page budget | `maxPagesPerSync`, clamped as `pagerduty-sync.ts` does |
| Cursor | `{ lastSeenMs: number }`, covering pass 2 only |

**Window and status are the same parameter, not two.** `query` is one string, and
supplying any value replaces Sentry's `is:unresolved` default outright. So
`query=lastSeen:-30d` — carrying no `is:` term — both windows the request *and* returns
issues of every status, resolved included. There is no separate "status filter" to set,
and adding one would re-introduce the bug: `query=is:unresolved lastSeen:-30d` silently
drops exactly the resolved issues this substrate exists to count.

Pass 1 (projects) remains cursor-free and re-lists every run, as it does today. The
cursor described here governs pass 2 alone.

**`initialSyncDepthDays` moves 1 → 30.** One day is indefensible for an attribution
substrate; it is only tolerable today because projects do not change.

### Item mapping

```text
service      sentry
type         error_issue
externalId   issue.id                    (org-unique)
title        issue.title                 (clampSyncTitle)
body         `${metadata.value}\n\n${culprit}`, omitting either side when absent
                                         (depth-enforced by upsertIndexedItemForSync)
url          issue.permalink
modifiedAt   Date.parse(issue.lastSeen)
authorId     null                        <- Spec A does NOT attribute
metadata     status, level, count, userCount, firstSeen, lastSeen,
             shortId, project slug, and RAW assignedTo
```

`assignedTo` is stored **unresolved**. It costs nothing — it is already in the payload —
and it is the hinge that lets Spec B build Sentry's person edges from rows already in
the index, with no re-sync. PagerDuty gets no such luxury: its sync never requests
assignees, so Spec B must change that fetch *and* answer what happens to incidents
already indexed without the data. That backfill question belongs to Spec B.

### Embedding routing

**`sentry:error_issue` stays OFF `PROSE_HEAVY_TYPES`** (local MiniLM 384-dim).

`pagerduty:incident` is on that list because an incident title is a human sentence. A
Sentry issue title is `TypeError: undefined is not a function` with a culprit of
`app/utils/parse.tsx in handleSubmit` — a symbol, not prose. Adding it would send every
hybrid-mode user's entire error catalogue through OpenAI on the next embed pass, for
embeddings of stack-frame identifiers. This matches the rationale already written on
`raindrop:collection` (`raindrop-collection-mapping.ts:20-25`) and `readwise:book`
(`readwise-book-mapping.ts:15-19`).

### Graph population

A new `row.type === "error_issue"` branch in `graph-populator.ts` creates the
`error_issue` entity and links it to its service.

Spec A stops there — **entities, no person edges**. This is what lets Spec B's gap note
use `detectMissingRelationToEntityType` to probe `person -> error_issue` specifically,
without the existing `pr -> issue "resolves"` edge masking the absence. That helper's
own doc comment (`agents/_lib/gap-notes.ts:70-79`) was written for exactly this hazard.

### Compatibility

Two items that both fail silently if missed:

1. **The persisted `{ pass: 1 }` cursor must decode to `null`, not throw.** Every
   existing install has one. Cold-start-on-unrecognised-cursor is correct, and needs its
   own test.
2. **`LinkHeaderPagination` is shared with Mendeley.** Teaching it `results` changes
   Mendeley's path too. Mendeley sends a standard RFC-5988 header with no `results`
   attribute, so honouring the attribute **only when present** is behaviour-preserving —
   but that is a claim to be proven by a Mendeley regression test in the same commit,
   not asserted in review.

### Failure behaviour

Every failure degrades to "fewer items indexed", never to a wrong count.

- HTTP non-OK → return the **incoming** cursor unchanged, so the next tick retries and
  the cursor never advances past data that was not fetched.
- Unparseable JSON → same.
- A row missing `id` or a parseable `lastSeen` → skipped, never defaulted. A defaulted
  timestamp would corrupt the cursor and silently truncate the next run's window.

### Testing

| Test | Why it exists |
| --- | --- |
| Pure mapping tests | No network; the mapping is where field-shape mistakes live |
| Pagination terminates on `results="false"` | **Red-prove it:** remove the check and confirm the loop runs to the page ceiling |
| Resolved issues are indexed | Red-prove by adding `is:unresolved` back into the `query` string and confirming resolved rows vanish |
| Legacy `{ pass: 1 }` cursor decodes to cold start | Every existing install hits this path once |
| Mendeley Link-header regression | The shared-helper change is only safe if proven |
| `assignedTo` survives into metadata unresolved | Spec B depends on it; nothing in Spec A reads it, so nothing else would catch its loss |

New files must clear the coverage floor: **85% line / 80% branch**, measured against a
full-suite lcov (`bash scripts/coverage-floor/build-lcov.sh` then
`bun run audit:coverage-floor`), not a scoped run.

## Non-goals

Spec A does **not**:

- attribute anything to a person, or set `authorId` on any item;
- emit `person -> error_issue` or `person -> incident` edges;
- change `pagerduty-sync.ts`;
- reword `remediationForEntityType("incident")` in `agents/_lib/gap-notes.ts`;
- read the Sentry activity feed;
- add an item type to `PROSE_HEAVY_TYPES`;
- add a migration.

## Open question deferred to Spec B

Whether `negotiate` reports error issues as a line separate from incidents (the
assumption behind choosing `error_issue` over `incident`) is Spec B's to settle, since
it owns the brief's shape. Spec A only guarantees the two are distinguishable.
