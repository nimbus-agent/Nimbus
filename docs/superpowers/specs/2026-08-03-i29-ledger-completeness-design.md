# I29 ledger completeness — the `fetch` modality (annex)

- **Date:** 2026-08-03 · reconciled 2026-08-03
- **Branch:** `dev/asaf/i29-ledger-completeness`
- **Status:** **annex** to [`2026-08-02-i29-d22-egress-completeness-design.md`](./2026-08-02-i29-d22-egress-completeness-design.md), the security spec of record. Reconciled per option R3.
- **Touches:** `packages/gateway/src/egress/`, `engine/router.ts`, `embedding/`, `llm/`, `audit/`, `updater/`, `telemetry/`, `identity/`, `extensions/`, `share/`, `sync/scheduler.ts`, `ipc/lan-client.ts`, `chatops/transport/`, `scripts/structure-audit/`, `packages/cli/src/commands/prove.ts`
- **Explicitly out of scope (parallel branch owns these):** `packages/gateway/src/connectors/**`, `index/item-store.ts`, `sync/rate-limiter.ts`, `string/**`, `ipc/index-rebody-rpc.ts`

> ## Reading order
>
> The spec of record owns the **architecture**: the `source_type` union, the sink requirement, the
> coverage vector, and the phase ordering. It also owns the modality this document does not cover —
> the MCP-mesh execute path.
>
> This annex owns the **`fetch` modality**: the verified call-site inventory, the classification
> rules, the append helper, and the per-site delivery detail. It supplies the content for the spec
> of record's Phases 3–5.
>
> Where the two disagreed, four conflicts resolved to the spec of record and one resolved here;
> all five are recorded in §12. **Sections 3.2, 3.3 and 3.6 were rewritten in that reconciliation** —
> the `net:`/`local:` prefix taxonomy and the scalar tier ladder they originally proposed are
> withdrawn.

---

## 1. Problem

I29 states that every gated action appends one `egress_ledger` row before `connectors.dispatch`, and D22 confines `connectors.dispatch` to a single call site. Both hold. Verified on `8d663237`:

```text
$ grep -rn "connectors\.dispatch" packages/gateway/src --include=*.ts | grep -v "\.test\.ts"
packages/gateway/src/engine/executor.ts:318:      const result = await this.connectors.dispatch(action);
```

The problem is not that the chokepoint leaks. It is that **the chokepoint is not the only way data leaves the machine**, while the user-facing claim built on top of it says otherwise.

`nimbus prove "<query>"` (`packages/cli/src/commands/prove.ts:147`) prints:

```text
outbound egress events during this query: 0 ✓
```

That same query ran through `engine/router.ts:129` — `POST https://api.anthropic.com/v1/messages` — carrying the user's prompt and whatever local context was retrieved for it. In a local-first product this is the single most privacy-relevant egress there is, and `prove` currently certifies it as zero.

### 1.1 Verified inventory

39 non-test files under `packages/gateway/src` match a `fetch(`-shaped pattern. They are **not** 39 egress sites:

| Class | Count | Files |
|---|---|---|
| False positives — inbound `Bun.serve({ fetch(req) })` handlers or unrelated method names | 4 | `auth/pkce.ts:161`, `ipc/http-server.ts:743`, `ipc/metrics-server.ts:18`, `ipc/policy-rpc.ts:85` (`ctx.refetch()`) |
| True outbound, non-connector | 11 | see §1.2 |
| Connector files (sync path) | 24 | `connectors/**` incl. `_lib/gitlab/{events,pipelines}.ts`, `_lib/imap-{client,sync-core}.ts` |

Two further egress sites use no `fetch` at all and would be missed by any `fetch`-only audit:

- `ipc/lan-client.ts:93,155` — `Bun.connect()` to a federated peer.
- `chatops/transport/bun-socket.ts:6` — `new WebSocket(url)` to Slack/Discord socket mode.

### 1.2 The 11 non-connector outbound sites

| File | Line(s) | What leaves |
|---|---|---|
| `engine/router.ts` | 129, 158 | user prompt + retrieved context → Anthropic / OpenAI |
| `embedding/openai-embedder.ts` | 23 | indexed content text → OpenAI |
| `llm/ollama-provider.ts` | 89, 99, 133, 162, 201 | prompt → Ollama (loopback by default; configurable host) |
| `llm/llamacpp-provider.ts` | 20, 45 | prompt → llama.cpp (loopback by default; configurable host) |
| `audit/audit-shipper.ts` | 99 | audit records → configured SIEM endpoint |
| `telemetry/flush-scheduler.ts` | 129 | telemetry batch → configured endpoint |
| `updater/manifest-fetcher.ts` | 138 | update check → release host |
| `updater/updater.ts` | 232 | binary download → release host |
| `identity/jwks-cache.ts` | `fetchKeys` | JWKS request → IdP |
| `extensions/registry-client.ts` | `attempt`/`fetchFn` | publisher-key lookup → registry |
| `share/safe-fetch.ts` | 102 | the share-forward transport itself |

### 1.3 The gap the original framing missed

Connector **sync** never touches the executor. `sync/scheduler.ts:665`, inside `runJob`:

```ts
result = await connector.sync(this.ctx, row.cursor);
```

D22 confines `connectors.dispatch`, but dispatch is only the *agent action* path. Every scheduled pull from GitHub, Slack, Jira, Gmail — with credentials attached, and by volume the dominant share of this product's outbound traffic — appends no ledger row.

### 1.4 What is not broken

