# I29 ledger completeness — widening egress coverage beyond the executor chokepoint

- **Date:** 2026-08-03
- **Branch:** `dev/asaf/i29-ledger-completeness`
- **Status:** design approved, plan pending
- **Touches:** `packages/gateway/src/egress/`, `engine/router.ts`, `embedding/`, `llm/`, `audit/`, `updater/`, `telemetry/`, `identity/`, `extensions/`, `share/`, `sync/scheduler.ts`, `ipc/lan-client.ts`, `chatops/transport/`, `scripts/structure-audit/`, `packages/cli/src/commands/prove.ts`
- **Explicitly out of scope (parallel branch owns these):** `packages/gateway/src/connectors/**`, `index/item-store.ts`, `sync/rate-limiter.ts`, `string/**`, `ipc/index-rebody-rpc.ts`

---

## 1. Problem

I29 states that every gated action appends one `egress_ledger` row before `connectors.dispatch`, and D22 confines `connectors.dispatch` to a single call site. Both hold. Verified on `8d663237`:

```
$ grep -rn "connectors\.dispatch" packages/gateway/src --include=*.ts | grep -v "\.test\.ts"
packages/gateway/src/engine/executor.ts:318:      const result = await this.connectors.dispatch(action);
```

The problem is not that the chokepoint leaks. It is that **the chokepoint is not the only way data leaves the machine**, while the user-facing claim built on top of it says otherwise.

`nimbus prove "<query>"` (`packages/cli/src/commands/prove.ts:147`) prints:

```
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
- Raw-syscall or packet capture. The tier vocabulary exists precisely to avoid claiming this.
- A portable/attestable EAF artifact. Receipt signing stays as-is.
- Any change to `egress.prune`, the HITL frozen set, or receipt signing keys.
- Instrumenting in-process MiniLM embedding: it makes no network call, so it gets no row.

---

## 3. Design

### 3.1 New module — `packages/gateway/src/egress/egress-fetch.ts`

```ts
export interface EgressCallContext {
  readonly sourceType: string;       // taxonomy base, e.g. "llm" — prefix applied by classifier
  readonly method: string;           // stable logical verb, e.g. "llm.inference"
  readonly summary?: unknown;        // metadata only — never request bodies
}

export async function egressFetch(
  input: string | URL,
  init: RequestInit | undefined,
  ctx: EgressCallContext,
): Promise<Response>;

/** For egress that returns no Response: Bun.connect, WebSocket. */
export function recordEgress(target: string, ctx: EgressCallContext): void;

/** Boot wiring. Appends the boot marker. */
export function setEgressSink(sink: EgressSink, tier: CoverageTier): void;

