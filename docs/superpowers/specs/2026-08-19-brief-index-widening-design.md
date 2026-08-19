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
doing so does not regress the synthesis suite and costs no more than the single
pre-authorised key below; otherwise it stays out. The citation carries `itemType`
regardless, because the **user** benefits from it whether or not the model does.

**If the test says yes, the shape is fixed in advance** so the decision is about whether,
never about what: one additional key on the existing per-source object, carrying the raw
`itemType` and nothing derived —

```ts
{ token: "C3", type: "pull_request", title: …, url: …, text: … }
```

Absent for `S{n}` entries, which are the pages the user themselves supplied and need no type
to be understood. No prose label, no per-type instruction text in `INSTRUCTIONS`: the model
is given the fact and left to use it. Anything more elaborate is a prompt-engineering slice
with its own evidence bar, not a rider on this one.

**Measured (Task 5, 2026-08-19): kept.** Added the `type` key per the fixed shape above and
ran the full `packages/gateway/src/briefs` suite (164 tests) before and after: no synthesis
test regressed, and the discriminating test (`brief-synthesis.test.ts`, `buildPrompt` describe
block) confirms the key is present on a typed `C{n}` entry and absent on `S1`. Cost is exactly
the single short key the spec allowed. Nothing else in `INSTRUCTIONS` or the source shape
changed.

What this did **not** measure: every LLM call in this suite is a canned/stubbed response
that ignores prompt content, so no test here can show a change in attribution behaviour in
either direction — the stricter "does the model use it" question this section opens with is
still open, and stays open until a slice with a real (live-model) eval harness can ask it.
"Kept" rests on absence of regression at pre-authorised cost, not on a demonstrated
improvement in grounding.

### 5. A hit's prompt cost is set by the chunker, not by the item

The intuition that a build log or a large pull request would drag far more text into the
prompt than a web clip is worth stating and rejecting, because it is wrong in a way that
matters for whether this slice needs a new cap.

A snippet is not the item. `semanticSnippetForHit` returns the **winning chunk plus
`contextChunks` neighbours on each side** (`search/hybrid-internal.ts:34-39`), and a chunk is
bounded by the chunker at 256 tokens — `maxChars = maxChunkTokens * 4`, so ~1 KB
(`embedding/chunker.ts:9,142`). With `contextChunks: 2` that is at most 5 chunks, ~5 KB per
hit, ~40 KB across all 8.

A 40 MB build log therefore produces *more* chunks, not bigger ones, and still contributes
one winning chunk plus its neighbours. **The bound is identical for every item type**, which
is precisely why widening does not move it.

Worth recording honestly: index-hit bodies are subject to **no brief-side byte cap**.
`MAX_SOURCE_BYTES` and `MAX_RUN_BYTES` govern sources the client *feeds*; a `C{n}` body
enters through `buildRegistry` and is capped only by the chunker. That is a pre-existing
property, not one this slice introduces, and ~40 KB against a 4 MB run budget does not
justify a second cap. Noted so the next reader does not assume the feed-stage accounting
covers this path.

### 6. Ranking stays purely score-based — no per-type quota

`tryBuildHybridHit` scores by reciprocal rank fusion over the BM25 rank and the vector rank
(`search/hybrid-internal.ts:258-266`). Nothing in it reads the item type, so widening
introduces no type bias: the 8 slots go to the 8 best-scoring items.

One consequence is real and accepted: **a single type can take all 8 slots.** Ask a question
about a migration during a week of migration PRs and you may get eight pull requests and
none of your clips.

A quota — "at least 2 clips, at least 2 issues" — is the wrong fix. It buys type balance by
demoting better-matching items in favour of worse-matching ones, on the assumption that
variety of *source type* proxies for variety of *evidence*. It does not: eight PRs may be
exactly the right answer, and a forced clip is noise the model then has to be told to ignore.
Relevance ordering is the feature.

If dominance turns out to hurt real briefs, the honest remedy is a gap line naming the skew
("all 8 index hits were pull requests"), not a reshuffle that hides it. Not built now —
there is no evidence it happens.

### 7. Out of scope: the query embedding leaves even when the corpus does not

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

### 8. What widening *does* change: more of your corpus can reach a remote model

Today a `useIndex` run can send the user's clips to whatever `createBriefLlm` resolves,
which falls back to remote when no local provider is available. After this slice the same
run can send snippets of indexed pull requests, builds and issues.

The existing disclosure covers it literally — *"The brief and all source text were sent to
that provider — they left this machine"* is true of a PR snippet as much as a clip. But it
is a wider blast radius under the same sentence, and it is recorded here so the next reader
does not discover it by surprise.

### 9. A `briefs`-scoped token now reads the whole index

`clips/api-scopes.ts:16-24` says that granting every scope to tokens already in the wild
would hand them "the ability to run any read-only agent over the whole index … which is
precisely the escalation scopes exist to prevent", and `LEGACY_SCOPES` is
`["clip", "briefs"]`. After this slice, a `briefs` token minted so a browser extension
could save web pages can surface material from the user's indexed email, transcripts,
invoices and pull requests. The token did not change; what `briefs` reaches did.

The bound is real and worth stating precisely. A citation carries `title`, `url`, `itemId`
and `itemType` plus a verified quote of at most `MAX_QUOTE_CHARS` (200) characters, and
`resolveItem` (`briefs/brief-report.ts:112-133`) is the only path a body reaches the report
through — the raw item body is never returned. So the exposure is metadata plus short
verified spans, not the corpus.

It is nonetheless materially wider than "pages this extension clipped", which is how the
scope reads to anyone who granted it, and this spec did not frame it that way before.
Recorded, not fixed: a code-level restriction — scoping the brief search by the token's
scope, or splitting `briefs` into a clip-only and an index-wide grant — is an available
follow-up. **This slice does not take it**, and shipping without it is a decision, not an
oversight.