The fail-closed guarantee is real and stays. `EgressSink.append` is synchronous (`append(entry: EgressEntry): void`, `egress-ledger.ts:87`), so the un-awaited call at `executor.ts:270` still throws through `gate()` before `execute()` reaches dispatch. No bug there.

The code is also already more honest than the docs: `egress-verify.ts:181` types the tier as a one-member union `"authorized-actions"` with a comment describing it as "honest about the ... boundary". The scoping concept exists; the CLI headline just doesn't surface it.

---

## 2. Decision

**Widen the code; tighten the docs only where widened code cannot reach.**

The promise `nimbus prove` makes is *"nothing left this machine"*. A documentation footnote cannot fix a CLI that prints `0 ✓` for a query that shipped the user's prompt to a third party. But some residual gaps are structural, and those get written down rather than papered over (§7).

Enforcement follows the repo's existing idiom rather than inventing one: **static confinement to a wrapper**, exactly as I14/D12 confines every SQLite write to `dbRun`/`dbExec`/`dbStmtRun`, plus a runtime backstop for what static analysis cannot see.

### 2.1 Decisions taken during design

| Question | Decision | Rationale |
|---|---|---|
| What does `prove` promise? | All network egress | Chosen over "authorized actions only"; the weaker claim does not match how the number is read. |
| Append failure on new classes | Degrade and continue | Chain marked degraded, `prove` reports `indeterminate`. Availability over hard abort. |
| Append failure on **gated actions** | Unchanged — hard abort | Existing I29 guarantee is not weakened by this work. |
| Loopback traffic | Recorded, excluded from the count | A fully-local Ollama query must still print a true `0 ✓`, with the local calls visible. |
| Schema change | None | `computeEgressRowHash` hashes a fixed column set; a new hashed column would break verify on every existing ledger. |
| Sync granularity | Per sync **run**, not per HTTP request | A Gmail sync is hundreds of requests; per-run is cheaper and needs no `connectors/**` edits. |

### 2.2 Non-goals

- Per-HTTP-request rows for connector sync.
- Raw-syscall or packet capture. The coverage vector exists precisely to avoid claiming this.
- A portable/attestable EAF artifact. Receipt signing stays as-is.
- Any change to `egress.prune`, the HITL frozen set, or receipt signing keys.
- Instrumenting in-process MiniLM embedding: it makes no network call, so it gets no row.

---

## 3. Design

### 3.1 New module — `packages/gateway/src/egress/egress-fetch.ts`

```ts
export interface EgressCallContext {
  /** A member of the FROZEN union (§3.3) — never a new value, never a prefixed one. */
  readonly sourceType: EgressSourceType;
  /** Stable logical verb, e.g. "llm.inference". Never the HTTP verb plus path. */
  readonly method: string;
  /** Metadata only — never request bodies (§3.5). */
  readonly summary?: unknown;
}

/** The sink is THREADED (§3.2.2) — passed explicitly, never looked up ambiently. */
export async function egressFetch(
  sink: EgressSink,
  input: string | URL,
  init: RequestInit | undefined,
  ctx: EgressCallContext,
): Promise<Response>;

/** For egress that returns no Response: Bun.connect, WebSocket. */
export function recordEgress(sink: EgressSink, target: string, ctx: EgressCallContext): void;

/**
 * Appended once per process by whoever owns the `Database` handle — describes the PROCESS (§3.6).
 * NOT threaded through `EgressSink`: it takes the `db` handle directly, because it runs before any
 * subsystem (and therefore any sink) is constructed. Shipped as `appendBootMarker(db, coverage,
 * now)` in `egress/egress-boot-marker.ts`, called once from `platform/assemble.ts` — the boot path
 * wraps it as `appendBootMarkerOrWarn(db, coverage, now, logger)`, which swallows an append failure
 * (non-fatal: a corrupted/locked ledger degrades proofs to `indeterminate` rather than blocking
 * startup) and logs a warning instead.
 */
export function appendBootMarker(db: Database, coverage: CoverageVector, now: number): void;
```

`egressFetch` is a drop-in for `fetch`: `init` passes through untouched and a plain `Response` is returned, so every call site keeps its existing `res.ok` / `.json()` / `.text()` handling. Verified against the real shapes at `router.ts:129` (POST + headers + body), `openai-embedder.ts:23` (same), `manifest-fetcher.ts:138` (`{ signal }`), `updater.ts:232` (`{ redirect: "follow" }`).

`recordEgress` exists because `Bun.connect` and `new WebSocket` have no `Response` to wrap, and because D22 forbids calling `appendEgressEntry` outside `egress/` — callers import this instead.

### 3.2 Sink registration — superseded by the spec of record

> **Withdrawn.** This section originally proposed leaving `egressSink?:` optional and adding a
> module-scoped `setEgressSink`. The spec of record's Phase 1 requires the sink instead, with a
> named `NULL_EGRESS_SINK` for gate-only construction sites, and that wins: a named null is a
> decision on the record, an omitted optional is an accident waiting. The reasoning below is
> retained only because the leaf-function problem it identifies is real and Phase 1 must solve it.

The obstacle is genuine. `llmClassify(provider, userText, model, apiKey)` in `router.ts` and the
embedder closure in `openai-embedder.ts` are leaf functions with **no `db` handle and no DI path to
a sink**. Requiring the sink at `ToolExecutor` construction does not by itself reach them, because
they are not constructed through the executor at all.

#### 3.2.2 DECIDED 2026-08-03: thread the sink, no ambient state

Each subsystem that performs egress takes an explicit `EgressSink` at **its own** construction
boundary — `makeOpenAiEmbedder(opts, sink)`, the router's factory, `SyncScheduler`, the telemetry
flush scheduler, the updater, `LanClient`, the ChatOps transport. No module-scoped registration, no
`AsyncLocalStorage`, no default.

