# Cold-start search starvation — design

**Date:** 2026-09-12 · **Status:** proposed · **Branch:** `dev/asafgolombek/cold-start-search`

Semantic search on a cold first run either times out with no explanation or silently
degrades to keyword-only and reports the result as complete. This design fixes both,
and makes partial index coverage a fact the product states rather than hides.

---

## 1. The observed failure

Recorded on issue #1396 (2026-09-11), during the Windows verification of the
onnxruntime extraction fix, and never filed separately:

```text
IPC request timed out after 30000ms: index.searchRanked
```

Twice, while the embedding backfill was running (`51616 -> 60532 -> 60740` items).
The reporter explicitly declined to record the run as a pass and noted the retrieval
path remained unproven on Windows.

This is precisely the Gate 1 acceptance scenario — *"semantic search works after a
cold first run"* — so it blocks the distribution milestone, not merely a nice-to-have.

## 2. Traced mechanism

Four independent defects compose into the observed timeout. Each is stated with the
symbol that carries it, so the claim can be re-derived rather than trusted.

### 2.1 Backfill and query embedding share one worker, with no fairness

`EmbeddingWorkerCore.runInit` (`packages/gateway/src/embedding/embedding-worker-core.ts`)
posts `ready` to the parent and *then* awaits `runBackfill` in the same worker realm.
`SqliteEmbeddingPipeline.backfillAll` (`packages/gateway/src/embedding/pipeline.ts`)
loops over the whole un-embedded index, and each batch runs through
`mapWithConcurrency(rows, this.backfillConcurrency, ...)` with
`DEFAULT_BACKFILL_CONCURRENCY = 8`.

So from the moment the worker reports ready until the entire index is embedded, eight
inferences are in flight continuously. An interactive `embed_texts` message is
dispatched immediately by `handleMessage`, but it competes for the same finite
inference capacity with no priority of any kind. On a 60,000-item index that window is
hours.

### 2.2 The stacked timeouts are misordered

| Bound | Value | Where |
|---|---|---|
| CLI IPC request | **30 s** | `IPCClient` default; `nimbus search` takes it |
| Bridge `embedQuery` | **60 s** | `packages/gateway/src/embedding/worker-bridge.ts` |

The outer bound is *tighter than the inner one*, so the inner one is unreachable and
has never fired in production. `nimbus ask` does not reproduce the failure because
`packages/cli/src/commands/ask.ts` constructs its client with
`INTERACTIVE_RPC_TIMEOUT_MS`; `nimbus search` passes no override and takes the 30 s
default. That asymmetry exactly matches the report — `search` timed out, `ask` was
never tried.

### 2.3 The inner timeout is a false green

`EmbeddingWorkerBridge.embedQuery` resolves `null` when its timer fires. A null vector
is indistinguishable from the permanent `unavailable` case, so hybrid search silently
becomes BM25 and a query with no lexical overlap returns `[]` — which reads as
*"searched everything, found nothing."*

This is the exact failure #928 was filed for. That fix landed for the `warming` state
(the arm immediately above throws `EmbeddingWarmingError`, carrying live readiness) and
the docblock just above it states the rule. **The timeout arm was never converted.**

### 2.4 There is no state for "ready but partial"

`EmbeddingReadiness.state` is `ready | warming | unavailable`
(`packages/gateway/src/embedding/embedding-readiness.ts`). The RPC gate in
`packages/gateway/src/ipc/server/inline-handlers.ts` refuses a semantic query only
while `warming`. Once the worker reports ready — which happens *before* backfill
starts — the state is `ready` for the entire backfill, even at 0% coverage.

`EmbeddingWorkerBridge.getBackfillProgress()` already holds the numbers. Nothing
surfaces them at the moment a user is affected by them.

### 2.5 Where the silent degrade actually happens

Worth stating precisely, because it is not where it looks. In
`LocalIndex.searchRankedAsync` (`packages/gateway/src/index/local-index.ts`) the
degrade is **inside the `canHybrid` branch**, not the non-hybrid fallback below it.
`packages/gateway/src/platform/assemble.ts` wires the semantic-search seam's
`embedQueryDual` through `embedQueryDualBestEffort`, so a warming or starved query
yields `NO_DUAL_VECTORS` and hybrid search proceeds with no vector half — quietly
becoming BM25 while still reporting itself as a hybrid result.

That site is a few lines from where this design constructs the disclosure, which is why
it is the right place to construct it.

## 3. Two facts, deliberately not conflated

| Fact | True when | Lifetime |
|---|---|---|
| **Coverage is partial** — some items have no vectors, so recall is incomplete | throughout backfill | hours |
| **This query was not vector-ranked** — starved, timed out, or warming | under contention | seconds |

Only the second causes the timeout. The first is silently wrong for far longer and has
never been disclosed at all. A design that fixes only the timeout leaves the larger
dishonesty in place.

