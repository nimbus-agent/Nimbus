# `nimbus explain last` — an X-ray of the most recent `nimbus ask`

**Status:** design approved 2026-09-14; revised 2026-09-14 after external review
(`2026-09-14-nimbus-explain-last-review.md`). Implementation not started.
**Roadmap row:** [`docs/roadmap.md` § v0.1.1 batch](../../roadmap.md) — "`nimbus explain last` (X-ray of the most recent `nimbus ask`)".
**Schema:** none. **Invariant:** none new (but see §3.2 — an I5 denylist entry is required). **Egress class:** none. **HITL action type:** none.

---

## 1. Why

`nimbus ask` can return a weak or wrong answer for reasons that are entirely
mechanical and entirely invisible: the search terms did not match, the primary
probe returned nothing and a fallback term fired, a high-scoring item was
displaced by per-service fairness, the context cap cut the tail, the local model
failed and the turn silently re-ran on a remote agent, or the classifier routed
the question away from the conversational path altogether. Today none of that is
observable. The user sees a paragraph and has no way to tell a retrieval failure
from a model failure.

This command makes the mechanical half legible. It is the retrieval-side
companion to `nimbus prove`: `prove` answers *what left the machine*,
`explain last` answers *what was put in front of the model, and what was not*.

## 2. Findings from the code that shape the design

Recorded because the roadmap row reflects none of them, and an implementation
written from the row alone would print several wrong things.

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
and why" therefore requires threading the components onto that type.

**Field naming matters here and is not cosmetic** (§2.2 explains why):

```ts
export type RankedIndexItem = NimbusItem & {
  score: number;
  // ...existing fields...
  matchScore?: number;            // normalised RRF (hybrid) or rank-position (FTS)
  recencyComponent?: number;      // recencyScore(modifiedAt, now)
  servicePriorityComponent?: number;
  scoringFormula?: "hybrid_rrf" | "fts_rank";
};
```

Naming the first field `bm25Score` would bake the §2.2 error into the type
system. `scoringFormula` is what lets the renderer group comparable scores and
refuse to compare incomparable ones, rather than the renderer re-deriving it.

All four are **optional**, which is load-bearing: §2.4's candidates have none of
them.

### 2.2 The first component is not BM25 on either path, and one ask mixes both

- On the **FTS path**, `normBm25` is `1 - i / (rows.length - 1)` — a
  normalisation of *rank position* in the FTS ordering.
  `normalizeBm25LowerIsBetter` is not called there at all.
- On the **hybrid path**, the first component is the min-max normalised **RRF**
  score (`normalizeHigherIsBetter(hybridResults.map(h => h.rrfScore))`).

And `buildLocalIndexedContext` (`engine/run-ask.ts:482`) uses **both** in one
ask: the primary probe calls `searchRankedAsync(..., { semantic: true })` — the
hybrid path — while the quoted-query and fallback-term passes call
`searchRanked` — the FTS path. All results are merged into one `byId` map, then
`capPerService`'d and sliced.

**Consequence:** a single ask routinely produces one list whose scores come from
two different formulas. Printing them in one column under "relevance" or "BM25"
would be wrong twice — once on the label, once on the implied comparability. The
report names the contributing pass per item, and states, whenever more than one
formula contributed, that scores are not comparable across passes. Getting this
wrong inside `explain` would be the worst possible place for it.

### 2.3 `byId` is in insertion order, not score order

`capPerService` receives `[...byId.values()]` and `bucketByService` groups
"in input order" (`context-fairness.ts:37`). `byId` is filled pass by pass —
primary, then quoted, then repo-slug, then fallback — each ranked *within* its
pass. **The pipeline never sorts globally by score.**

This rules out defining a cut reason in terms of "would have been admitted under
a naive top-K by score": no such ordering exists anywhere in the code. §4.6
defines the outcomes against insertion order, which is what actually decides
them.

### 2.4 The repo-slug pass is raw SQL and has no scores at all

`githubIssueContextItemsForRepo` (`run-ask.ts:440`) queries SQLite directly —
`... ORDER BY modified_at DESC, synced_at DESC, title ASC LIMIT ?` — and its
projection does not even select `modified_at`. These candidates have **no**
lexical, recency, service-priority or composite score, because none was ever
computed for them.