Phase 1 already ships this shape for the task/connector modality — `RunAskParams.egressSink` and
`ChatopsBootDeps.egressSink` are both required (non-optional) fields, threaded from
`platform/assemble.ts` down to the `ToolExecutor` constructor, which itself takes `egressSink` as a
required parameter (no `?`). The `fetch`-modality subsystems above extend the identical pattern to
their own leaf functions; nothing in Phase 1's threading needs to change for Phases 3–5 to adopt it.

**Why this over the cheaper module-global:**

- It is the same argument Phase 1 makes for the required sink, applied one level down. A threaded
  parameter that must be supplied is a decision on the record; an ambient lookup that silently
  returns nothing is an accident waiting.
- **Most of the unwired-sink failure class becomes a compile error** rather than a runtime condition
  detectable only via the boot marker. That is a strictly better failure mode and it shrinks §4.3.
- Every egress site becomes greppable by its constructor signature, which the static rule in §5 can
  lean on.
- It sidesteps the Bun `mock.module` contamination hazard entirely, rather than mitigating it with
  a reset hook.

**Cost, accepted:** more edits, and each subsystem's construction site must be found and updated.
`platform/assemble.ts` is the single place that owns those constructions, so the change is wide but
shallow.

**What remains ambient:** nothing for the sink. `source_id` still comes from the existing
`getAgentRequestSessionId()` where a request context exists, and is `null` in timer-driven paths —
which is correct, since those runs genuinely have no session.

**The boot marker is not threaded** — it is appended once, at boot, by whichever code owns the
`Database` handle (`platform/assemble.ts`), because it describes the *process*, not a subsystem.

### 3.2.1 Original rationale (historical)

`llmClassify(provider, userText, model, apiKey)` in `router.ts` and the embedder closure in `openai-embedder.ts` are leaf functions with **no `db` handle and no DI path to a sink**. Threading an `EgressSink` to them would change roughly 11 leaf signatures across unrelated subsystems.

Instead, `platform/assemble.ts` calls `setEgressSink(makeEgressSink(db), tier)` once at boot. This is a service-locator trade-off, taken deliberately. Precedent: `executor.ts` already reads an ambient `getAgentRequestSessionId()` for exactly this reason, and the same ambient supplies `source_id` here.

Test hazard, mitigated: a module-global is a known contamination source in this repo's Bun test runs. `resetEgressSink()` is exported and called in `afterEach` for every suite that touches it; suites that do not register a sink exercise the unregistered path deliberately (§4.3).

### 3.3 Taxonomy — the frozen union, with local/remote derived from `destination`

> **Rewritten in reconciliation.** The `net:`/`local:` prefix scheme originally proposed here is
> **withdrawn**. The spec of record freezes a closed union up front and states the reason plainly:
> a `source_type` value written today is permanent IN THE DATA (`verifyEgressChain` recomputes each
> row's hash from that row's own stored column values, so widening the union invalidates no existing
> row — it is not a chain break), so the vocabulary must be chosen deliberately, and marker-exclusion
> (`isMarkerSourceType`) depends on the set being closed. Incremental widening is called out by name
> as a thing not to do. This annex adds no members.

**The spec of record is the single documentary owner of the union — this annex references it rather
than restating it.** The type, its members, and the freeze rationale live in one place in code:
`packages/gateway/src/egress/egress-source-type.ts` (`EGRESS_SOURCE_TYPES`), which the spec of
record's Phase 1 section documents. Restating the member list here would give the union two owners
that can drift; this annex instead maps the `fetch` modality onto the shipped union, unchanged and
with no additions:

| Call class (§6) | `source_type` |
|---|---|
| LLM inference + classification (`router.ts`), embeddings | `model` |
| Connector sync runs (scheduler seam) | `sync` |
| Federated peer sends (`lan-client.ts`) | `peer` |
| Telemetry, audit shipper, updater, JWKS, registry, share transport, ChatOps | `session` |
| Gated connector actions (existing) | `task` |
| Retention tombstone (existing) | `prune` |

#### 3.3.1 Local vs remote is derived from `destination`, not encoded in `source_type`

This is how the frozen union and the local-inference decision (§12, resolved *here* rather than to
the spec of record) coexist. `destination` is the request **host**, and `destination` **is an input
to `computeEgressRowHash`** — so classifying from it is exactly as tamper-evident as a prefix would
have been. A remote call cannot be relabelled local without breaking the chain.

```ts
const outbound = rows.filter(
  (r) =>
    r.resultStatus === "authorized" &&
    !MARKER_SOURCE_TYPES.has(r.sourceType) &&
    !isLoopbackDestination(r.destination),   // §3.4
).length;
```

Deriving at read time rather than freezing a label at write time is a deliberate advantage, and the
reason the local-inference conflict resolved the way it did: **a classifier bug stays correctable.**
If `isLoopbackDestination` is ever wrong, the rows still carry the true host, so a fixed classifier
re-derives the correct count from history. Under the spec of record's alternative — write no row for
local inference — a misclassified remote call leaves no evidence at all.

Marker rows are excluded explicitly rather than by `result_status`, because they legitimately carry
`authorized`:

```ts
/** Rows that record bookkeeping, not egress. Never counted. */
const MARKER_SOURCE_TYPES = new Set<EgressSourceType>(["prune", "boot", "degraded"]);
```

Existing `task` rows are counted exactly as they are today, so old ledgers keep reporting the same
numbers for real actions.

