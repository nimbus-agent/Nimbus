# `nimbus explain last` — an X-ray of the most recent `nimbus ask`

**Status:** design approved 2026-09-14. Implementation not started.
**Roadmap row:** [`docs/roadmap.md` § v0.1.1 batch](../../roadmap.md) — "`nimbus explain last` (X-ray of the most recent `nimbus ask`)".
**Schema:** none. **Invariant:** none. **Egress class:** none. **HITL action type:** none.

---

## 1. Why

`nimbus ask` can return a weak or wrong answer for reasons that are entirely
mechanical and entirely invisible: the search terms did not match, the primary
probe returned nothing and a fallback term fired, a high-scoring item was
displaced by per-service fairness, the context cap cut the tail, or the
classifier routed the question away from the conversational path altogether.
Today none of that is observable. The user sees a paragraph and has no way to
tell a retrieval failure from a model failure.

This command makes the mechanical half legible. It is the retrieval-side
companion to `nimbus prove`: `prove` answers *what left the machine*,
`explain last` answers *what was put in front of the model, and what was not*.

## 2. Two findings from the code that shape the design

These are recorded because the roadmap row does not reflect them, and an
implementation written from the row alone would print two wrong things.

### 2.1 The score components are computed and discarded

`index/local-index.ts` computes a composite score at two sites — `:628` (the
FTS path) and `:698` (the hybrid path) — from three components:

```
compositeSearchScore(lexical, recency, servicePriority)
  = 0.5 * lexical + 0.3 * recency + 0.2 * servicePriority
```

`recencyScore` and `servicePriorityScore` are evaluated inline and thrown away;
only the composite survives onto `RankedIndexItem.score`. (`bm25Rank` and
`vectorRank` survive, but only on the hybrid path.) "How each item was ranked
and why" therefore requires threading the three components onto that type.
This is a small, contained upstream change — three optional numeric fields and
two assignment sites — but it is a real cost and is scoped in §7, not hidden.

### 2.2 The first component is not BM25 on either path, and one ask mixes both

- On the **FTS path**, `normBm25` is `1 - i / (rows.length - 1)` — a
  normalisation of *rank position* in the FTS ordering.
  `normalizeBm25LowerIsBetter` is not called there at all.
- On the **hybrid path**, the first component is the min-max normalised **RRF**
  score (`normalizeHigherIsBetter(hybridResults.map(h => h.rrfScore))`).

And `buildLocalIndexedContext` (`engine/run-ask.ts:482`) uses **both** in one
ask: the primary probe calls `searchRankedAsync(..., { semantic: true })` — the
hybrid path — while the quoted-query, repo-slug and fallback-term passes call
`searchRanked` — the FTS path. All of their results are merged into one `byId`
map, then `capPerService`'d and sliced.

**Consequence:** a single ask routinely produces one ranked list whose scores
come from two different formulas. Printing them in one column under a heading
like "relevance" or "BM25" would be wrong twice over — once on the label, once
on the implied comparability. The report therefore names the **contributing
pass** per item, and states, whenever more than one pass contributed, that
scores are not comparable across passes.

This is precisely the class of defect `explain` exists to surface. Getting it
wrong inside `explain` itself would be the worst possible place for it.

## 3. Surface

```
nimbus explain last [--json]
```

- New IPC method **`ask.explainLast`**, handled in `ipc/diagnostics-rpc.ts`
  beside `index.health`. This is engine diagnostics, not an eighteenth agent:
  no file under `agents/`, no brief kind, no synthesis, no I31 reserved
  sections, no `AnyBrief` member, no fleet digest extractor.
- `last` is a subcommand rather than a bare verb, so `nimbus explain <runId>`
  stays available for the deferred durable store (§6).
- `--json` emits the raw record. Default output is human-readable text.

### 3.1 Externally excluded, structurally