The candidate model must therefore admit score-less entries, and the renderer
must print `n/a (direct query)` rather than `0.00`. Rendering an absent score as
zero would claim these items ranked last when in fact they were never ranked —
the precise failure mode this command exists to expose.

### 2.5 `buildContextWindow` belongs to the agent route, not the local route

`buildContextWindow` (`engine/context-ranker.ts`) has exactly one non-test
caller: `engine/agent.ts:235`, inside the `searchLocalIndex` **tool**.
`buildLocalIndexedContext` does not call it.

Two consequences, and the second is the more useful:

1. The local-context route has **no** `sourceSummary` today, so the recorder must
   construct the grouped discarded tail itself. **Not by reusing
   `buildContextWindow`**, inviting as that looks: its cap is
   `Math.min(200, Math.max(1, Math.floor(maxItems)))`, so asking it to summarise
   *everything* by passing `0` clamps to `1` — it keeps the first discarded row
   as an "item" and silently omits it from the summary. It would also need an
   unsound cast, since a candidate is not a `RankedIndexItem`. Ten lines of
   explicit grouping beat a tested function used off its contract.
2. **The agent route does rank — inside each tool call.** `searchLocalIndex`
   calls `searchRankedAsync`, builds a context window, and returns
   `totalMatches` / `itemsInWindow` / `sourceSummary` in its result. So §4.5's
   report is richer than "the model chose": each search the model ran has a real
   ranking and a real discarded tail. What is absent on that route is ranking
   *across the turn*, not ranking at all.

## 3. Surface

```
nimbus explain last [--json]
```

- New IPC method **`ask.explainLast`**, handled in `ipc/diagnostics-rpc.ts`
  beside `index.health`. This is engine diagnostics, not an eighteenth agent:
  no file under `agents/`, no brief kind, no synthesis, no I31 reserved
  sections, no `AnyBrief` member, no fleet digest extractor.
- `last` is a subcommand rather than a bare verb, so `nimbus explain <n>` stays
  available for the deferred history navigation (§6.2).
- `--json` emits the raw record (§9). Default output is human-readable text.

### 3.1 A handler is not a route

`tryDispatchDiagnosticsRpc` (`ipc/server/dispatchers.ts`) routes to
`diagnostics-rpc.ts` only for `db.*`, `diag.*`, `telemetry.*`, `config.*` and an
explicit list of `index.*` methods. **A handler added without a routing entry
compiles, unit-tests green, and returns `Method not found` over a real socket** —
this repo has shipped that exact defect before. `ask.explainLast` must be added
to the dispatcher's match, and `DiagnosticsRpcContext` must carry the
`AskExplainRecorder` instance.

The e2e test in §8 exists specifically to catch this, because a unit test that
calls the sub-dispatcher directly cannot.

### 3.2 LAN exclusion is opt-in, not automatic — this was wrong in the first draft

The first draft asserted "LAN-forbidden (`checkLanMethodAllowed`, I5)" as though
exclusion followed from the method being new and local. **It is the opposite.**
`checkLanMethodAllowed` (`ipc/lan-rpc.ts:206`) is a **denylist**:

```ts
if (FORBIDDEN_OVER_LAN.has(ns) || FORBIDDEN_OVER_LAN.has(method)) { throw ... }
```

Everything not named is **allowed**. There is no `ask` namespace today
(`engine.ask` is in `WRITE_METHODS`, which gates on peer write permission — a
different set and a weaker guarantee), so `ask.explainLast` would ship
**reachable by any paired LAN peer**, handing them the owner's question text and
the titles of the owner's indexed items.

**Required:** add `"ask"` to `FORBIDDEN_OVER_LAN` as a **whole-namespace**
forbid, matching the precedent every S2 namespace set — `exec`, `computer`,
`media`, `fleet`, `toolgen` are all namespace-level entries for exactly this
reason: there are no read verbs worth preserving, and a namespace forbid costs
nothing while a per-method forbid is one future method away from a gap.