## 4. Design

### 4.1 Worker: admission control

A permit gate mediates every embedding job in the worker. `backfillConcurrency` becomes the
permit count rather than a bare `mapWithConcurrency` argument. An arriving `embed_texts`
raises an interactive flag: background work stops acquiring **new** permits and the query
is admitted ahead of everything queued.

**It is INJECTED, not reached for.** `SqliteEmbeddingPipeline` has no visibility into worker
IPC — it cannot know an `embed_texts` arrived. So the gate is constructed in
`EmbeddingWorkerCore` and passed down through `SqliteEmbeddingPipelineOptions`; `embedBatch`
acquires a background permit per item and releases it in a `finally`. A pipeline built
without a gate behaves exactly as today, which keeps every non-worker construction site
(`create-routing-runtime.ts`, `ipc/index-reembed-rpc.ts`) unchanged.

**It lives in the worker, not the bridge**, because the bridge cannot see the backfill
at all — the loop runs inside the worker realm, reached only from `runInit`.

**Both background producers are gated, not just backfill.** `embed_item` is the second one
and it is easy to miss: `scheduleItemEmbedding` fires from `index/item-store.ts` on **every
item upsert**, wired through `sync/scheduler.ts`, so a first sync of a large mailbox posts
one message per item. Its `embedChain` is SERIAL — a single promise chain, concurrency 1 —
so the hazard is not a flood running in parallel but **one continuously-occupied inference
slot for the whole duration of the sync**, which OUTLIVES the backfill that this section is
named for. Gating `backfillAll` alone would fix the cold-start window and leave a permanent
one behind it.

**Interactive admission does NOT wait for a full drain.** The obvious implementation — block
the query until `inFlightBackground` reaches zero — makes its latency the time for all N
in-flight items to finish, which at `backfillConcurrency = 8` is roughly 8× the intended
bound and defeats the purpose. Interactive work instead jumps the QUEUE: no new background
permit is granted while it is pending, and it runs alongside whatever is already in flight.
The bound is then one item's remaining time, not eight items' total.

**It stays separate from `BackfillGate`** (`packages/gateway/src/embedding/backfill-gate.ts`).
That gate answers *may backfill proceed at all* (battery); this one answers *should it
yield right now* (an interactive request is waiting). Two questions, two mechanisms, no
merge — merging them would make a paused-for-battery backfill indistinguishable from a
yielded one in every log and test.

**Why this shape is robust to the one thing not yet measured.** Whether ONNX inference
blocks the worker's JS thread or is offloaded is *not yet verified* (see §7). Admission
control helps under either: if inference is offloaded, the query takes a free slot
immediately; if it blocks the thread, the query waits behind **one** in-flight item
rather than eight. The measurement determines the residual latency, not the design.

### 4.2 Error contract: kill the false green

`embedQuery`'s timeout arm throws `EmbeddingTimeoutError` — carrying readiness, defined
beside `EmbeddingWarmingError` in `embedding-readiness.ts` with the same brand-check guard —
instead of resolving `null`. RPC code **-32022**, verified free (`EMBEDDING_WARMING_RPC_CODE`
is -32021).

The budget drops from 60 s to **5 s** by default, overridable with
`NIMBUS_EMBEDDING_QUERY_TIMEOUT_MS` for the same reason `NIMBUS_EMBEDDING_INIT_TIMEOUT_MS`
exists. Under contention the correct behaviour is to *fail to BM25 fast and say so*, not to
make a person wait. A `[embedding] query_timeout_ms` TOML key is **deferred** — the env
override covers diagnosis, and no user has needed to tune this; add it when one does.

The stacked bounds become deliberately ordered, innermost tightest — embed budget well
under the CLI's 30 s — so the inner bound is the one that fires and the user gets a
disclosed degradation instead of a transport error.

`embedQueryBestEffort` / `embedQueryDualBestEffort` keep swallowing the error; they are
the sanctioned silent-degrade sites and their docblock says as much. They now **record**
what they swallowed rather than discarding it, which is what lets §4.3 reconstruct it.

The error is brand-checked, not `instanceof`-checked, for the reason
`isEmbeddingWarmingError` already documents: the runtime crosses a Worker realm and a
duplicated module instance defeats `instanceof`.

### 4.3 Disclosure: constructed once, at the site that knows

`LocalIndex.searchRankedAsync` is the single place that knows both facts of §3 — it
sees whether the vector half came back empty, and it can read coverage from
`embedding_chunk`. It constructs a `retrieval` block: whether the query was
vector-ranked, why not if not, and coverage as embedded/total.

Constructed by the thing that knows, re-attached verbatim, never routed through
anything that could drop it. This is deliberately the shape invariant **I31** uses for
brief disclosures, for the same reason: a disclosure a renderer must remember to add is
a disclosure that will eventually go missing.