/** Test seam. */
export function resetEgressSink(): void;
```

`egressFetch` is a drop-in for `fetch`: `init` passes through untouched and a plain `Response` is returned, so every call site keeps its existing `res.ok` / `.json()` / `.text()` handling. Verified against the real shapes at `router.ts:129` (POST + headers + body), `openai-embedder.ts:23` (same), `manifest-fetcher.ts:138` (`{ signal }`), `updater.ts:232` (`{ redirect: "follow" }`).

`recordEgress` exists because `Bun.connect` and `new WebSocket` have no `Response` to wrap, and because D22 forbids calling `appendEgressEntry` outside `egress/` — callers import this instead.

### 3.2 Sink registration is module-scoped, not threaded

`llmClassify(provider, userText, model, apiKey)` in `router.ts` and the embedder closure in `openai-embedder.ts` are leaf functions with **no `db` handle and no DI path to a sink**. Threading an `EgressSink` to them would change roughly 11 leaf signatures across unrelated subsystems.

Instead, `platform/assemble.ts` calls `setEgressSink(makeEgressSink(db), tier)` once at boot. This is a service-locator trade-off, taken deliberately. Precedent: `executor.ts` already reads an ambient `getAgentRequestSessionId()` for exactly this reason, and the same ambient supplies `source_id` here.

Test hazard, mitigated: a module-global is a known contamination source in this repo's Bun test runs. `resetEgressSink()` is exported and called in `afterEach` for every suite that touches it; suites that do not register a sink exercise the unregistered path deliberately (§4.3).

### 3.3 Taxonomy — classification lives in the hashed `source_type`

`source_type` has **no CHECK constraint** (V44; `prune` already exploits this) and **is** an input to `computeEgressRowHash`. Putting the classification there makes it tamper-evident: a remote call cannot be silently reclassified as local without breaking the chain.

| `source_type` | Meaning | Counted in headline |
|---|---|---|
| `task` | gated connector action (**existing, unchanged**) | yes |
| `prune` | retention tombstone (**existing, unchanged**) | no — **behaviour change, see §3.3.1** |
| `boot` | process-start marker, `method` carries the tier | no |
| `net:llm`, `net:embedding`, `net:sync`, `net:telemetry`, `net:updater`, `net:identity`, `net:registry`, `net:share`, `net:federation`, `net:chatops`, `net:audit` | left the machine | yes |
| `net:unknown` | host unparseable — recorded rather than dropped | yes |
| `net:unattributed` | caught by the PR-3 runtime backstop | yes |
| `net:degraded` | recovery marker; carries the count of lost appends | no |
| `local:*` | loopback — did not leave the machine | **no** |

The headline count becomes:

```ts
/** Rows that record bookkeeping, not egress. Never counted. */
const MARKER_SOURCE_TYPES = new Set(["prune", "boot", "net:degraded"]);

rows.filter(
  (r) =>
    r.resultStatus === "authorized" &&
    !r.sourceType.startsWith("local:") &&
    !MARKER_SOURCE_TYPES.has(r.sourceType),
).length;
```

Marker exclusion is explicit rather than implied by `result_status`, because markers legitimately carry `authorized` and would otherwise be counted as egress.

Existing `task` rows are counted exactly as they are today, so old ledgers keep reporting the same numbers for real actions.

#### 3.3.1 This corrects a pre-existing miscount

`pruneEgress` writes `resultStatus: "authorized"` (`egress-prune.ts:97`), and today's filter is `rows.filter((r) => r.resultStatus === "authorized")` with no source-type exclusion. **A prune tombstone is therefore already counted as an outbound egress event**, inflating the number by one per prune — even though pruning is a local retention operation that sends nothing off-machine.

Excluding markers fixes this. It is a user-visible change to a number that was previously wrong, so it belongs in the PR-2 changelog entry rather than passing silently. The `boot` and `net:degraded` markers introduced here would have inherited the same bug had the exclusion not been made explicit.

### 3.4 Classification rules

Resolved from the **URL host** (pre-DNS), reusing `share/safe-fetch.ts`'s exported `isPrivateAddress()` and `unbracketHost()` — tested IPv4, IPv6, and `::ffff:` mapped-v4 handling.

`safe-fetch` deliberately conflates loopback with private-LAN; this work must split them, because `127.0.0.1` did not leave the machine and `192.168.1.50` did:

- **loopback** → `local:` — `127.0.0.0/8`, `::1`, `::`, and the bare hostname `localhost`.
- **private-LAN** (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`, `fe80::/10`) → `net:` — a peer on the LAN is off-machine.
- **link-local** (`169.254.0.0/16`, `fe80::/10`) → `net:`. This is not a formality: `169.254.169.254` is the cloud instance-metadata endpoint, a credential-bearing destination that must never be classified as local.
- **everything else** → `net:`.

Classifying pre-DNS is a deliberate simplification: it is deterministic and cheap, and `safe-fetch` already documents the DNS-rebinding TOCTOU limitation for resolution-time classification. Stated as a limitation in §7 rather than silently assumed.

#### 3.4.1 The classifier fails toward over-reporting, and that is the design

A local model reached by hostname rather than by IP — `http://workstation:11434`, `http://my-macbook.local:11434` — classifies as `net:llm` even though nothing left the machine. `prove` then reports a non-zero count for a fully-local query.