Plus an enforcement test in `security-invariants.test.ts` asserting
`ask.explainLast` is rejected over LAN. This does not create a new invariant; it
adds a case to I5's existing coverage.

The rest of the exclusion story stands: absent from the Tauri `ALLOWED_METHODS`
allowlist (I7 — the count is unchanged, and that is asserted), absent from
`EXTERNAL_AGENT_NAMES`, and no HTTP, MCP or ChatOps route. The reason is
structural, the same one that excluded `nimbus standup`: the record contains the
owner's question verbatim and data drawn from the owner's private index, so an
external caller asking "explain the last ask" receives the **owner's** ask.

## 4. The record

### 4.1 Storage — an in-memory ring

`engine/ask-explain-recorder.ts` holds a bounded ring of the last **10**
records, in memory only. Nothing is written to disk.

`nimbus explain last` on a gateway that has answered nothing since start reports
**"no ask recorded since the gateway started"** explicitly — it does not print
an empty report, and it does not imply that no ask ever happened.

### 4.2 Routes are outcomes, not a partition

`runAsk` (`engine/run-ask.ts:634`) has four terminal shapes, **and they are not
mutually exclusive.** The first draft modelled them as a partition; they are
not.

| Route | Reached when |
|---|---|
| **empty-index guidance** | `emptyIndexGuidanceIfNeeded` returns early |
| **conversational / local context** | `canUseConversation` and `shouldBuildLocalContext` — no Mastra agent, or `llmRouter.prefersLocal()` |
| **conversational / agent tool-calling** | `canUseConversation`, Mastra agent present, `prefersLocal()` false |
| **plan dispatch** | classifier returns `file_search`/`file_organize` at confidence ≥ 0.6 |

**The local→agent fallback makes one ask two routes.**
`run-conversational-agent.ts:218` runs the local router, and on failure — when a
Mastra agent exists and air-gap is off — logs a warning and re-runs the turn on
the remote agent. So `buildLocalIndexedContext` assembled a context, the local
model threw, and the answer came from the agent path with different context
entirely. `runTurn` already returns the discriminator (`toolless: true|false`).

The record therefore carries `route` **and** `fallbackFromLocalRouter?: { error: string }`.
A user whose air-gapped-feeling local setup silently answered from a cloud vendor
has no other way to find out; `enforce_air_gap` correctly refuses this fallback,
but it is off by default.

`--devil` **skips the classifier entirely** and forces the conversational route,
recorded as a fact ("classifier not called: --devil") — a missing verdict
otherwise reads as a failure.

**Failed asks are recorded.** If `runAsk` throws, a recorder that only writes on
success leaves `explain last` showing the *previous* successful ask — actively
deceiving the user at the moment they most need the truth. The recorder wraps
the call and records `outcome: "failed"` with the stage reached
(`classification` / `retrieval` / `model`), the error, and the duration.

### 4.3 Fields common to every route

- asked-at, question text, wall-clock duration, `outcome: "answered" | "failed"`
- **`source`: `"chatops" | "local"`, and only those two.** `runAsk` is shared by
  CLI `nimbus ask`, desktop `engine.askStream`, and the ChatOps `@nimbus` bot,
  all against one gateway and one ring — so a teammate's Slack question would
  otherwise appear, unlabelled, as "your last ask".

  A three-way `cli | desktop | chatops` split is **not derivable and must not be
  claimed**. `ClientKindStore.RECOGNISED` admits a declared kind only from
  `cli`/`mcp`/`ui`, and in practice **only the MCP adapter ever calls
  `session.declareKind`** (`packages/cli/src/mcp/adapter.ts:249`) — a plain
  `nimbus ask` arrives undeclared and resolves to `unknown`, so a `source: cli`
  label would be an invention.

  What *is* a fact: `gateway-main.ts:229` binds the ChatOps ask path with a
  literal `clientId: "chatops"`. So the recorder derives `chatops` from that
  clientId and reports everything else as `local` — "some client on this
  machine's socket". That is the distinction the field exists for (did this come
  from the channel, or from here?), and it is the only one the gateway actually
  knows.
