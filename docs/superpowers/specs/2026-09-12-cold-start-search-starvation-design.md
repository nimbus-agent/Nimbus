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

`EmbeddingWorkerCore` gains a permit lane. Backfill acquires one permit per item — the
existing `backfillConcurrency` becomes the permit count rather than a bare
`mapWithConcurrency` argument. An arriving `embed_texts` raises an interactive flag:
backfill stops acquiring new permits, in-flight ones drain, the query embeds, permits
resume.

**It lives in the worker, not the bridge**, because the bridge cannot see the backfill
at all — the loop runs inside the worker realm, reached only from `runInit`.

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

`embedQuery`'s timeout arm throws a typed error carrying readiness instead of resolving
`null`, mirroring the `warming` arm directly above it. The budget drops from 60 s to a
few seconds: under contention the correct behaviour is to *fail to BM25 fast and say
so*, not to make a person wait.

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

**Coverage is read, not recomputed.** `nimbus index health` already computes
per-connector embedding coverage; this block must agree with it rather than derive a
second number that can disagree. The shared derivation is the deliverable, not the two
call sites.

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

So the envelope is **opt-in**. A request without the flag gets a byte-identical response
to today; a request with it gets the envelope. Every first-party surface passes it.

**Stated cost, not softened:** this makes the disclosure structural *for callers who
ask*, which is weaker than I31's guarantee. The alternative is burning a major on a
satellite contract for a non-security disclosure, which is the worse trade. Revisit if
the client contract breaks for an unrelated reason.

### 4.5 Consumers — enumerated

"Every consumer" is only meaningful as a list. Derived, not assumed:

| Surface | Status |
|---|---|
| `nimbus search` (CLI) | in scope — the surface that fails today |
| `nimbus ask` | in scope — same engine path |
| MCP server index tools (`packages/cli/src/mcp/adapter.ts`) | in scope — rides `wrapToolOutput` (I11) |
| Agent briefs | in scope — retrieval-backed |
| `nimbus doctor` / `nimbus index health` | in scope — must agree, per §4.3 |
| HTTP API | **no route exists** — verified, there is no `/v1/search` |
| Tauri renderer | **not exposed** — the `index.` namespace allows only `index.metrics` (I7) |

The last two rows are the reason the blast radius is smaller than "every consumer"
first sounds.

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
dilute the I-series. No schema migration. At most one new config key. Delivery splits
along §4.1 / §4.2 / §4.3 + §4.5, each independently shippable, with §6's reproduction
landing before all of them.