This is the **safe** failure direction and is accepted deliberately. A ledger that over-reports egress produces a user complaint; a ledger that under-reports produces a false `0 ✓`, which is the entire defect this work exists to fix.

That asymmetry is why **`.local` must not be added to the loopback set.** mDNS `.local` names resolve to *other machines* on the LAN as readily as to this one; treating the suffix as loopback would classify genuine off-machine egress as local and manufacture exactly the false zero being eliminated. The same objection applies to any hostname-pattern heuristic.

The supported way to get a clean `0 ✓` from a local model is to point the provider at `127.0.0.1` or `localhost`, which will be documented in the `[llm]` configuration reference. A structural alternative — classify as `local:` when the request target *is* the configured local-provider endpoint, rather than by inspecting the host string — is deferred (§11), because it interacts with an unresolved conflict about whether local inference should emit rows at all.

### 3.5 Row content

- **`destination` = `URL.host`** — `api.anthropic.com`, `127.0.0.1:11434`. Host and port only; never path or query. Extends V44's existing no-raw-URL rule to the new classes.
- **`method`** = a stable logical verb (`llm.inference`, `llm.classify`, `embedding.embed`, `sync.run`, `updater.manifest`), matching the action path's `method = action.type` convention. Never the HTTP verb plus path, which can carry ids.
- **`payload_summary`** = `redactEgressSummary({ model, bytes })` — **metadata only**. The ledger must not become a copy of every prompt sent off-machine. This is a stricter rule than the action path needs, and is load-bearing for privacy.
- **`hitl_status`** = `not_required` for all new classes (they are not gated). Satisfies the existing CHECK; no migration.
- **`result_status`** = `authorized`. Rows are appended *before* the call, so this means "authorized to send", never "delivered" — identical semantics to the action path.

### 3.6 Boot marker and the tier ladder

`setEgressSink` appends one `source_type='boot'` row per process start whose `method` carries that binary's coverage tier.

This closes the design's most dangerous failure mode. Without it, a build where `setEgressSink` is never called produces an empty ledger, and every window reads as a clean `0` — a false zero indistinguishable from real silence.

```ts
export type CoverageTier = "authorized-actions" | "first-party-egress" | "all-egress";
```

`proveWindow` finds the boot markers spanning the window and reports the **weakest** one. A ledger written partly by today's action-scoped binary therefore reports `authorized-actions`, not a false `all-egress`. `EgressCompleteness.tier` widens from its current one-member union to this type.

---

## 4. Failure semantics

### 4.1 Gated actions — unchanged

Append throws → `gate()` throws → `execute()` propagates → dispatch never runs. Untouched by this work.

### 4.2 New classes — degrade and continue

1. Append throws → catch, increment an in-memory lost-append counter, **proceed with the call**.
2. On the next *successful* append, emit a `net:degraded` marker first, recording how many appends were lost.
3. `proveWindow` reports `indeterminate` for any window touching a `net:degraded` marker or a chain break — reusing the existing "indeterminate, never a false zero" rule.

**Known limitation, stated rather than hidden:** if the process dies between a failed append and the next successful one, that degradation signal is lost and the window reads clean. Only hard fail-closed eliminates this; availability was chosen over it deliberately (§2.1).

The sharpest form of this: **if the database is read-only or lock-held, step 2 can never run**, because writing the `net:degraded` marker is itself an append. Recovery-on-next-append handles a transient failure (a malformed head, a constraint error) and does nothing for a sustained one.

Soundness survives this, via the boot marker rather than via the recovery marker. A restart with an unwritable database cannot append a boot marker either, so the window has no covering marker and `proveWindow` reports `indeterminate` — not a clean zero. What is lost is *forensic detail*: how many appends were dropped, and when. A sentinel file outside SQLite would recover that detail; it is deferred as an enhancement (§11), not required for the completeness claim.

### 4.3 Unregistered sink

Calling `egressFetch` with no sink registered is a programming error, not a runtime condition — but the two builds must behave differently, and the spec is explicit about which:

- **Test and development builds throw.** A missing `setEgressSink` is a wiring bug and should fail loudly where it is cheap to fix.
- **Production proceeds with the call and records nothing**, consistent with degrade-and-continue (§4.2): an instrumentation defect must not take the product down.

Production safety therefore rests entirely on the boot marker. With no marker covering the window, `proveWindow` reports `indeterminate`, so an unwired sink surfaces as "cannot prove" rather than as a silent `0 ✓`. This is the single most important reason the boot marker exists, and an enforcement test asserts that a sink-less boot yields `indeterminate` and never zero.

### 4.4 Unparseable host

`new URL(input)` throwing must not drop the row. Recorded as `net:unknown` with `destination = "unknown"` and counted. When classification fails, the safe direction is to record.

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

**Two escapes:**

1. A per-line `// egress-ok: <reason>` comment, following the existing `// cross-platform-ok` idiom. Used for the three inbound `Bun.serve` handlers (`auth/pkce.ts`, `ipc/http-server.ts`, `ipc/metrics-server.ts`).
2. A directory allowlist for `connectors/**`, documented in-code as *ledgered at the sync-scheduler seam, per-run*.

**The regex must not fire on** `fetch(req) {` method definitions, `refetch(`, `fetchFn`, or `safeFetch(`. This is precisely the guard-authoring failure mode this repo has hit before, so the rule ships with a fixture that red-proves **both** directions: it fires on a real bare call, and stays silent on each of those four shapes.

---

## 6. Call-site inventory for PR 2

14 files, none in the forbidden set:

| File | New `source_type` | Mechanism |
|---|---|---|
| `engine/router.ts` (×2) | `net:llm` | `egressFetch` |
| `embedding/openai-embedder.ts` | `net:embedding` | `egressFetch` |
| `llm/ollama-provider.ts` (×5) | `local:llm` / `net:llm` | `egressFetch` |
| `llm/llamacpp-provider.ts` (×2) | `local:llm` / `net:llm` | `egressFetch` |
| `audit/audit-shipper.ts` | `net:audit` | `egressFetch` |
| `telemetry/flush-scheduler.ts` | `net:telemetry` | `egressFetch` |
| `updater/manifest-fetcher.ts` | `net:updater` | `egressFetch` |
| `updater/updater.ts` | `net:updater` | `egressFetch` |
| `identity/jwks-cache.ts` | `net:identity` | `egressFetch` |
| `extensions/registry-client.ts` | `net:registry` | `egressFetch` |
| `share/safe-fetch.ts` | `net:share` | `egressFetch` |
| `sync/scheduler.ts` (`runJob`) | `net:sync` | `recordEgress`, one row per run |
| `ipc/lan-client.ts` (×2) | `net:federation` | `recordEgress` |
| `chatops/transport/bun-socket.ts` | `net:chatops` | `recordEgress` |

`sync/scheduler.ts` is the seam that covers all 24 connector files **without editing any of them** — which the parallel-branch constraint requires and which is also the better design at this granularity.

---

## 7. What this still does not cover

Written down because the tier vocabulary must stay honest:

1. **Connector subprocess traffic is per-run, not per-request.** A sync run is one row regardless of how many HTTP calls it made. `mcp-connectors/*` are separate processes; neither a gateway-side static audit nor a gateway-side global patch can see inside them.
2. **Third-party libraries inside the gateway process** are uncovered until the PR-3 backstop lands. This is exactly the gap between `first-party-egress` and `all-egress`.

   **The PR-3 backstop's boundary, stated precisely:** patching `globalThis.fetch` intercepts `fetch` and nothing else. A dependency using `node:https.request` or opening a raw socket is invisible to it. Closing *that* would require intercepting socket creation itself, which is out of scope here. Consequently `all-egress` means "all egress via `fetch`, plus all first-party egress via any primitive" — the tier string and its documentation must say so rather than implying packet-level completeness.