- route taken, the reason it was taken (`prefer_local`, `no remote vendor
  enabled`, `vendor <x> enabled`, `--devil`), and any fallback (§4.2)
- classifier verdict: `intent`, `confidence`, `entities`, `requiresHITL` — or the
  explicit fact that it was not called
- **classifier destination.** `classifyIntent` obtains an `LlmGenerateResult`
  and returns only `ClassifiedIntent` (`router.ts:185`), so the provider/model
  are discarded. **The fix is not to change that exported signature** — it is to
  wrap the collector one level up, where `classifyIntentForAskWithLocalFallback`
  already constructs the policy as `(opts) => router.generate(opts)`. Wrapping
  that closure captures the metadata at the exact seam, touches one function,
  and leaves `classifyIntent`'s signature and its tests alone.
- the resolved model route: provider, model, `isLocal` (I34)
- persona in effect

### 4.4 Local-context route — the candidate pool

**The pool is wider than what reaches the cap, and the report covers the wider
one.** `buildLocalIndexedContext` probes for up to
`LOCAL_CONTEXT_TOTAL_PROBE_LIMIT` (100) items, then adds only
`primary.slice(0, resolveLocalContextItemLimit())` — the top **8** — into `byId`
(`run-ask.ts:521`). Items 9–100 are discarded by that slice, *before* the cap
and *before* fairness. They are held in `primary` and are reportable; a report
covering only what reached the cap would omit the largest discard of all.

The pool is the union of the full primary probe result plus everything the
quoted-query, repo-slug and fallback-term passes contributed.

Per candidate:

- source id, service, indexed type, title, modified-at *(absent for §2.4's
  repo-slug rows — the projection does not select it)*
- the score components and composite, **or `n/a (direct query)`** (§2.1, §2.4)
- `scoringFormula`, so the renderer knows what is comparable with what
- contributing pass: `primary-hybrid` / `quoted:<q>` / `repo-slug:<slug>` /
  `fallback-term:<k>`
- outcome (§4.6)

For the ask as a whole: the `questionSearchTerms` derived from the question and
whether a `fallbackSearchTerms` term fired (and which); the truncation record
`{ shown, total, atLeast }`; and a `sourceSummary` of the discarded tail grouped
by service and type, **constructed by the recorder** via `buildContextWindow`
(§2.5 — it is not produced on this path today).

### 4.5 Agent tool-calling route — collected in process, not joined from SQL

The first draft stored `{ sessionId, timeWindow }` and joined to `tool_call_log`
at read time. **That does not work.** `agent.ts:47` writes
`getAgentRequestSessionId() ?? null`, and a plain `nimbus ask` passes no
session — so the rows land with `session_id` NULL, and a join on
`session_id IS NULL AND called_at BETWEEN …` conflates concurrent asks and
background work.

The review proposed minting an ephemeral id into
`agentRequestContext.run({ sessionId: sessionId ?? ephemeralRunId })`. **Rejected:**
`sessionId` drives `SessionMemoryStore` — `loadRecentConversationHistory`,
`persistConversationTurn` and the `semanticRecall` tool all key on it. Giving
every session-less ask a fresh random id would make each turn a new session, and
conversation history would silently stop working. That is a real regression
traded for a diagnostic.

**Instead: collect in process.** `agentRequestContext` is already an
`AsyncLocalStorage` carrying per-turn state for exactly this purpose — it holds
`negationDisclosures`, drained per turn by `runConversationalAgent`. The record
gains a collector on the same context; the tool wrapper in `agent.ts`, which has
the data in hand, pushes a compact entry. This needs no session id, no time
window, no SQL join, is immune to concurrency, and works when `session_id` is
NULL — which is the default case.

It also sidesteps `result_envelope` truncation: that column is truncated at
`MAX_ENVELOPE_BYTES` (and, unlike `params_json`, not redacted), so recovering
`totalMatches` by parsing it back out of SQLite would fail on exactly the large
results worth explaining.

Per tool call: tool id, service, params, status, duration — and, for
`searchLocalIndex` calls, the `totalMatches` / `itemsInWindow` / `sourceSummary`
the tool already computed (§2.5). The route's lead line states that the **model**
chose which tools to call and with what parameters, and that nothing ranked
*across* the turn — not that nothing ranked at all.