The record contains the owner's question verbatim and the titles of items
retrieved from the owner's private index. A bearer token asking "explain the
last ask" would receive the **owner's** question and the owner's data — the
same structural argument that excluded `nimbus standup`, not a sequencing one.

Therefore: LAN-forbidden (`checkLanMethodAllowed`, I5), absent from the Tauri
`ALLOWED_METHODS` allowlist (I7), absent from `EXTERNAL_AGENT_NAMES`, and no
HTTP, MCP or ChatOps route. CLI-only.

## 4. The record

### 4.1 Storage — an in-memory ring

`engine/ask-explain-recorder.ts` holds a bounded ring of the last **10**
records, in memory only. Nothing is written to disk.

`nimbus explain last` on a gateway that has answered nothing since start
reports **"no ask recorded since the gateway started"** explicitly — it does
not print an empty report, and it does not imply that no ask ever happened.

### 4.2 Routes — there are four, not two

`runAsk` (`engine/run-ask.ts:634`) has four terminal shapes. The report names
which one ran, and why:

| Route | Reached when | What the report can say |
|---|---|---|
| **empty-index guidance** | `emptyIndexGuidanceIfNeeded` returns early | The index was empty; no retrieval and no model call happened. |
| **conversational / local context** | `canUseConversation` and `shouldBuildLocalContext` — i.e. no Mastra agent, or `llmRouter.prefersLocal()` | The full report (§4.4). |
| **conversational / agent tool-calling** | `canUseConversation`, Mastra agent present, `prefersLocal()` false | The tool-call report (§4.5). |
| **plan dispatch** | classifier returns `file_search`/`file_organize` at confidence ≥ 0.6 | Classifier verdict, entities, and the plan that was dispatched. No retrieval ranking happened on this route. |

`--devil` **skips the classifier entirely** and forces the conversational
route. That is recorded as a fact ("classifier not called: --devil"), because a
missing classifier verdict otherwise looks like a failure.

### 4.3 Fields common to every route

- asked-at, question text, wall-clock duration
- route taken, and the reason it was taken (`prefer_local`, `no remote vendor
  enabled`, `vendor <x> enabled`, `--devil`)
- classifier verdict: `intent`, `confidence`, `entities`, `requiresHITL` — or
  the explicit fact that it was not called
- whether classification was itself a model call, and to which destination
  (`engine.ask.classify` is an I29 `model`-class egress row; naming the
  destination here keeps the report consistent with the ledger)
- the resolved model route: provider, model, `isLocal` (I34)
- persona in effect

### 4.4 Local-context route — per-candidate detail

**The candidate pool is wider than the pool that reaches the cap, and the
report covers the wider one.** `buildLocalIndexedContext` probes for up to
`LOCAL_CONTEXT_TOTAL_PROBE_LIMIT` (100) items, then adds only
`primary.slice(0, resolveLocalContextItemLimit())` — the top **8** — into
`byId` (`run-ask.ts:521`). Items 9–100 of the primary probe are discarded by
that slice, *before* the cap and *before* fairness ever run. They are held in
`primary` and are therefore reportable; a report that showed only what reached
the cap would silently omit the largest discard of all.

So the pool is the union of: the full primary probe result, plus everything the
quoted-query, repo-slug and fallback-term passes contributed.

For each candidate in that pool:

- source id, service, indexed type, title, modified-at
- **the three score components and the composite** (§2.1)
- final rank
- **contributing pass**: `primary-hybrid` / `quoted:<q>` / `repo-slug:<slug>` /
  `fallback-term:<k>` (§2.2)
- outcome, one of **four**, in the order they are applied:
  - `shown`
  - `cut: probe slice` — ranked outside the top 8 of the primary probe, so it
    never entered `byId` at all
  - `cut: over cap` — in `byId`, dropped by the final cap
  - `cut: service fairness` — in `byId`, displaced by per-service round-robin