3. **DNS rebinding** — classification uses the pre-resolution URL host (§3.4).
4. **Lost degradation signal on abrupt process death** (§4.2).
5. **Not syscall capture.** A determined local process can still open a socket; this ledger records what *Nimbus* sends.

---

## 8. Testing

| Layer | Coverage |
|---|---|
| Unit — classification | IPv6, `::ffff:` mapped v4, bracketed hosts, bare `localhost`, LAN-vs-loopback split, unparseable host → `net:unknown` |
| Unit — classification (negative) | `169.254.169.254` → `net:` never `local:`; `anything.local` → `net:` never `local:` (§3.4.1) |
| Static — Node primitives | `D22-egress-fetch` red-proved against `https.request(`, `net.connect(`, `tls.connect(` and a `node:net` import (§5) |
| Unit — ordering | fake `fetch` asserts the row already exists when the call fires (append-before-egress) |
| Unit — degrade | append throws → call still completes → counter set → `net:degraded` marker on next successful append |
| Unit — tier | weakest-tier resolution across multiple boot markers; window with no covering marker → `indeterminate` |
| Unit — markers | `prune` / `boot` / `net:degraded` rows excluded from the count despite carrying `authorized` (§3.3.1) |
| Unit — unwired sink | a boot with no `setEgressSink` yields `indeterminate`, never `0` (§4.3) |
| Regression | rows written by the current binary still verify (hash inputs unchanged) |
| Invariant | `I29` describe block extended: prefix counting, `local:` exclusion, gated-action abort still fires |
| Static | `D22-egress-fetch` red-proved in both directions (§5) |
| E2E | `nimbus prove` with `prefer_local` Ollama → `0 ✓` with loopback listed; with a cloud model → non-zero |

Coverage floor ≥80% line+branch per new file under `egress/`, verified Docker-Linux-authoritative.

---

## 9. Delivery

| PR | Contents | Tier reported |
|---|---|---|
| 1 | `egress-fetch.ts`, classification, taxonomy, boot marker, tier resolution, sink registration, tests. No call sites moved. | `authorized-actions` (unchanged) |
| 2 | The 14 call sites; `D22-egress-fetch` enforced; **I29 rewrite + CLI wording** — the invariant triple lands together | `first-party-egress` |
| 3 | `globalThis.fetch` backstop → `net:unattributed` rows | `all-egress` |

PR 2 carries wiring + docs + test in one commit, per the repo's triple rule. The tier only reaches `all-egress` at PR 3; stopping after PR 2 is legitimate, it just means the CLI keeps saying `first-party-egress`.

**Docs to update in PR 2:** `docs/SECURITY-INVARIANTS.md` (I29 statement + wired-at + anti-patterns), `CLAUDE.md` + `GEMINI.md` (I29 bullet, both files), `.claude/commands/nimbus-egress.md`, `docs/architecture.md`, `docs/cli-reference.md`, `docs/CHANGELOG.md`.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| Module-global sink contaminates Bun test runs | `resetEgressSink()` in `afterEach`; no `mock.module` for this seam |
| D22 regex false-positives on `fetch(req) {` / `refetch(` / `fetchFn` | fixture red-proves both directions before the rule is enforced (§5) |
| Ledger volume from loopback LLM rows | rows are small and metadata-only; `egress.prune` already exists for retention |
| `prove` output churn breaks existing e2e assertions | CLI wording changes land in PR 2 with its test updates |
| Tier ladder misread as "done" after PR 2 | tier string is printed next to every count, never a bare number |

---

## 11. Review disposition

Against [`2026-08-03-i29-ledger-completeness-design-review.md`](./2026-08-03-i29-ledger-completeness-design-review.md).