`params_json` needs no redaction on this path: `writeToolCallLog` already
applies `redactAuditPayload` at write (`db/tool-call-log.ts:57`). In-process
collection must apply the same redaction before storing, so the two paths cannot
disagree about what is safe to show.

### 4.6 The four outcomes, defined against insertion order

Let `P` be the primary probe list, `K = resolveLocalContextItemLimit()`,
`byId` the merged map, `N = [...byId.values()]` (**insertion order**, §2.3), and
`S = capPerService(N, K)`.

For each candidate `x` in the union pool, in application order:

1. `x ∈ S` → **`shown`**
2. `x ∉ byId` (i.e. `x ∈ P[K..]`, never merged) → **`cut: probe slice`**
3. `x ∈ byId`, `x ∉ S`, and `x` is within `N[0..K-1]` → **`cut: service fairness`**
   — it was inside the budget by arrival order and was displaced by the
   round-robin drain
4. `x ∈ byId`, `x ∉ S`, otherwise → **`cut: over cap`**

Rule 3 is deliberately phrased as "within the budget by arrival order", not
"would have been admitted under a naive top-K": §2.3 establishes that no global
score ordering exists in this pipeline, so a score-based counterfactual would be
fiction.

**Multi-pass reconciliation.** An item at primary rank 15 that *also* matches a
quoted term is merged by the quoted pass. It is reconciled by its fate in
`byId` — pass recorded as the one that actually inserted it
(`addRankedResults` keeps the first writer, `if (!byId.has(...))`), outcome from
rules 1/3/4. It is never `cut: probe slice`, because it is in `byId`.

## 5. What the report will not claim

Disclosed in the output, unconditionally, rather than silently omitted.

- **"Connector rate-limited" is not a discard reason on the local-context
  route.** That path queries no connectors — it reads local SQLite. The bucket
  is dropped, not rendered as a permanent zero.
- **"Queried vs. answered from cache" is a misframing** and is not printed. The
  local index *is* the cache. The real axis is local index vs. live tool call.
- **There is no relevance threshold.** Items are cut by probe slice, by cap, and
  by service fairness. Each is named for what it is.
- **"Given to the model", never "read by the model"** — inheriting the wording in
  `engine/context-truncation-disclosure.ts`.
- **Scores are not comparable across formulas** (§2.2), stated whenever more
  than one contributed; and score-less candidates say `n/a (direct query)`,
  never `0.00` (§2.4).
- **On the agent route, ranking happened per tool call, not across the turn**
  (§2.5) — the honest form of "the model chose".
- **The ring is empty after a gateway restart**, and says so.

## 6. Deferred, each with its reason

### 6.1 A durable `ask_explain` table
Surviving restart, explaining an ask from yesterday. It would write every
question the user asks, with its retrieval trace, to an index that is **not
encrypted at rest** — SQLCipher (`[db.encrypt]`) is still an unshipped v0.1.1
row. Revisit alongside it, not before.

### 6.2 `nimbus explain list` / `nimbus explain <n>`
The ring holds 10; exposing navigation over it is cheap and needs no disk. It is
still scope beyond the roadmap row, which is `explain last`, and it is being
proposed before anyone has used `last` once. Deferred as a fast follow, not a
gap — the `last` subcommand already reserves the grammar.

### 6.3 Capturing negation predicates and `indexCountFor`
`indexCountFor` runs on every conversational ask and the negation tools live
only on the agent path. Both are additive mechanical detail that would make the
picture complete, but neither answers "why was my answer weak" for the cases
this command is being built for. Deferred with the shape recorded.

## 7. Cost, stated

- `RankedIndexItem` gains four optional fields; `local-index.ts` assigns them at
  its two composite sites (§2.1). Optional, so no existing consumer changes.
- A collector closure wrapping `policy.generate` in
  `classifyIntentForAskWithLocalFallback` (§4.3) — one function, no exported
  signature change.
- A per-turn collector field on `agentRequestContext`, and a push from the
  `agent.ts` tool wrapper (§4.5), alongside the existing `negationDisclosures`
  precedent.
