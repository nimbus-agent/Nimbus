# Brief index widening

**Status:** design, approved 2026-08-19.

**Branching:** `dev/asafgolombek/brief-index-widening`, off `origin/main` (`10b31750`,
*feat(engine): [persona] gives Nimbus a configurable voice (#1248)*). Nothing is stacked.

**Consumer:** `nimbus-web-clipper`, branch `dev/asafgolombek/briefs-over-your-index`, spec
`docs/superpowers/specs/2026-08-19-briefs-over-your-index-design.md` there. That client
ships the first `useIndex: true` caller this surface has ever had.

## What this builds

`POST /v1/briefs` has taken `useIndex` since the research-briefs surface landed, and
`buildRegistry` has always searched the index and minted `C1..Cn` citation tokens for the
hits. What it searches is **one item type**:

```ts
// platform/assemble.ts
const hits = await localIndex.searchRankedAsync(
  { name: query, itemType: "web_clip", limit },
  { semantic: true, contextChunks: 2 },
);
```

So a brief can draw on pages the user clipped, and on nothing else. Not the pull requests,
builds, issues or docs the connectors index — the corpus that is the reason to run a local
gateway at all.

This slice widens that search to every indexed type, and makes a citation say **what kind
of thing it is**, which the shape currently cannot express.

## The decisions

### 1. Widening is a deletion

`IndexSearchQuery.itemType` is optional (`index/local-index.ts:83`) and the SQL applies it
only when set and non-empty (`:552`, `:677`). Omitting it searches every type through the
same hybrid path, with the same `limit` and the same `semanticAvailable` signal.

So the widening itself introduces no new machinery, no new query shape and no new failure
mode. `MAX_INDEX_HITS` stays 8: the bound exists because a registry entry is prompt budget,
and that reasoning is indifferent to which types the hits came from.

### 2. `SourceRef` grows `itemType` and `itemId`; `kind` and `clipId` do not move

Today:

```ts
export type SourceRef = {
  kind: "source" | "clip";
  title: string;
  url?: string;
  /** The `nimbus:clip:<sha256>` item id. Present only for kind: "clip". */
  clipId?: string;
  quote?: string;
};
```

Widen the search without touching this and a Jira issue arrives as `kind: "clip"` carrying
a non-clip id in a field whose docblock says it is a clip id. The shape would be lying, and
`brief-save.ts` would persist that lie into every saved `research_brief` item.

Two additive optional fields, and nothing else:

- **`itemType?: string`** — the indexed item's type, straight from `RankedIndexItem.itemType`
  (`local-index.ts:161`). Present on every index-sourced ref.
- **`itemId?: string`** — the item id for **any** indexed hit.

`clipId` stays exactly as documented and is populated **only** for genuine
`nimbus:web_clip` hits, so every existing reader keeps its current meaning and every
already-saved brief stays true. `kind` keeps its two members: it is persisted upstream in
saved items, and a third member would fail validation in readers that predate it — for a
distinction `itemType` now expresses precisely. Its documentation changes from *a clip* to
*an item from your index*; the value does not.

This is deliberately additive so the two repos can land in either order. An un-upgraded
client sees a ref it can already parse.

### 3. The gap copy is wrong the moment the search is wider

`brief-gaps.ts:35-48` writes, in three places, about *saved clips*:

- "Saved clips could not be searched (the local index returned an error) …"
- "No saved clips matched this question …"
- "Index recall was keyword-only (semantic search unavailable); relevant saved clips may be
  under-represented."

After this slice each statement is about the whole index. The three-way split is the
valuable part and is kept exactly — the comment above it is the rule this repo cares about:

> NEVER launder a broken index into "your corpus had nothing relevant". They are completely
> different statements and only one of them is the user's problem.

Only the noun changes. The clipper filters gaps by equality against `synthesis.disclosure`
alone, so rewording these three is safe across the boundary.

### 4. Whether the prompt should name the type — decide with a test, not by assumption

`buildPrompt` (`brief-synthesis.ts:47`) hands the model `{token, title, url, text}` per
registry entry. Once entries span types, telling the model that `C3` is a pull request and
`C4` is a page the user clipped is plausibly better grounding — and plausibly just more
tokens.

Not assumed either way here. The implementation adds the field to the prompt entry only if
a synthesis test shows it changes attribution behaviour; otherwise it stays out. The
citation carries `itemType` regardless, because the **user** benefits from it whether or
not the model does.

### 5. Out of scope: the query embedding leaves even when the corpus does not

`searchRankedAsync` embeds the query via `ss.embedQueryDual(nameQ)`. That call is routed by
ordinary embedding configuration and is **not** covered by `LOCAL_ONLY_PROSE_TYPES`, which
governs indexing prose (`embedding/routing.ts:72`, the Nimbus#1006 fix). So a brief search
can send the user's question to a remote embedder while every clip it searches stays on
disk.

This slice does not change that, and widening does not worsen it — the query is one string
either way, independent of how many types it is matched against.

It is nonetheless a real hole in what the client can honestly promise, and the client is
disclosing it rather than papering over it. **Follow-up worth its own slice:** force a
local-only query embedding when a search is index-scoped for briefs, or expose a pre-run
signal so a client can state the destination truthfully instead of hedging.

### 6. What widening *does* change: more of your corpus can reach a remote model

Today a `useIndex` run can send the user's clips to whatever `createBriefLlm` resolves,
which falls back to remote when no local provider is available. After this slice the same
run can send snippets of indexed pull requests, builds and issues.

The existing disclosure covers it literally — *"The brief and all source text were sent to
that provider — they left this machine"* is true of a PR snippet as much as a clip. But it
is a wider blast radius under the same sentence, and it is recorded here so the next reader
does not discover it by surprise.

## Shape

| File | Change |
| --- | --- |
| `platform/assemble.ts` | Drop `itemType: "web_clip"` from the brief search; map `itemType` into each `IndexHit` |
| `briefs/brief-registry.ts` | `IndexHit.itemType`; set `itemType`/`itemId` on each `C{n}` ref; `clipId` only for `nimbus:web_clip` |
| `briefs/brief-types.ts` | `SourceRef.itemType?` / `.itemId?`; re-document `kind: "clip"` and `clipId` |
| `briefs/brief-gaps.ts` | Reword the three "saved clips" lines; keep the three-way split |
| `briefs/brief-validate.ts` | Unchanged — `useIndex` already validated |
| `briefs/brief-synthesis.ts` | Only if decision 4's test says so |
| `briefs/brief-test-server.ts` | Serve hits of more than one type |

## Testing

`brief-registry.test.ts` carries the core: a non-clip hit gets `itemId` and `itemType` and
**no** `clipId`; a `web_clip` hit still gets `clipId`; declaration order and token minting
are unchanged. `brief-gaps.test.ts` pins the reworded strings, keeping the three cases
distinguishable. `brief-e2e.test.ts` runs a brief whose index hits span two types and
asserts the citations come back typed.

A regression test worth having explicitly: **a search that returns hits of a type the
client has never seen must not break report validation.** That is the compatibility claim
decision 2 rests on.

## Not in this slice

- **A client-supplied scope.** `useIndex` stays a boolean. Which types to search is a
  contract change for a choice nobody has asked for.
- **Renaming `kind`.** Decision 2.
- **The query-embedding fix.** Decision 5.
- **Changing `MAX_INDEX_HITS`.** Decision 1.