| # | Finding | Disposition |
|---|---|---|
| 1 | Pre-DNS classification misses hostname-addressed local models; classify link-local | **Partly fixed, partly rejected.** Link-local added explicitly as `net:` (§3.4) — a good catch, `169.254.169.254` is credential-bearing. The `.local`/hostname exception is **rejected**: see §3.4.1. |
| 2 | Node primitives (`node:net`/`tls`/`http`/`https`) bypass the static rule; state PR-3's boundary | **Fixed in full** (§5, §7.2). Correct and cheap; the rule now flags imports as well as calls. |
| 3 | Replace the module-global sink with `AsyncLocalStorage` | **Concern accepted, mechanism rejected. Deferred** — see below. |
| 4 | A read-only/locked DB means the `net:degraded` marker can never be written; add a sentinel file | **Partly fixed, remainder deferred.** §4.2 now states the sustained-failure case and why soundness survives it. The sentinel file is deferred. |

### 11.1 Why `AsyncLocalStorage` is the wrong mechanism here

`AsyncLocalStorage` is idiomatic in this codebase — `engine/agent-request-context.ts` and `chatops/chatops-request-context.ts` both use it, and §3.2 cites the former as precedent. So the suggestion is reasonable on its face.

It does not work for this problem. ALS only carries a value into code running inside a `.run()` callback, and the egress classes that matter most are **timer-driven, outside any request context**: `telemetry/flush-scheduler.ts:159` and `sync/scheduler.ts:191` are both `setInterval`. A timer callback's `getStore()` returns `undefined`, so every unattended egress path — sync, telemetry, updater, OAuth refresh — falls back to the module global anyway. ALS would add ceremony while leaving the dominant classes exactly as they are.

The underlying concern is nonetheless real, and there is a better answer already on the table: the 2026-08-02 spec of record calls for making the sink **required** at construction with a named `NULL_EGRESS_SINK` for gate-only sites. That removes the ambient read for every path reachable by DI, rather than relocating it. Deferred into that reconciliation (§12) rather than solved twice.

### 11.2 Deferred

| Item | Why deferred |
|---|---|
| Structural local-provider predicate (classify by configured endpoint, not host string) | Blocked on whether local inference emits rows at all — see §12 |
| Sentinel file for degradation across restarts | Forensic detail only; soundness already held by the boot marker (§4.2) |
| Socket-level interception beyond `globalThis.fetch` | Out of scope; boundary now documented (§7.2) |
| Required sink / `NULL_EGRESS_SINK` | Subsumed by the spec of record's Phase 1 (§12) |

---

## 12. Unresolved: conflict with the 2026-08-02 spec of record

[`2026-08-02-i29-d22-egress-completeness-design.md`](./2026-08-02-i29-d22-egress-completeness-design.md) is the security spec of record for this invariant and was written from a six-agent audit. It was not consulted while this document was drafted — an omission, since it covers the same question with wider modality coverage.

**This spec must not proceed to a plan until reconciled.** Known conflicts:

| Question | Spec of record | This spec | Assessment |
|---|---|---|---|
| `source_type` | Freeze the closed union up front — the row hash makes each value permanent | Widens incrementally with `net:`/`local:` | Spec of record is right |
| Sink | Required, named `NULL_EGRESS_SINK` | Optional + module-global | Spec of record is right |
| Tier | Per-source coverage vector | Scalar 3-rung ladder | Spec of record is more expressive |
| D22 allowlist | "Do not add an allowlist entry so the audit passes" | Adds `connectors/**` | Needs reconciliation |
| Local inference | **No rows at all** — else the ledger becomes noise | Rows, excluded from the count | **Open — owner decision** |

It also enumerates a modality this document missed entirely: the MCP-mesh execute path (raw `tool.execute()`, the `teamvault/connector-session.ts` façade, `auth/oauth-registry.ts:486` OAuth refresh), plus a security finding beyond record-honesty in `share.replay`.

**What this document contributes that the spec of record does not:** the verified `fetch`-modality inventory (§1.1–1.2), the pre-existing prune miscount (§3.3.1), the boot marker for detecting an unwired sink (§3.6), and the review dispositions above. The intended resolution is to fold these into the spec of record's phase structure and vocabulary — this becomes detail under its Phases 3–5, not a parallel plan.