**Coverage must NOT be computed per query.** `nimbus index health`'s figure comes from
`db/index-health.ts`'s `readPerService`, a `LEFT JOIN` over `SELECT DISTINCT item_id FROM
embedding_chunk` grouped across the whole `item` table. That is the right shape for a report
run on demand and the wrong shape for something on the path of every search: it is a full
scan of both tables, paid on a keystroke, against an index this design assumes is large.

So the per-query figure comes from the **O(1) in-memory counter that already exists** —
`EmbeddingWorkerBridge.getBackfillProgress()`, fed by `backfill_progress` messages. When no
backfill is running the block reports coverage as **absent** rather than paying for a scan
to say "probably complete".

**The two numbers are therefore different by construction, and the disclosure says so.**
`index health` stays the authoritative full computation; the search-time figure is a live
progress counter that can lag it and does not account for items that failed to embed. Naming
one as authoritative and the other as an indicator is honest; quietly presenting a cheap
approximation as the real coverage would not be. Rejected: caching `readPerService` behind a
TTL — it buys a number that is neither live nor authoritative, and adds an invalidation bug
surface for a figure that only matters while backfill is running, which is exactly when the
free counter is available.

### 4.4 Wire compatibility — opt-in, not a break

`searchRankedAsync` returns a bare `RankedIndexItem[]`, and `index.searchRanked` returns
that array over IPC to `@nimbus-dev/client`, a **published MIT package** consumed by
this CLI (`packages/cli/src/ipc-client/index.ts` is a straight re-export of it) and by
nimbus-vscode.

**This was verified, not assumed, and the result is stronger than expected.** That
package does not merely *type* the response — `NimbusClient.searchRanked` pipes it
through a runtime validator whose first act is to assert the value is an array. An
unconditional `{ items, retrieval }` envelope therefore does not mistype at the
boundary; it makes **every** `NimbusClient.searchRanked()` call **throw at runtime** on
the currently published version. Changing the shape unconditionally fails CLAUDE.md's
breaking-change test — *what must an existing user change to keep working?* — with the
strongest possible answer: upgrade their client or the call stops working entirely.

**The split is at the IPC boundary, not inside the gateway.** `searchRankedAsync` ALWAYS
returns `{ items, retrieval }` to its in-process callers; only `rpcSearchRanked` unwraps to
a bare array unless the request passes `envelope: true`. Every gateway subsystem therefore
gets the disclosure whether or not it asked, and the opt-in exists solely to keep the
published wire contract intact.

That recovers most of what an opt-in would otherwise cost. The residual is narrow and real:
**a third-party IPC client that never passes the flag still receives undisclosed partial
results.** First-party surfaces all pass it. The alternative is burning a major on a
satellite contract for a non-security disclosure, which is the worse trade. Revisit if the
client contract breaks for an unrelated reason.

### 4.5 Consumers — enumerated

"Every consumer" is only meaningful as an enumeration of CALL SITES. An earlier draft of this
section listed capabilities instead — "agent briefs", "`nimbus ask`" — which reads like a list
and is not one; it named no file and would not have caught an omission. Derived with
`grep -rn searchRankedAsync`:

| Call site | Note |
|---|---|
| `index/local-index.ts` | the definition — constructs the block (§4.3) |
| `ipc/server/inline-handlers.ts` | `rpcSearchRanked` — unwraps unless `envelope: true` (§4.4) |
| `engine/run-ask.ts` | `nimbus ask` |
| `engine/agent.ts` | the Mastra engine agent's index tool |
| `briefs/brief-index-search.ts` | agent briefs |
| `toolgen/toolgen-grounding.ts` | `api_endpoint` grounding for `nimbus tool create` |

Downstream of `rpcSearchRanked`: `nimbus search` (CLI) and the MCP adapter
(`packages/cli/src/mcp/adapter.ts`, rides `wrapToolOutput`, I11). `nimbus doctor` /
`nimbus index health` are not callers — they keep their own authoritative computation and
this design deliberately does not converge them (§4.3).

**Out of reach, verified rather than assumed:** there is **no HTTP route** — no `/v1/search`
of any kind — and the Tauri renderer cannot reach it either, since the `index.` namespace
allows only `index.metrics` (I7). Those two are why the blast radius is smaller than "every
consumer" first sounds.

**CLI output contract.** `nimbus search` currently does
`console.log(JSON.stringify(rows, null, 2))` on a bare array, and the command is meant to
pipe: `nimbus search q | jq '.[0]'`. Printing `{ items, retrieval }` to stdout would break
every such script. So the CLI passes `envelope: true`, prints **`items` as an array on
stdout, unchanged**, and writes the disclosure to **stderr**:

```text
[stderr] note: semantic ranking unavailable (timed out under load) — showing keyword-only results.
[stderr] note: embedding coverage 8,400/60,000 items. Run 'nimbus index health' for detail.
[stdout] [ { "id": "…", "title": "…" }, … ]
```

A `--json-envelope` flag putting the whole structure on stdout is **deferred**: no consumer
has asked for it, gateway-internal callers already get the envelope by default (§4.4), and
the MCP adapter reaches it through IPC rather than the CLI. Add it on demand.

## 5. Rejected alternatives

- **Sidecar accessor.** Extend `embeddingReadiness()` with coverage and have each
  renderer consult it. Ships fastest and changes no response shape — and is exactly the
  drift I31 exists to prevent: a renderer that forgets reports partial results as
  complete, and nothing fails.
- **Refuse instead of degrade.** Extend the `warming` RPC refusal to cover partial
  coverage. Most honest and cheapest, but makes search unusable for the whole first
  backfill — the direct opposite of the Gate 1 goal.
- **Throttle the backfill on host idleness.** `HostActivity` shipped with the fleet work
  and is already wired to `pause_on_battery`, so this is tempting and cheap. It trades a
  fast index for a responsive one *without fixing starvation* — it makes the bad case
  rarer and no less silent. Out of scope; reconsider only after §7's measurement.
- **Break the wire contract.** See §4.4.

## 6. Testing

- **Reproduction first.** The first commit red-proves the starvation with a measured
  number: a query issued against a saturating backfill, asserting the latency, and
  failing on today's code. No fix is written for an inferred mechanism.
- The reproduction must be **self-validating** — it asserts the backfill was genuinely
  saturating, or it passes vacuously on a machine that never contended.
- **Red-prove by reverting**, not by observing green: each arm's test is confirmed to
  fail with that arm removed.
- The false-green arm (§4.2) gets a test asserting the *typed throw*, not merely a
  non-null result — a truthiness assertion here would pass for the wrong reason.
- Coverage agreement (§4.3) is asserted against `nimbus index health`'s own figure, so
  the two cannot drift.

## 7. Open questions and residuals

- **Unmeasured:** whether ONNX inference blocks the worker's JS thread or is offloaded.
  Resolved by the §6 reproduction before any fix lands. Per §4.1 it changes the residual
  latency, not the design shape — but the spec should not pretend it is known.

  **This survived a review that claimed to close it.** The 2026-09-12 review's § 5.1 offers
  a "Finding" that tokenization runs in JS and tensor math on native threadpools, with a
  latency bound of 50–250 ms. No measurement backs it — it is the same inference this
  residual already records, restated with more confidence and unsourced numbers (its § 2.3
  likewise asserts a 20–150 ms scan penalty). Adopting it would convert an honest unknown
  into a false attestation, which is the specific failure this repo keeps re-learning. The
  reproduction produces the number; until then the entry stands.

- **Deferred, with reasons** (all from the same review): a `[embedding] query_timeout_ms`
  TOML key (§4.2 — the env override covers diagnosis), a `--json-envelope` CLI flag (§4.5 —
  no consumer), and converging `nimbus index health` onto the search-time coverage figure
  (§4.3 — they are deliberately different numbers).
- **The disclosure is opt-in** (§4.4), so a third-party client that does not pass the
  flag still receives undisclosed partial results. Stated, not designed away.
- **The client-validator finding is version-pinned.** §4.4 was verified against
  `@nimbus-dev/client` 0.17.3, the version this workspace resolves. It is a fact about
  that release, not a permanent property: a later client that tolerates the envelope
  would reopen the unconditional option. Re-derive before acting on it, rather than
  citing this spec.
- **Coverage is not quality.** A fully-backfilled index can still rank badly; this
  design discloses *incompleteness*, and claims nothing about relevance.

## 8. Scope

No new security invariant — this is not a structural defense, and inventing one would
dilute the I-series. No schema migration. **No new config key** — the timeout takes an env
override only, and the TOML key is deferred (§7).

Delivery, three PRs, each independently shippable:

1. **Reproduction + admission control** (§4.1) — the self-validating reproduction lands
   FIRST and red-proves the starvation with a measured number, which also resolves §7's
   open question. Then the gate, covering `backfillAll` **and** `embed_item`.
2. **Error contract + timeout ordering** (§4.2) — `EmbeddingTimeoutError`, 60 s → 5 s, and
   the `*BestEffort` wrappers recording what they swallow.
3. **Disclosure + consumers** (§4.3–§4.5) — the envelope, the IPC unwrap, and the six call
   sites plus the CLI stdout/stderr contract.

**Neither this spec nor its review reaches `main`.** Both are deleted from the branch before
PR 1 opens; squash takes the net tree diff, so nothing lands. Anything durable goes to
`docs/architecture.md` first.