### 10. A brief can now cite an earlier brief

`briefs/brief-save.ts:64-84` writes every saved report into the index as a `research_brief`
item, with `body: effective.summary`, and schedules an embedding for it. While the search
was pinned to `web_clip` that item was unreachable by any later brief. It is not any more.

So model-written prose can come back as a `C{n}` citation and sit in the registry beside a
pull request, indistinguishable as evidence except by `itemType`. A second brief on the same
topic can cite the first one's summary and read as corroboration when it is really the same
inference repeated — and quote verification does not help here, because the quote genuinely
does appear verbatim in the cited body.

The alternative is one line: exclude `research_brief` from the brief search the way
`web_clip` was excluded from everything else. **This slice does not take it.** The user's own
saved research is legitimately part of their corpus, and suppressing it by type would be the
same kind of unasked-for scoping decision this design rejects elsewhere. Recorded as a known
consequence so the first person to see a brief cite a brief knows it was foreseen.

### 11. Two new ref fields fan out to 400 citations, so the save ladder sheds ids first

`brief-constants.ts:57-70` already reasons about ref fan-out: a ref is copied into every
citation that names it, and the count caps allow `MAX_FINDINGS` 25 x `MAX_CITATIONS_PER_ITEM`
8, plus the same again for conflicts — 400 citations. This slice adds `itemId` (on a
`web_clip` citation, byte-identical to `clipId`) and `itemType` to every one of them:
roughly +110 bytes per article-clip citation and +175 for a selection clip, so +44-70 KB
worst case against `brief-save.ts`'s 60 KB `META_BUDGET_BYTES`. A brief that used to save at
~55 KB could now throw `ReportTooLargeError`, and the user cannot save the brief in front of
them.

The budget constants do not move — they are sized against `RAW_META_MAX_BYTES` and are not
this slice's to spend. Instead the degradation ladder gains a first rung ABOVE quote
stripping: drop `itemId` wherever it equals `clipId`. That rung is free — `clipId` still
resolves the item and `itemType` still says what it is, so nothing recoverable is lost and it
carries no gap line. Quotes are the user's evidence and go only when the duplicate ids were
not enough. The ordering is the contract and is pinned by test, not just the fact that
degradation happens.

## Shape

| File | Change |
| --- | --- |
| `platform/assemble.ts` | Drop `itemType: "web_clip"` from the brief search; map `itemType` into each `IndexHit` — now via the factory below |
| `briefs/brief-index-search.ts` | **New.** `createBriefIndexSearch(localIndex)`: the real query, extracted out of the boot closure so a seeded-index test can reach it |
| `briefs/brief-registry.ts` | `IndexHit.itemType`; set `itemType`/`itemId` on each `C{n}` ref; `clipId` only for `nimbus:web_clip` |
| `briefs/brief-types.ts` | `SourceRef.itemType?` / `.itemId?`; re-document `kind: "clip"` and `clipId` |
| `briefs/brief-gaps.ts` | Reword the three "saved clips" lines; keep the three-way split |
| `briefs/brief-validate.ts` | Unchanged — `useIndex` already validated |
| `briefs/brief-synthesis.ts` | Only if decision 4's test says so |
| `briefs/brief-test-server.ts` | Serve hits of more than one type |
| `briefs/brief-save.ts` | Degradation ladder sheds `itemId` where it equals `clipId` BEFORE stripping quotes (decision 11) |

## Testing

`brief-index-search.test.ts` carries the widening itself, and it is the ONLY test that can:
every other brief test injects a stub `IndexSearch`, so none of them can see the query the
gateway actually issues — which is why the query was extracted out of `assemble.ts` into
`createBriefIndexSearch`. It seeds a real in-memory `LocalIndex` with a `web_clip`, a
`pull_request` and an `email`, and asserts all three come back with the `itemType` they were
seeded with. Restoring `itemType: "web_clip"` to the query fails it.

`brief-save.test.ts` pins the degradation ORDER of decision 11, not merely that degradation
happens: a report that fits once the duplicated ids are gone keeps its quotes, and one that
does not fall through to stripping them.

`brief-registry.test.ts` carries the core: a non-clip hit gets `itemId` and `itemType` and
**no** `clipId`; a `web_clip` hit still gets `clipId`; declaration order and token minting
are unchanged. `brief-gaps.test.ts` pins the reworded strings, keeping the three cases
distinguishable. `brief-e2e.test.ts` runs a brief whose index hits span two types and
asserts the citations come back typed.

A regression test worth having explicitly: **a search that returns hits of a type the
client has never seen must not break report validation.** That is the compatibility claim
decision 2 rests on.

That claim has a second half, and it belongs on the **client** side of the boundary: a
report carrying `itemType: "slack_message"` — a type from a connector that did not exist
when the client shipped — must parse and render. Connectors are added to the gateway
independently of any client release, so treating `itemType` as an enum would guarantee a
break on the next connector. It is validated as *an optional string of any value*, which is
what the clipper's hand-written guards do naturally (this repo and that one both use type
guards, not a schema library, so there is no enum to accidentally reach for). The clipper
spec's test list carries the matching case.

## Not in this slice

- **A client-supplied scope.** `useIndex` stays a boolean. Which types to search is a
  contract change for a choice nobody has asked for.
- **Renaming `kind`.** Decision 2.
- **The query-embedding fix.** Decision 7.
- **Changing `MAX_INDEX_HITS`.** Decision 1.
- **Restricting the brief search by token scope.** Decision 9.
- **Excluding `research_brief` from the brief search.** Decision 10.