- A recorder wrapping `runAsk` — including its throw path (§4.2).
- **`"ask"` added to `FORBIDDEN_OVER_LAN` + an I5 enforcement test** (§3.2).
- **`ask.explainLast` routed in `tryDispatchDiagnosticsRpc`** (§3.1).
- One IPC handler, one CLI command, four route reports — two substantial
  renderers (§4.4, §4.5), two a route line plus common fields.
- No migration, no new invariant, no egress class, no HITL action type, no new
  Tauri allowlist entry.

## 8. Testing

- **Unit** — the ring (bound, eviction order, empty state); each renderer; the
  outcome classifier over all four outcomes of §4.6, including `cut: probe
  slice` (the largest discard, which a cap-only implementation omits) and the
  multi-pass reconciliation case.
- **Unit** — a score-less repo-slug candidate renders `n/a (direct query)` and
  never `0.00` (§2.4).
- **Unit** — a pool mixing `hybrid_rrf` and `fts_rank` cannot render without the
  non-comparability disclosure.
- **Unit** — a failed ask is recorded with its stage, and `explain last` after a
  failure does not show the previous successful ask (§4.2).
- **Unit** — a local→agent fallback records both the local error and the agent
  route (§4.2).
- **Security invariant** — `ask.explainLast` is rejected over LAN (§3.2). Written
  as a case in `security-invariants.test.ts` under I5.
- **Integration** — in-process tool collection returns the right calls for a
  session-less ask, where a `session_id`-keyed join would conflate (§4.5).
- **E2E over a real socket** — `nimbus explain last` on a fresh gateway reports
  the empty state; after one ask, reports that ask. This is the test that
  catches a handler added without a dispatcher route (§3.1); a unit test calling
  the sub-dispatcher directly cannot.
- **Route coverage** — one test per terminal shape in §4.2, so a fifth route
  fails a totality check rather than going silently unreported.

## 9. Output shape

`--json` returns a discriminated union; the text renderer is a view over it.

```ts
export type AskExplainRecord = BaseExplainRecord &
  ( | { readonly route: "empty_index" }
    | { readonly route: "local_context"; readonly pool: LocalCandidate[]; /* ... */ }
    | { readonly route: "agent_tools"; readonly toolCalls: CollectedToolCall[] }
    | { readonly route: "plan_dispatch"; readonly plan: string }
    | { readonly route: "failed"; readonly stage: "classification" | "retrieval" | "model" } );

export interface BaseExplainRecord {
  readonly askedAt: number;
  readonly durationMs: number;
  readonly question: string;
  readonly source: "chatops" | "local"; // see §4.3 — a cli/desktop split is not derivable
  readonly persona: string;
  readonly modelRoute: { provider: string; model: string; isLocal: boolean };
  readonly classifier:
    | { called: false; reason: string }
    | { called: true; intent: string; confidence: number;
        entities: Record<string, string>; destination: string };
  readonly fallbackFromLocalRouter?: { readonly error: string };
}
```

Text form, local-context route (illustrative — the score column is grouped by
`scoringFormula`, never merged across formulas):

```text
Ask explained — 2026-09-14 18:42:10Z · 342 ms · source: local
Question: "what did we decide about rate limiting on slack?"
Route:    conversational / local context   (reason: llm.prefer_local = true)
Model:    ollama / llama3.2 (local)        Persona: standard
Classifier: not called (local preference)

Search terms: ["rate", "limiting", "slack"]   Fallback: not fired
Given to the model: 8 of 41 matching items

Pass: primary-hybrid   (formula: hybrid_rrf — scores comparable within this block)
  #1  0.84 [match .90 / rec .80 / svc .75]  slack  message  #eng: rate limiting RFC     shown
  #9  0.45 [match .50 / rec .40 / svc .40]  slack  message  #eng: old rate limit ideas  cut: probe slice

Pass: repo-slug:acme/api  (formula: none — direct query, ordered by modified_at)
  --  n/a (direct query)                    github pr       #412 Add redis rate limiter shown

Note: scores above come from two different formulas and are not comparable across passes.
```
