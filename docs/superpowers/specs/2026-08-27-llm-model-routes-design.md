# LLM Model Routes — Design

**Date:** 2026-08-27
**Status:** approved design, not yet planned
**Slot:** Spine S2 — Local Compute Fleet, row *"bring-your-own-frontier-model routing with local fallback"*
**Slice:** 1 of 4 (see [Decomposition](#decomposition))

---

## 1. Problem

The gateway can register exactly **one** remote LLM provider, and that seat has never been
filled.

`LlmProviderKind` is a closed union — `"ollama" | "llamacpp" | "remote"` (`llm/types.ts`) — and
`LlmRouter.providers` is a `Map<LlmProviderKind, LlmProvider>` (`llm/router.ts`). One provider per
kind. Registering Gemini and then Bedrock does not give two providers; the second call to
`registerProvider` **evicts the first**, silently, because `Map.set` on the same key overwrites.

`platform/assemble.ts` (`buildLlmRegistryFromToml`) registers `OllamaProvider` and
`LlamaCppProvider` and nothing else, so `"remote"` is a reserved slot that no production code path
has ever occupied. `[llm] remote_model` even defaults to `"claude-sonnet-4-6"` — a model name for a
provider that does not exist.

The same single-seat constraint applies one level down, to local models. `OllamaProvider` takes a
model name in its constructor (default `"llama3.2"`, `llm/ollama-provider.ts:106`) and there is no
model allowlist anywhere, so `[llm] local_model = "qwen3"` already works. What does not work is
running **two local models at once** — "qwen3 for reasoning, gemma for classification" is
unrepresentable, because the seat is per *runtime* and the model is a single global config string.

So the user-facing asks — *configure Claude / ChatGPT / Gemini / Grok / Bedrock, pick which model,
pick which local model, route tasks to different ones* — all reduce to one change:

> **The router's unit must be a `(provider, model)` route, not a provider kind.**

### Why this slice ships no cloud vendor

Doing the refactor first means every vendor after it is a thin adapter against a proven interface,
and — more importantly — it means two known correctness gaps are closed **while zero bytes leave the
machine**. Both are described in §4. Landing vendors first would mean patching a live egress path
instead of a dormant one.

---

## 2. Goals / Non-goals

**Goals**

- Register N `(provider, model)` routes simultaneously, including several routes on the same
  runtime.
- Resolve a route per task by an explicit order, preserving today's `prefer_local` semantics when
  no order is configured.
- Collapse the three independent definitions of "is this provider local" into one.
- Make the egress destination name the vendor, not the word `model`.
- Close the un-ledgered context-overflow fallback path.

**Non-goals (deferred, and to which slice)**

- Any cloud provider adapter — slice 2 (bearer-key: Anthropic, OpenAI, Gemini, xAI) and slice 3
  (Bedrock, SigV4).
- `nimbus llm use <vendor>/<model>` and per-task pinning **as a CLI/config surface** — slice 4.
  (Slice 1 does change `nimbus llm status`; see §7.)
- Any change to how `[agents] synthesis` decides `off` / `local` / `allow-remote`.
- Any new HITL gate on inference. See [Open decision 3](#open-decisions).

---

## 3. Design

### 3.1 The routing unit

```ts
type ProviderId = string;              // open — no closed union

type ModelRoute = {
  readonly routeId: string;            // `${providerId}/${modelName}`
  readonly provider: LlmProvider;
  readonly modelName: string;
  readonly meta: ProviderMeta;         // parameterCount, contextWindow
};
```

`LlmRouter` keys its map on `routeId` rather than `providerId`.

**`LlmProvider.generate()` keeps its signature.** `OllamaProvider` is already constructed with a
fixed model name, so two models means **two instances** — same `providerId: "ollama"`, distinct
`routeId`s (`ollama/qwen3`, `ollama/gemma3`). No provider implementation changes; only the map key
does. This is deliberately the smallest change that removes the seat limit: threading a model name
through `generate()` would touch every provider and every call site for no additional capability.

`providerId` survives as the **vendor label** — it is what egress `destination` and local/remote
classification key on, and it is intentionally not unique across routes.

### 3.2 `isLocal` is declared by the provider, and defined once

Local-ness is currently encoded in three places that must agree:

| Site | Form |
| --- | --- |
| `llm/router.ts` | `LOCAL_PROVIDER_IDS: ReadonlySet<LlmProviderKind>` |
| `ipc/llm-rpc.ts` | `LOCAL_PROVIDERS = ["ollama", "llamacpp"] as const` |
| `llm/registry.ts` | a bare `["ollama", "llamacpp"] as const` inside `refreshProviderMeta` |

Three copies of a security-relevant fact is the shape that produced the hardcoded-environment bug
in the Windows sandbox work (three copies of one env wire). It becomes a **required** field on the
`LlmProvider` interface:

```ts
interface LlmProvider {
  readonly providerId: ProviderId;
  readonly isLocal: boolean;     // required — omitting it is a compile error
  // ...unchanged
}
```

Required rather than optional so omission fails at compile time. Note that even if it were
optional, an unset value would be falsy and therefore classified **remote** — the mistake falls in
the safe direction either way, and that ordering is intentional.

This preserves the single best property of the current design: **anything not explicitly local is
treated as remote**, automatically, by air-gap enforcement, by `[agents] synthesis = "local"`, and
by the I29 appender — for vendors that do not exist yet. `isLocalProviderKind()` is replaced by
reading `route.provider.isLocal`; the exported predicate is kept as a thin wrapper only if an
external caller still needs it (verify at implementation time — the doc comment claims
`engine/router.ts` `classifyIntent` is the caller that mattered).

### 3.3 Resolution order

```toml
[llm]
prefer_local  = true
route_priority = ["ollama/qwen3", "ollama/gemma3"]   # optional; when set, it IS the order
```

Resolution for a task: **explicit task pin → `route_priority` → default ordering**, then filtered
by air-gap, the reasoning capability floor, and availability, in that order — matching what
`firstAvailable` does today.

Absent `route_priority`, the default ordering reproduces today's semantics exactly: local routes
first when `prefer_local = true`, remote first otherwise. Task pins are read from
`llm_task_defaults` and are inert until slice 4 gives them a surface; the resolution step exists in
slice 1 so slice 4 is a surface change rather than a router change.

### 3.4 Config

`[llm.local.<name>]` sub-tables:

```toml
[llm.local.qwen3]
runtime = "ollama"
model   = "qwen3:8b"

[llm.local.gemma]
runtime = "ollama"
model   = "gemma3:12b"
```

The dynamic sub-table pattern already exists in `config/service-config-toml.ts`
(`CI_SERVICE_TABLE_PREFIX = "[ci.service."`, consumed by `accumulateServiceTables` /
`resolveServiceTableId`). **Those helpers are module-private**, so slice 1 either extracts them to
a shared module or writes the `[llm.local.` equivalent alongside them — an implementation choice,
but the parser machinery is not new work either way.

**Back-compat is total.** Existing `local_model` / `remote_model` / `prefer_local` keys keep
working and synthesise a single route each. No user config breaks.

### 3.5 Database

**No migration.** Both tables were already built for pairs; only the router forgot:

- `llm_models` — `ON CONFLICT(provider, model_name)`, a composite key.
- `llm_task_defaults` — stores `(task_type, provider, model_name, updated_at)`.

`registry.setDefault` and `registry.getDefault` already read and write both columns. What is
missing is that `LlmRouter.modelNameFor()` never consults them — it returns the single global
`config.localModel` / `config.remoteModel`, and its own inline comment says so. Slice 1 makes the
router route-aware; slice 4 wires the per-task pins to a CLI.

---

## 4. Two correctness fixes that belong in this slice

Both are latent today and become load-bearing the moment slice 2 lands. Fixing them here means
fixing them against a dormant path.

### 4.1 The context-overflow fallback is un-ledgered

`LlmRouter.fitPromptOrFallback` → `tryRemoteFallback` does `this.providers.get("remote")` and
generates directly. This is already flagged in the tree: a comment in
`agents/_lib/synthesis-llm.ts` (≈line 216) notes that this path "can reach a REMOTE provider on
context overflow with NO egress row."

With routes there is no `"remote"` key at all, so the path must be rewritten as *"the next
available route whose context window fits, in priority order"* and made to go through the same
append path as any other resolution.

**In slice 1 this is a pure refactor with zero behavioural change**, because no remote route
exists to fall back to. That is precisely the argument for doing it now.

### 4.2 The egress destination does not name the vendor

`egress/synthesis-egress.ts` hardcodes `destination: "model"`, and its parameter type is
`{ readonly modelName: string; readonly isLocal: boolean }` — it structurally **drops**
`providerId`, even though the call site in `synthesis-llm.ts` passes a full
`ResolvedSynthesisProvider` that has it.

With five vendors, `nimbus prove` would report that "a prompt went to a model", which is #1321's
lesson restated: *"email" is not a place data can go, "gmail" is.* `serviceOf()`-style prefix
identity is what makes an egress destination meaningful.

The fix is small — widen the parameter to carry `providerId` and use it as `destination`. What must
**not** change is the appender deriving `isLocal` itself rather than accepting a caller boolean;
that property is documented at length in the appender and is the reason a false zero cannot be
written into the ledger.

**Honest bound:** in slice 1 both fixes are provable only by unit test, because zero rows are
appended either way with no remote route registered. Neither can be demonstrated end-to-end until
slice 2. The spec states this rather than letting a green test suite imply more than it proves.

---

## 5. Blast radius

Non-test files that reference the symbols being changed (`LlmProviderKind`, `registerProvider`,
`providerFor`, `resolveForSynthesis`, `generateMarkdown`, `isLocalProviderKind`, `LlmRegistry`):

**Directly rewritten**

- `llm/types.ts` — open provider id, `ModelRoute`, required `isLocal`
- `llm/router.ts` — route map, priority walk, `tryRemoteFallback`, `modelNameFor`, `getStatus`
- `llm/registry.ts` — three hardcoded id arrays, plus `"ollama" | "llamacpp"` literal types on
  `loadModel` / `unloadModel` / `pullModel` / `setDefault`
- `ipc/llm-rpc.ts` — `VALID_LLM_PROVIDERS`, `LOCAL_PROVIDERS`, `requireLocalProvider`
- `egress/synthesis-egress.ts` — destination
- `agents/_lib/synthesis-llm.ts` — `RecordSynthesisEgressFn` param type widening
- `platform/assemble.ts` — `buildLlmRegistryFromToml` registers N routes
- `config/nimbus-toml.ts` — `[llm.local.<name>]`, `route_priority`

**Consumers to check, not necessarily change** — `engine/run-ask.ts`,
`engine/run-conversational-agent.ts`, `ipc/server/dispatchers.ts`, `ipc/server/options.ts`,
`agents/_lib/{synthesize,agent-synthesis-runner}.ts`, `agent-runs/agent-http-invoke.ts`,
`briefs/brief-llm-adapter.ts`, `glossary/glossary-llm-adapter.ts`,
`decisions/decision-llm-adapter.ts`, `platform/types.ts`, `gateway-main.ts`.

All paths above are relative to `packages/gateway/src/`. Test files are not listed individually;
32 files in total reference the changed symbols, of which roughly half are tests — see §6.

**Surface**

- **No `ALLOWED_METHODS` change.** Eight `llm.*` methods are renderer-exposed
  (`packages/ui/src-tauri/src/gateway_bridge.rs`); slice 1 adds none, so the I7 count assertion is
  untouched. Response *shapes* change for `llm.listModels` and `llm.getRouterStatus`, so the
  desktop UI consumers need checking.
- **No new invariant.** See [Open decision 1](#open-decisions).

---

## 6. Testing

- **Red-prove the seat bug first.** Register two Ollama routes with different models and assert
  both resolve. On today's code the second evicts the first, so this test must fail before the
  refactor and pass after. Per repo convention, prove it red by reverting, not by observing green.
- Router: priority walk across N routes; air-gap skips every non-local route; the reasoning
  capability floor still fires per route; `getStatus` reports the route that `generate()` would
  actually use.
- Context overflow picks the next fitting route in priority order and appends through the normal
  path — asserted with a local-only route set, where the correct row count is zero.
- Egress: `destination` equals the `providerId`, asserted against a fake remote provider
  (`isLocal: false`) registered in-test. This is the only way to exercise §4.2 in slice 1.
- **One definition of local-ness:** a structural test asserting `isLocal` has exactly one
  definition site and that `ipc/llm-rpc.ts` / `llm/registry.ts` no longer carry their own copies.
- Config: `[llm.local.<name>]` round-trip; legacy `local_model` still yields one working route;
  malformed sub-table does not discard the whole `[llm]` section (matching the `[ownership]`
  precedent at `nimbus-toml.ts` ≈1907).

Coverage: `llm/` sits under the Engine ≥85% gate. `audit:coverage-floor` is CI-Linux-authoritative
— verify with `verify:docker --changed`, not a local run.

---

## 7. Open decisions

Decided rather than left blank, so the plan is actionable. Each is cheap to reverse.

1. **No new static `D`-rule in slice 1.** The one-definition-of-local-ness rule ships as a
   structural **test**, not as an entry in `scripts/structure-audit/check-nimbus-invariants.ts`.
   Rationale: this strengthens I29's derivation rather than adding an invariant, and the repo's
   rule is that a `D` number arrives with the full triple (wiring + docs + test in one commit). It
   is worth **promoting to a `D`-rule in slice 2**, when it confines five vendor adapters instead
   of two local ones — at two members a static rule has almost no teeth.

2. **Slice 1 does change `nimbus llm status`, minimally.** It lists all routes rather than one
   entry per kind. No new subcommands (`nimbus llm use` stays in slice 4). Rationale: once several
   routes exist, a status command that reports one per kind is not merely incomplete, it is
   **wrong** — and shipping a surface that under-reports its own state is the failure mode this
   project treats most seriously.

3. **Consent posture — carried to slice 2, unresolved here, and it does not block slice 1**
   (slice 1 opens no new egress path). The working assumption to confirm before any vendor lands:
   *configuration is consent; there is no per-call HITL on inference*, on the precedent that
   `openai.api_key` already sends indexed prose to OpenAI for embeddings with no prompt, and
   because per-call approval would make agent briefs unusable. **One thing should change about
   that precedent:** today embeddings route remote the moment a key exists. A capability that turns
   itself on as a side effect of a credential being present is the same shape as the air-gap defect
   (#1334) — so enabling a remote vendor must require an explicit opt-in flag, never be inferred
   from key presence.

---

## 8. Decomposition

| Slice | Content | Status |
| --- | --- | --- |
| **1. Model routes** | This document. `(provider, model)` routes, one definition of `isLocal`, vendor-named egress destination, ledgered overflow fallback. Ships multi-local-model routing and **zero** cloud vendors. | approved, planning next |
| **2. Bearer-key clouds** | Anthropic, OpenAI, Gemini, xAI. One adapter shape, four configs, four Vault keys, the explicit opt-in flag from Open decision 3, and the `D`-rule promotion from Open decision 1. First slice where an `egress_ledger` `model` row is ever written. | not started |
| **3. Bedrock** | SigV4 signing, region, static creds *or* profile/role chain. Kept separate because it shares no auth shape with slice 2; reuses the `aws.*` credential fields connectors already have. | not started |
| **4. Selection surface** | `[llm.tasks]` per-task pinning, `nimbus llm use <vendor>/<model>` writing to `llm_task_defaults`, full `nimbus llm status`. | not started |

---

## 9. Risks

- **A wide type change across ~20 non-test files.** `bun` does not typecheck at runtime, so a green
  test run says nothing about type correctness — `typecheck` and `typecheck:tests` are both
  required, and the latter is **advisory on win32** (prints violations, exits 0) and
  Linux-authoritative. Verify in Docker before calling it green.
- **`mock.module` contamination.** Several consumers are dispatcher-driven; prefer dependency
  injection over `mock.module`, per the repo's standing preference and the CI-Linux-only failure
  class it causes.
- **The gateway `test/**` tree is not loaded by a `packages/gateway/src` run.** Verify with the CI
  command verbatim: `bun test packages/gateway packages/cli scripts`.
- **Desktop UI consumers of the changed response shapes** may break without any TypeScript error
  crossing the IPC boundary, since the renderer talks JSON-RPC. Check `llm.listModels` and
  `llm.getRouterStatus` consumers in `packages/ui` explicitly.