#### 3.3.2 Marker members — DECIDED 2026-08-03: admit them

The markers are admitted to the union as `boot` and `degraded`, rather than overloaded onto
`session` with reserved `method` values.

**Why.** This is exactly the case the spec of record argues for when it says to land the union
complete, "including members whose appenders do not exist yet" — the alternative costs nothing today
and is impossible tomorrow, because `source_type` is BLAKE3-committed. Overloading `session` would
also have made marker exclusion a `method`-string match rather than a type-level one, so a missed
exclusion would surface as a wrong count rather than a compile error.

The rejected option is recorded because it constrains a future reader: if a ninth member is ever
wanted, the answer is **not** to add it. It is to overload `session` with a reserved `method`, and
to accept the weaker exclusion that implies.

#### 3.3.3 This corrects a pre-existing miscount

`pruneEgress` writes `resultStatus: "authorized"` (`egress-prune.ts:97`), and today's filter is `rows.filter((r) => r.resultStatus === "authorized")` with no source-type exclusion. **A prune tombstone is therefore already counted as an outbound egress event**, inflating the number by one per prune — even though pruning is a local retention operation that sends nothing off-machine.

Excluding markers fixes this. It is a user-visible change to a number that was previously wrong, so it belongs in the changelog entry rather than passing silently. The boot and degraded markers would have inherited the same bug had the exclusion not been made explicit.

### 3.4 Classification rules

Resolved from the **URL host** (pre-DNS), reusing `share/safe-fetch.ts`'s exported `isPrivateAddress()` and `unbracketHost()` — tested IPv4, IPv6, and `::ffff:` mapped-v4 handling.

`safe-fetch` deliberately conflates loopback with private-LAN; this work must split them, because `127.0.0.1` did not leave the machine and `192.168.1.50` did:

The predicate is `isLoopbackDestination(destination)` (§3.3.1), applied at read time to the stored
host. It answers one question — *did this leave the machine?* — and nothing else:

- **loopback** → `true` — `127.0.0.0/8`, `::1`, `::`, and the bare hostname `localhost`.
- **private-LAN** (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`) → `false`. A peer on the LAN is off-machine.
- **link-local** (`169.254.0.0/16`, `fe80::/10`) → `false`. This is not a formality: `169.254.169.254` is the cloud instance-metadata endpoint, a credential-bearing destination that must never be classified as local.
- **everything else** → `false`.

Classifying pre-DNS is a deliberate simplification: it is deterministic and cheap, and `safe-fetch` already documents the DNS-rebinding TOCTOU limitation for resolution-time classification. Stated as a limitation in §7 rather than silently assumed.

#### 3.4.1 The classifier fails toward over-reporting, and that is the design

A local model reached by hostname rather than by IP — `http://workstation:11434`, `http://my-macbook.local:11434` — is counted as having left the machine even though it did not. `prove` then reports a non-zero count for a fully-local query.

This is the **safe** failure direction and is accepted deliberately. A ledger that over-reports egress produces a user complaint; a ledger that under-reports produces a false `0 ✓`, which is the entire defect this work exists to fix.

That asymmetry is why **`.local` must not be added to the loopback set.** mDNS `.local` names resolve to *other machines* on the LAN as readily as to this one; treating the suffix as loopback would classify genuine off-machine egress as local and manufacture exactly the false zero being eliminated. The same objection applies to any hostname-pattern heuristic.

The supported way to get a clean `0 ✓` from a local model is to point the provider at `127.0.0.1` or `localhost`, which will be documented in the `[llm]` configuration reference.

A structural alternative remains open: classify as local when the request target *is* the configured local-provider endpoint, rather than by inspecting the host string. The spec of record asks for exactly this shape — "a structural local/remote predicate, not ... convention". It is deferred rather than adopted because reading `[llm]` config inside the classifier couples the ledger to config resolution, and because the read-time derivation (§3.3.1) makes it a **correctable** decision rather than a permanent one: adopting it later re-derives every historical count correctly.

### 3.5 Row content

- **`destination` = `URL.host`** — `api.anthropic.com`, `127.0.0.1:11434`. Host and port only; never path or query. Extends V44's existing no-raw-URL rule to the new classes.
- **`method`** = a stable logical verb (`llm.inference`, `llm.classify`, `embedding.embed`, `sync.run`, `updater.manifest`), matching the action path's `method = action.type` convention. Never the HTTP verb plus path, which can carry ids.
- **`payload_summary`** = `redactEgressSummary({ model, bytes })` — **metadata only**. The ledger must not become a copy of every prompt sent off-machine. This is a stricter rule than the action path needs, and is load-bearing for privacy.
- **`hitl_status`** = `not_required` for all new classes (they are not gated). Satisfies the existing CHECK; no migration.
- **`result_status`** = `authorized`. Rows are appended *before* the call, so this means "authorized to send", never "delivered" — identical semantics to the action path.

### 3.6 Boot marker, carrying the coverage vector

> **Rewritten in reconciliation.** The scalar `CoverageTier` ladder originally proposed here is
> **withdrawn** in favour of the spec of record's per-source coverage vector, which is strictly more
> expressive: a scalar cannot say "connector actions are complete, sync is per-run, model calls are
> uncovered" — and that is exactly the state the ledger will be in between phases.

The boot marker survives the reconciliation unchanged in purpose, and gains a better payload.

**Purpose.** One marker row per process start. Without it, a build that never wires the sink
produces an empty ledger, and every window reads as a clean `0` — a false zero indistinguishable
from real silence. This is the annex's main structural contribution and §4.3 depends on it.

**Payload.** The marker records the writing binary's coverage vector — which source classes it was
built to observe, and at what granularity:

```ts
type Granularity = "none" | "per-run" | "per-call";
// The egress-BEARING source types only — marker classes (`prune`/`boot`/`degraded`) carry no
// coverage claim, so `CoverageClass` is five members, not all eight of `EgressSourceType`.
type CoverageClass = "model" | "peer" | "session" | "sync" | "task";
type CoverageVector = Readonly<Record<CoverageClass, Granularity>>;
```

Shipped as `egress/egress-coverage.ts` (`COVERAGE_CLASSES`, `CoverageVector`). So a Phase-3 binary
writes `{ task: "per-call", sync: "per-run", model: "none", … }`, and a Phase-4 binary writes the
same with `model: "per-call"`.

**Resolution over a window.** `proveWindow` finds the boot markers spanning the window and reports
the **weakest granularity per source class** across them. A ledger written partly by today's
action-scoped binary therefore reports `model: "none"` for that window — it cannot claim coverage a
past binary never had. A window with no covering marker is `indeterminate` (§4.3).

The coverage vector is the SEMANTIC replacement for `EgressCompleteness.tier` — its current value
`"authorized-actions"` becomes the vector `{ task: "per-call", …rest: "none" }`, and the vector, not
`tier`, is what the gateway and CLI actually read for any decision. `tier` itself is not removed: it
is retained, additively, as deprecated compatibility data for `@nimbus-dev/client@0.15.0`, whose
`validateEgressCompleteness` hard-throws without a `tier === "authorized-actions"` field (it predates
the `coverage`/`indeterminate` shape). It stays true only while coverage remains task-only, and MUST
be removed — not merely left deprecated — the moment a later phase raises another coverage class
above `"none"`, at which point `"authorized-actions"` would misstate what the binary observes.

---

## 4. Failure semantics

### 4.1 Gated actions — unchanged

Append throws → `gate()` throws → `execute()` propagates → dispatch never runs. Untouched by this work.

### 4.2 New classes — degrade and continue

1. Append throws → catch, increment an in-memory lost-append counter, **proceed with the call**.
2. On the next *successful* append, emit a degraded marker first, recording how many appends were lost.
3. `proveWindow` reports `indeterminate` for any window touching a degraded marker or a chain break — reusing the existing "indeterminate, never a false zero" rule.

**Known limitation, stated rather than hidden:** if the process dies between a failed append and the next successful one, that degradation signal is lost and the window reads clean. Only hard fail-closed eliminates this; availability was chosen over it deliberately (§2.1).

The sharpest form of this: **if the database is read-only or lock-held, step 2 can never run**, because writing the degraded marker is itself an append. Recovery-on-next-append handles a transient failure (a malformed head, a constraint error) and does nothing for a sustained one.

Soundness survives this, via the boot marker rather than via the recovery marker. A restart with an unwritable database cannot append a boot marker either, so the window has no covering marker and `proveWindow` reports `indeterminate` — not a clean zero. What is lost is *forensic detail*: how many appends were dropped, and when. A sentinel file outside SQLite would recover that detail; it is deferred as an enhancement (§11), not required for the completeness claim.

### 4.3 Missing sink — now mostly a compile error

The threading decision (§3.2.2) largely dissolves this section. `egressFetch` and `recordEgress`
take the sink as a required parameter, and each subsystem takes one at construction, so **a call
site that forgets the sink does not compile.** There is no ambient lookup that can silently return
nothing.

Two runtime residues remain, and the boot marker covers both:

1. **A subsystem constructed with `NULL_EGRESS_SINK`** where a real sink was intended. Type-correct,
   so the compiler is satisfied — but the named null makes it greppable and reviewable, which is
   exactly why the spec of record prefers a named null to an omitted optional.
2. **A boot path that never appends the marker at all** — the process ran, but nothing recorded what
   it was built to observe.

In both cases the window has no covering boot marker, so `proveWindow` reports `indeterminate`: an
unwired sink surfaces as "cannot prove" rather than as a silent `0 ✓`. That is the boot marker's
primary justification, and an enforcement test asserts a marker-less window yields `indeterminate`
and never zero.

### 4.4 Unparseable host

`new URL(input)` throwing must not drop the row. Recorded with `destination = "unknown"`, its own `source_type` unchanged, and **counted** — `isLoopbackDestination("unknown")` is `false`, so an unparseable host is treated as having left the machine. When classification fails, the safe direction is to record and to count.

---

## 5. Static enforcement — new `D22-egress-fetch` rule

Added to `checkEgressChokepointConfinement` in `scripts/structure-audit/check-nimbus-invariants.ts`, which already does line-regex matching over comment-stripped source with a path allowlist — the new rule slots into that structure.

**Flags:** bare `fetch(`, `Bun.connect(`, `new WebSocket(` in `packages/gateway/src`, non-test, outside `egress/` — **plus the Node compatibility primitives**, which Bun supports and which would otherwise sail past a Bun-API-only rule:

| Primitive | Why it must be covered |
|---|---|
| `node:https` / `node:http` — `.request(`, `.get(` | a complete HTTP client that never types `fetch` |
| `node:net` — `.connect(`, `.createConnection(` | raw TCP; the `Bun.connect` equivalent |
| `node:tls` — `.connect(` | raw TLS |

These are not hypothetical: `node:net` is already imported in `ipc/server/socket-listeners.ts` (inbound, needs `// egress-ok:`) and `node:http`/`node:https` in `testing/bun-test-support.ts` (test-only, already exempt). The rule flags the **import** as well as the call, since `import net from "node:net"` followed by an aliased call is otherwise invisible to line-regex matching.

**Escapes — and the reconciliation of the allowlist objection.**

The spec of record says, flatly: *"Do not add an allowlist entry so the audit passes. That satisfies
the checker while dissolving the property."* This annex originally proposed a `connectors/**`
directory allowlist. That objection is right about escape hatches and the proposal is narrowed
accordingly:

1. **`// egress-ok: <reason>` per line**, following the existing `// cross-platform-ok` idiom. Used
   only for the three **inbound** `Bun.serve` handlers (`auth/pkce.ts`, `ipc/http-server.ts`,
   `ipc/metrics-server.ts`) and the inbound `node:net` import in `ipc/server/socket-listeners.ts`.
   These are not egress at all — a false positive of the regex, not a carve-out from the property.
2. **`connectors/**` is a scope boundary, not an allowlist entry.** The distinction is load-bearing
   and the annex asserts it explicitly: an allowlist entry says *"this file may reach the network
   unrecorded"*; a scope boundary says *"this file's egress is recorded by a different declared
   mechanism, at a granularity the coverage vector states."* Connector-sync egress **is** ledgered —
   one `sync` row per run at the scheduler seam — and `sync: "per-run"` in the vector says so in
   the report, where a user can see it.

The honest weakness, stated rather than buried: per-run granularity means a connector that quietly
called a *fourth-party* host during a sync would be indistinguishable from one that did not. Closing
that requires per-request instrumentation inside `connectors/**` (out of scope here — the parallel
branch owns those files) or the mesh-side work in the spec of record's Phase 2. Until then the
vector must not claim `sync: "per-call"`.

**The regex must not fire on** `fetch(req) {` method definitions, `refetch(`, `fetchFn`, or `safeFetch(`. This is precisely the guard-authoring failure mode this repo has hit before, so the rule ships with a fixture that red-proves **both** directions: it fires on a real bare call, and stays silent on each of those four shapes.

---

## 6. Call-site inventory

14 files, none in the forbidden set. `source_type` values are the frozen union (§3.3); `method` is
the per-site logical verb, which is where the finer distinction lives.

| File | `source_type` | `method` | Mechanism | Phase |
|---|---|---|---|---|
| `engine/router.ts` (×2) | `model` | `llm.classify` | `egressFetch` | 4 |
| `embedding/openai-embedder.ts` | `model` | `embedding.embed` | `egressFetch` | 4 |
| `llm/ollama-provider.ts` (×5) | `model` | `llm.inference` | `egressFetch` | 4 |
| `llm/llamacpp-provider.ts` (×2) | `model` | `llm.inference` | `egressFetch` | 4 |
| `sync/scheduler.ts` (`runJob`) | `sync` | `sync.run` | `recordEgress`, one row per run | 3 |
| `ipc/lan-client.ts` (×2) | `peer` | `federation.send` | `recordEgress` | 4 |
| `audit/audit-shipper.ts` | `session` | `audit.ship` | `egressFetch` | 5 |
| `telemetry/flush-scheduler.ts` | `session` | `telemetry.flush` | `egressFetch` | 5 |
| `updater/manifest-fetcher.ts` | `session` | `updater.manifest` | `egressFetch` | 5 |
| `updater/updater.ts` | `session` | `updater.download` | `egressFetch` | 5 |
| `identity/jwks-cache.ts` | `session` | `identity.jwks` | `egressFetch` | 5 |
| `extensions/registry-client.ts` | `session` | `registry.publisherKey` | `egressFetch` | 5 |
| `share/safe-fetch.ts` | `session` | `share.forward` | `egressFetch` | 5 |
| `chatops/transport/bun-socket.ts` | `session` | `chatops.socket` | `recordEgress` | 5 |

The local-vs-remote split for the `model` rows is **not** in this table by design — it is derived
from `destination` at read time (§3.3.1), so an Ollama call on `127.0.0.1` and an Anthropic call are
the same `source_type` with different hosts.

`sync/scheduler.ts` is the seam that covers all 24 connector files **without editing any of them** — which the parallel-branch constraint requires and which is also the better design at this granularity.

The Phase column maps each site onto the spec of record's phases. Note that its Phase 5 is
*"document the permanently excluded set by name"* — the `session` rows above are precisely that set,
and this annex's position is that they should be **recorded** rather than merely documented as
excluded, since recording them costs one row per event and removes the need to defend the exclusion
at all. That is a proposal to Phase 5, not a decision taken here.

---

## 7. What this still does not cover

Written down because the tier vocabulary must stay honest:

1. **Connector subprocess traffic is per-run, not per-request.** A sync run is one row regardless of how many HTTP calls it made. `mcp-connectors/*` are separate processes; neither a gateway-side static audit nor a gateway-side global patch can see inside them.
2. **Third-party libraries inside the gateway process** are uncovered until the `globalThis.fetch` backstop lands (unscheduled, §9). No coverage-vector entry may claim otherwise.

   **The backstop’s boundary, stated precisely:** patching `globalThis.fetch` intercepts `fetch` and nothing else. A dependency using `node:https.request` or opening a raw socket is invisible to it. Closing *that* would require intercepting socket creation itself, which is out of scope here. Consequently even a fully-delivered backstop means "all egress via `fetch`, plus all first-party egress via any primitive" — the coverage vector and its documentation must say so rather than implying packet-level completeness.
3. **DNS rebinding** — classification uses the pre-resolution URL host (§3.4).
4. **Lost degradation signal on abrupt process death** (§4.2).
5. **Not syscall capture.** A determined local process can still open a socket; this ledger records what *Nimbus* sends.

---

## 8. Testing

| Layer | Coverage |
|---|---|
| Unit — `isLoopbackDestination` | IPv6, `::ffff:` mapped v4, bracketed hosts, bare `localhost`, LAN-vs-loopback split |
| Unit — classification (negative) | `169.254.169.254` → not loopback; `anything.local` → not loopback (§3.4.1); `"unknown"` → not loopback, so it counts |
| Unit — union identity | `EgressSourceType` members asserted with `toEqual` against the literal list, never a length check — widening the union must be a visible diff (spec of record, Phase 1) |
| Static — Node primitives | `D22-egress-fetch` red-proved against `https.request(`, `net.connect(`, `tls.connect(` and a `node:net` import (§5) |
| Unit — ordering | fake `fetch` asserts the row already exists when the call fires (append-before-egress) |
| Unit — degrade | append throws → call still completes → counter set → degraded marker on next successful append |
| Unit — coverage vector | weakest-granularity-per-source resolution across multiple boot markers; window with no covering marker → `indeterminate` |
| Unit — markers | marker rows excluded from the count despite carrying `authorized` (§3.3.3) |
| Unit — unwired sink | a window with no covering boot marker yields `indeterminate`, never `0` (§4.3) |
| Regression | rows written by the current binary still verify (hash inputs unchanged) |
| Invariant | `I29` describe block extended: loopback exclusion, marker exclusion, gated-action abort still fires |
| Static | `D22-egress-fetch` red-proved in both directions (§5) |
| E2E | `nimbus prove` with `prefer_local` Ollama → `0 ✓` with loopback listed; with a cloud model → non-zero |

Coverage floor ≥80% line+branch per new file under `egress/`, verified Docker-Linux-authoritative.

---

## 9. Delivery

> **Renumbered in reconciliation.** The standalone PR 1/2/3 ladder is withdrawn; this annex's work
> is sequenced by the spec of record's phases, which put **truth before coverage** — Phase 1 makes
> the claim honest before any new coverage lands, and this annex's content is all coverage.

| Phase (spec of record) | This annex supplies | Coverage vector after |
|---|---|---|
| 1 — make the claim true | *nothing new*, but two inputs it must absorb: the frozen union must include the boot/degraded members (§3.3.2), and the local-inference decision (§12) fixes what `model` rows mean | `{ task: per-call, …rest: none }` |
| 2 — remove the execute capability | *nothing* — the MCP-mesh modality is the spec of record's | unchanged |
| 3 — the sync chokepoint | `recordEgress` at `sync/scheduler.ts` `runJob`; the sink-threading decision (§3.2) | `sync: per-run` |
| 4 — model and peer tiers | `egressFetch` + `isLoopbackDestination`; the `model` and `peer` call sites (§6) | `model: per-call, peer: per-call` |
| 5 — the excluded set | the `session` call sites (§6), with the proposal to record rather than exclude them | `session: per-call` |
| — (unscheduled) | `globalThis.fetch` backstop; boundary in §7.2 | catches non-first-party `fetch` |

Each phase carries wiring + docs + test in one commit, per the repo's triple rule. The
`D22-egress-fetch` static rule lands with Phase 4, once the call sites it would flag have moved —
landing it earlier would only be green because of exemptions, which is what §5 argues against.

**Docs to update when the invariant statement changes:** `docs/SECURITY-INVARIANTS.md` (I29 statement + wired-at + anti-patterns), `CLAUDE.md` + `GEMINI.md` (I29 bullet, both files), `.claude/commands/nimbus-egress.md`, `docs/architecture.md`, `docs/cli-reference.md`, `docs/CHANGELOG.md`.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| Module-global sink contaminates Bun test runs | **Eliminated** by the threading decision (§3.2.2) — there is no module-global to contaminate |
| D22 regex false-positives on `fetch(req) {` / `refetch(` / `fetchFn` | fixture red-proves both directions before the rule is enforced (§5) |
| Ledger volume from loopback LLM rows | rows are small and metadata-only; `egress.prune` already exists for retention |
| `prove` output churn breaks existing e2e assertions | CLI wording changes land with the phase that changes coverage, alongside its test updates |
| Partial coverage misread as complete | the coverage vector is printed next to every count, never a bare number |

---

## 11. Review disposition

Against the design review of this annex. That review's findings were folded in below and the
review document itself was removed once each disposition landed — the dispositions are the
permanent record.

| # | Finding | Disposition |
|---|---|---|
| 1 | Pre-DNS classification misses hostname-addressed local models; classify link-local | **Partly fixed, partly rejected.** Link-local added explicitly to the classifier — resolved `false` (not loopback), never the withdrawn `net:` prefix (§3.4) — a good catch, `169.254.169.254` is credential-bearing. The `.local`/hostname exception is **rejected**: see §3.4.1. |
| 2 | Node primitives (`node:net`/`tls`/`http`/`https`) bypass the static rule; state the backstop's boundary | **Fixed in full** (§5, §7.2). Correct and cheap; the rule now flags imports as well as calls. |
| 3 | Replace the module-global sink with `AsyncLocalStorage` | **Concern accepted, mechanism rejected. Deferred** — see below. |
| 4 | A read-only/locked DB means the degraded marker can never be written; add a sentinel file | **Partly fixed, remainder deferred.** §4.2 now states the sustained-failure case and why soundness survives it. The sentinel file is deferred. |

### 11.1 Why `AsyncLocalStorage` is the wrong mechanism here

`AsyncLocalStorage` is idiomatic in this codebase — `engine/agent-request-context.ts` and `chatops/chatops-request-context.ts` both use it, and §3.2 cites the former as precedent. So the suggestion is reasonable on its face.

It does not work for this problem. ALS only carries a value into code running inside a `.run()` callback, and the egress classes that matter most are **timer-driven, outside any request context**: `telemetry/flush-scheduler.ts:159` and `sync/scheduler.ts:191` are both `setInterval`. A timer callback's `getStore()` returns `undefined`, so every unattended egress path — sync, telemetry, updater, OAuth refresh — falls back to the module global anyway. ALS would add ceremony while leaving the dominant classes exactly as they are.

The underlying concern is nonetheless real, and there is a better answer already on the table: the 2026-08-02 spec of record calls for making the sink **required** at construction with a named `NULL_EGRESS_SINK` for gate-only sites. That removes the ambient read for every path reachable by DI, rather than relocating it. Deferred into that reconciliation (§12) rather than solved twice.

### 11.2 Deferred

| Item | Why deferred |
|---|---|
| Structural local-provider predicate (classify by configured endpoint, not host string) | Unblocked by §12.2 but still deferred: read-time derivation makes adopting it later non-breaking (§3.4.1) |
| Sentinel file for degradation across restarts | Forensic detail only; soundness already held by the boot marker (§4.2) |
| Socket-level interception beyond `globalThis.fetch` | Out of scope; boundary now documented (§7.2) |
| Required sink / `NULL_EGRESS_SINK` | Adopted from the spec of record's Phase 1 (§3.2, §12.1) |

---

## 12. Reconciliation with the spec of record — RESOLVED (2026-08-03)

[`2026-08-02-i29-d22-egress-completeness-design.md`](./2026-08-02-i29-d22-egress-completeness-design.md) is the security spec of record for this invariant, written from a six-agent audit. It was not consulted while this document was first drafted — an omission, since it covers the same question across a wider set of modalities. Reconciled per option **R3**: it owns the architecture and the execute modality; this annex owns the `fetch` modality.

### 12.1 The five conflicts

| # | Question | Resolution | Where |
|---|---|---|---|
| 1 | `source_type` | **To the spec of record.** Closed union frozen up front; this annex adds no members and maps onto `task`/`prune`/`session`/`sync`/`model`/`peer`. | §3.3 rewritten |
| 2 | Sink | **To the spec of record.** Required, with `NULL_EGRESS_SINK`. The leaf-function seam it does not reach is escalated as an open Phase-3 decision rather than silently defaulted to a global. | §3.2 rewritten |
| 3 | Tier | **To the spec of record.** Per-source coverage vector; the scalar ladder is withdrawn. The boot marker survives and now carries the vector. | §3.6 rewritten |
| 4 | D22 allowlist | **To the spec of record in principle**, with one asserted distinction: `connectors/**` is a declared scope boundary backed by the scheduler-seam row and the `sync: "per-run"` vector entry, not an entry added to make the audit pass. The weakness of per-run granularity is stated. | §5 rewritten |
| 5 | Local inference | **To this annex.** Rows are written and excluded from the count by a `destination`-derived predicate, rather than not written at all. | §3.3.1 |

### 12.2 Why conflict 5 resolved against the spec of record

Its position — *"local inference must produce no rows … or the ledger becomes noise"* — treats the cost as noise. That is answerable with retention (`egress.prune` exists) and is a matter of degree.

The cost on the other side is not a matter of degree. If local inference writes no rows, the local/remote predicate decides **whether evidence exists at all**, so a predicate that wrongly judges a remote host local destroys the record of a real egress, silently and permanently. With rows written and the split derived at read time from the hashed `destination`, the identical bug only mis-*counts*: the row still names `api.anthropic.com`, the chain still proves it was not edited, and a corrected predicate re-derives the true count from history.

Same failure, one recoverable and one not. The spec of record's own governing principle is *"indeterminate, never a false zero"*, and writing no rows is the option that can produce a false zero.

Its accompanying requirement — that the predicate be **structural, not convention** — is accepted and remains open (§3.4.1); read-time derivation makes adopting it later a non-breaking change.

### 12.3 What this annex contributes

The verified `fetch`-modality inventory (§1.1–1.2), the pre-existing prune miscount (§3.3.3), the boot marker that turns an unwired sink into `indeterminate` rather than a false zero (§3.6, §4.3), the classification rules and their deliberate over-reporting bias (§3.4.1), the Node-primitive coverage of the static rule (§5), and the review dispositions (§11).

### 12.4 The two carried-forward decisions — BOTH SETTLED 2026-08-03

| Decision | Outcome | Consequence |
|---|---|---|
| Boot/degraded marker members (§3.3.2) | **Admit them.** The frozen union is eight members: `task`, `prune`, `session`, `sync`, `model`, `peer`, `boot`, `degraded`. | Marker exclusion is type-level, not a `method`-string match. Phase 1 must land all eight; a ninth is not a chain break (row hashes are recomputed from stored values), but it is a permanent, deliberate addition to a closed, data-permanent vocabulary. |
| How the sink reaches leaf functions (§3.2.2) | **Thread it.** Explicit `EgressSink` parameter at each subsystem's construction boundary; no module-global, no `AsyncLocalStorage`. | Most missing-sink bugs become compile errors (§4.3 shrinks accordingly). `platform/assemble.ts` carries the wiring; `egressFetch`/`recordEgress` take the sink as their first argument. |

Nothing in this annex is now blocked. Phase 1 can be planned against the eight-member union, and
Phases 3–5 against the threaded-sink call sites in §6.