The last two are kept apart deliberately. `capPerService`
(`engine/context-fairness.ts:48`) round-robins across services and will
displace a higher-scoring item to do it — deliberate behaviour, and one of the
likeliest causes of "why did it not see my PR". Folding it into the cap would
hide the single reason a user is most likely to want named.

Plus, for the ask as a whole:

- the search terms `questionSearchTerms` derived from the question, and whether
  a `fallbackSearchTerms` term fired (and which)
- the truncation record `{ shown, total, atLeast }`
- `sourceSummary` — the discarded tail, already grouped by service + type with
  date ranges by `buildContextWindow` (`engine/context-ranker.ts`)

### 4.5 Agent tool-calling route — a pointer, not a copy

The ring stores only the session id and time window. The renderer joins to
**`tool_call_log`** (V29, plus V42's `params_json`) at read time: tool id,
service, params, status, duration. The durable half is already durable; nothing
is duplicated into memory.

The report leads with the fact that on this route **nothing ranked anything** —
the model chose which tools to call, so there is no candidate set, no score and
no discard reason, because no selection was made.

> **To verify during implementation:** whether `params_json` needs
> `redactAuditPayload` treatment on this read path. It is owner-only output on
> the owner's own machine, and recipes already read the column, but the
> redaction posture must be confirmed rather than assumed.

## 5. What the report will not claim

Each of these is disclosed in the output, unconditionally, rather than silently
omitted.

- **"Connector rate-limited" is not a discard reason on the local-context
  route.** That path queries no connectors at all — it reads the local SQLite
  index. The bucket is dropped, not rendered as a permanent zero.
- **"Queried vs. answered from cache" is a misframing** and is not printed.
  The local index *is* the cache. The real axis is local index vs. live tool
  call, and that is what the route line says.
- **There is no relevance threshold.** Items are cut by top-K cap and by
  service fairness. Both are named for what they are; neither is described as a
  threshold.
- **"Given to the model", never "read by the model".** Nimbus knows what it
  handed over, not what the model attended to. This inherits the wording
  already established in `engine/context-truncation-disclosure.ts`.
- **Scores are not comparable across passes** (§2.2), stated whenever more than
  one pass contributed.
- **The ring is empty after a gateway restart**, and says so.

## 6. Deferred, with its reason

A durable `ask_explain` table — surviving restart, letting the user explain an
ask from yesterday — is **not** in this slice. It would write every question
the user asks, together with its retrieval trace, to an index that is **not
encrypted at rest**: SQLCipher (`[db.encrypt]`) is still an unshipped v0.1.1
row. Revisit alongside it, not before.

This is a recorded deferral in the shape fleet PR 2b and the computer-use
screen lane already use, not a silent gap.

## 7. Cost, stated

- `RankedIndexItem` gains three optional numeric fields; `local-index.ts`
  assigns them at its two composite sites (§2.1). Optional, so no existing
  consumer changes.
- A recorder call at the end of each of `runAsk`'s four terminal shapes.
- One new IPC method, one new CLI command, and four route reports — two of them
  substantial renderers (§4.4, §4.5), two of them a route line plus the common
  fields (§4.2).
- No migration, no invariant, no egress class, no HITL action type, and no new
  Tauri allowlist entry — the count is unchanged, and that is asserted.

## 8. Testing

- **Unit** — the ring (bound, eviction order, empty state); each renderer; the
  outcome classifier, covering all four outcomes of §4.4 including
  `cut: probe slice`, which is the largest discard and the one a cap-only
  implementation would omit.
- **Unit** — a test that fails if a candidate from more than one pass is
  rendered without the non-comparability disclosure.
- **Integration** — against a real migrated DB: the agent-route join to
  `tool_call_log` returns the calls for the right session and window.
- **E2E** — `nimbus explain last` against a freshly started gateway reports
  "no ask recorded since the gateway started"; then, after one ask, reports
  that ask.
- **Route coverage** — one test per terminal shape in §4.2, so a fifth route
  added later fails a totality check rather than silently going unreported.
