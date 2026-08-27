# LLM Model Routes — Design

**Date:** 2026-08-27
**Status:** approved design, not yet planned
**Slot:** Spine S2 — Local Compute Fleet, row *"bring-your-own-frontier-model routing with local fallback"*
**Slice:** 1 of 4 (see [Decomposition](#8-decomposition))

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
and — more importantly — it means both known correctness gaps get fixed **while zero bytes leave the
machine**, because no remote route exists yet to exercise either one. Both are described in §4, and
they land differently: §4.2's destination-naming gap is fixed outright. §4.1's un-ledgered
context-overflow fallback is only **structurally narrowed, not closed** — the key that reaches it is
narrower (a route id instead of a literal `"remote"` string that never resolved), but the reachable
surface is wider (any registered non-local route, not a slot nothing could ever fill), and it remains
a named blocker on slice 2 rather than a slice 1 deliverable. See §4.1's corrected framing below.
Landing vendors first would mean patching a live egress path instead of a dormant one.

---

## 2. Goals / Non-goals

**Goals**

- Register N `(provider, model)` routes simultaneously, including several routes on the same
  runtime.
- Resolve a route per task by an explicit order, preserving today's `prefer_local` semantics when
  no order is configured.
- Collapse the three independent definitions of "is this provider local" into one.
- Make the egress destination name the vendor, not the word `model`.
- Rewrite the un-ledgered context-overflow fallback to walk routes instead of a literal `"remote"`
  key. This narrows what could ever reach it — it does **not** close the un-ledgered gap itself;
  see §4.1.
- Make route availability mean "this model answers", not "the daemon is up" (§3.4) — a fail-open
  that only becomes harmful once a priority walk exists, i.e. one this slice creates.

**Non-goals (deferred, and to which slice)**

- Any cloud provider adapter — slice 2 (bearer-key: Anthropic, OpenAI, Gemini, xAI) and slice 3
  (Bedrock, SigV4).
- `nimbus llm use <vendor>/<model>` and per-task pinning **as a CLI/config surface** — slice 4.
  (Slice 1 does change `nimbus llm status`; see §7.)
- Any change to how `[agents] synthesis` decides `off` / `local` / `allow-remote`.
- Any new HITL gate on inference. See [Open decision 3](#7-open-decisions).

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

#### `routeId` is opaque internally and parsed only at the boundary

Model names contain slashes. This is not hypothetical: `LlamaCppProvider`'s model name defaults to
`"model.gguf"` and is realistically a **file path** (`/models/meta-llama/Llama-3-8B.gguf`, or a
Windows path with backslashes and a drive colon), and Ollama accepts namespaced tags such as
`hf.co/user/model`. A naive `routeId.split("/")` breaks on all of these.

Two rules, and the first is what actually makes it safe:

1. **`routeId` is never parsed inside the router.** `ModelRoute` already carries `providerId` and
   `modelName` as separate fields; `routeId` is an opaque map key, only ever compared for equality.
   Parsing it internally would be re-deriving data the struct already holds.
2. **Parsing happens only where a human typed a string** — `route_priority` entries and (slice 4)
   `nimbus llm use <vendor>/<model>`. There it splits on the **first** slash, which is unambiguous
   because `providerId` is drawn from a known set and is validated to contain no slash:

   ```ts
   const i = raw.indexOf("/");
   const providerId = raw.slice(0, i);
   const modelName  = raw.slice(i + 1);   // may itself contain slashes
   ```

A route reference that matches no registered route is **named in a `warn` log and dropped at
assembly, and boot continues** — never a silently dropped entry. (Corrected after the fact: this
paragraph originally said "a config error reported at load", which reads as a refusal. Nothing
refuses. It cannot: a throw inside the `[llm]` parser is swallowed by `loadTomlSection`'s bare
catch and silently reverts the WHOLE section to defaults, `enforce_air_gap` included — a far worse
failure than the one it would be reporting. So `platform/assemble.ts` validates AFTER the parse,
warn-logs the offending entry by name, drops it, and carries on.) The property that matters is
unchanged and is what the tests assert: the entry never vanishes without a word. A `route_priority`
entry that quietly disappeared would degrade to the default ordering with no signal, which is the
"supplied flag degrading into an omitted filter" shape.

#### llama.cpp cannot host two models at one base URL

`LlamaCppProvider.generate()` sends no model field — the server answers with whatever it was
launched with (`llamacpp-provider.ts`, the `/completion` body has `prompt`/`n_predict`/
`temperature`/`stream` only). So two llama.cpp routes at the same `baseUrl` would both hit the same
loaded weights while reporting different model names: a route table that lies.

Multi-model on llama.cpp therefore requires **one server per model at distinct base URLs**, and
config must express that. Ollama has no such limit — `generate()` sends `this.modelName` to a shared
daemon. Slice 1 must reject, at config load, two llama.cpp routes sharing a `base_url`.

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

Resolution for a task, as designed: **explicit task pin → `route_priority` → default ordering**.
That sequence chooses the candidate **order** only. Air-gap, the reasoning capability floor, and
availability are **gates applied to every candidate**, including an explicit pin — a pin selects
which route is tried first, never that it is tried unconditionally.

> **What slice 1 actually shipped: the task-pin stage does NOT exist.** `LlmRouter.orderedRoutes`
> implements `route_priority` → `byPreference` and nothing before it; the router never consults
> `LlmRegistry.getDefault` or `llm_task_defaults`. Nothing regressed — pins were inert before this
> slice too — but the pin stage was never written, so the rest of this section describes a rule
> that has no code behind it yet. Slice 4 must implement it (see the corrected §8 row).

Stated explicitly because the earlier wording ("then filtered by…") could be read as filtering only
the fallback chain: if `[llm.tasks] reasoning = "gemini/gemini-2.5-pro"` is pinned and
`enforce_air_gap = true`, the pin must be **skipped**, not honoured. This is a requirement ON
slice 4, not a property of slice 1 — with no pin stage there is nothing yet to gate. A pin that could defeat air-gap
would make a preference setting override a refusal setting, which inverts the whole point of
keeping those two knobs distinct (`router.ts` `enforcesAirGap` documents that distinction at
length).

No behaviour change is implied for the existing walk: `firstAvailable` already applies both gates
inside the loop via `continue`, rather than pre-filtering a pool. The routes version keeps that
shape.

Absent `route_priority`, the default ordering reproduces today's semantics exactly: local routes
first when `prefer_local = true`, remote first otherwise — and that is the whole of what slice 1
resolves. Task pins remain inert: `llm_task_defaults` is still written and read by
`LlmRegistry.getDefault`, but no router path calls it. The original claim here — "the resolution
step exists in slice 1 so slice 4 is a surface change rather than a router change" — is
**withdrawn**: the resolution step was not built, so slice 4 changes the router as well as the
surface.

### 3.4 Route availability must mean "this model answers", not "the daemon is up"

**This is a fail-open that slice 1 creates, so slice 1 must close it.**

`OllamaProvider.isAvailable()` issues `GET /api/tags` and returns `resp.ok`. It never checks that
`this.modelName` is among the tags. `LlamaCppProvider.isAvailable()` pings `/health`, likewise
model-blind. So a route configured for a model that was never pulled reports **available**, the
priority walk stops there, and the call fails at `generate()`.

With one route that is merely a confusing error — the only configured model is wrong, and nothing
else could have run. With N routes it is materially worse: the walk halts at the first route that
falsely claims availability **instead of falling through to a route that would have worked**. The
degradation is invisible, and it exists only because this slice introduced the walk.

Fix: availability is per **route**, not per provider — `daemon reachable AND modelName present in
listModels()`. `OllamaProvider.listModels()` already parses the daemon's tag list, so the data is
free; what it needs is a short-TTL cache so resolving four routes does not issue four `/api/tags`
round trips. `LlamaCppProvider.listModels()` returns its own configured name unconditionally, which
is honest only under the one-server-per-model rule above.

**No auto-pull on a miss.** Falling through to the next route is correct; silently initiating a
multi-gigabyte download because a config entry named a model is not. Pulling stays explicit
(`llm.pullModel`, already wired). A route unavailable *because its model is absent* must be
distinguishable in `nimbus llm status` from one unavailable because the daemon is down — those have
different fixes, and reporting both as "unavailable" sends the user to the wrong one.

### 3.5 Lifecycle operations key on `providerId`, not `routeId`

`registry.pullModel` / `loadModel` / `unloadModel` currently resolve `providers.get(provider)` by
kind, which no longer exists after the refactor. They key on **`providerId`** — any registered
instance of that runtime — and the model name stays an explicit argument.

Keying them on `routeId` would be wrong, not merely redundant: `OllamaProvider.pullModel(modelName)`
posts that **argument** to the shared daemon's `/api/pull` and ignores `this.modelName`, so any
instance can pull any model. Requiring a matching route would make it impossible to pull a model
that has no route yet — which is the primary use of pull, and the exact thing a user does before
adding a route for it.

### 3.6 Config

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

### 3.7 Database

**No migration.** Both tables were already built for pairs; only the router forgot:

- `llm_models` — `ON CONFLICT(provider, model_name)`, a composite key.
- `llm_task_defaults` — stores `(task_type, provider, model_name, updated_at)`.

`registry.setDefault` and `registry.getDefault` already read and write both columns. What is
missing is that `LlmRouter.modelNameFor()` never consults them — it returns the single global
`config.localModel` / `config.remoteModel`, and its own inline comment says so. Slice 1 makes the
router route-aware; slice 4 wires the per-task pins into BOTH the router (the resolution stage
§3.3 said slice 1 would build, and did not) and a CLI.

---

## 4. Two correctness fixes that belong in this slice

Both are latent today and become load-bearing the moment slice 2 lands. Fixing them here means
fixing them against a dormant path.

### 4.1 The context-overflow fallback is un-ledgered — narrowed, NOT closed

`LlmRouter.fitPromptOrFallback` → `tryRemoteFallback` does `this.providers.get("remote")` and
generates directly. This is already flagged in the tree: a comment in
`agents/_lib/synthesis-llm.ts` (≈line 216) notes that this path "can reach a REMOTE provider on
context overflow with NO egress row."

With routes there is no `"remote"` key at all, so the path is rewritten as *"the next available
route whose context window fits, in priority order"*.

**Corrected from an earlier draft of this section, which is why this heading says so explicitly:**
that rewrite is **all** slice 1 does here. `LlmRouter.generate()` — reached by this fallback and by
every other caller in this section — still calls the resolved route's provider directly, with
**no egress append and no `[agents] synthesis` check**. Slice 1 does not make it "go through the
same append path as any other resolution"; no such path exists on this method yet. The accurate
framing is: **structurally narrower key, materially wider blast radius.** Before this slice, the
key was a literal `"remote"` string that `buildLlmRegistryFromToml` never registered anything
under — the path was *reachable in code* but unreachable in practice, i.e. never, on any
production config. After this slice, the key is a `routeId`, and **any** registered non-local
route satisfies it — the day slice 2 registers a first remote route, this path becomes live on
whatever config already exists, with no further code change required to reach it. Narrowing what
*kind* of key opens the path while widening *how many* configurations can trigger it is a trade
that only pays off if the blocker below is honored.

**In slice 1 this remains a pure refactor with zero *observable* behavioural change**, because no
remote route exists to register yet — but "no behavioural change" describes today's empty
registry, not a property of the code path itself.

**Which path this is, precisely — because it is easy to get backwards.** Brief synthesis does *not*
reach this hazard. `synthesis-llm.ts` deliberately calls `router.generateMarkdown(prompt, resolved)`
and never `router.generate()`, with an inline instruction not to unify the two, exactly so the
overflow fallback cannot bypass the ledger append and the `[agents] synthesis` mode check. So on the
synthesis path there is no fallback to ledger, by construction.

The hazard is in **`LlmRouter.generate()`**, whose callers are `engine/run-ask.ts`,
`briefs/brief-llm-adapter.ts`, `glossary/glossary-llm-adapter.ts` and
`decisions/decision-llm-adapter.ts` — none of which append an egress row today, because I29's
`model` coverage class is scoped to built-in agent brief synthesis and has never claimed more.

**That scoping is sound today and becomes a hole the moment slice 2 lands.** With a remote route
registered, `nimbus ask` and the glossary/decisions passes can send indexed private content to a
vendor through `generate()` with **no `egress_ledger` row**, while `nimbus prove` reports only the
synthesis calls. A ledger that is silent about real outbound traffic is the precise failure this
subsystem exists to prevent.

**Therefore: a named, HARD blocker on slice 2, not a slice 1 deliverable, and not weakened by
anything above.** Before the first remote route is registered — literally, before the commit that
adds the first non-local `LlmProvider` to `buildLlmRegistryFromToml` merges — slice 2 must either
extend the `model` coverage class to `LlmRouter.generate()` (all four callers, not just the
overflow-fallback branch) or state in `docs/SECURITY-INVARIANTS.md` exactly which LLM calls the
class does not cover, with the same rigor I29's existing exclusions already document. Landing a
remote provider registration in the same slice or PR as this coverage fix is the wrong order: the
coverage fix must be provably in place — wiring, docs, and enforcement test, the standard triple —
*before* a remote route can be registered by any code path, not merely before it is expected to be
exercised. Widening I29's coverage is a deliberate invariant change requiring the wiring + docs + test
triple; it is recorded here so slice 2 cannot land without confronting it.

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
- **No new invariant.** See [Open decision 1](#7-open-decisions).

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
- **Availability is per route (§3.4):** with a daemon reachable but a model absent from
  `listModels()`, the route reports unavailable and the walk **continues to the next route**. Prove
  this red first — on a model-blind `isAvailable()` the walk stops at the absent model, which is
  the whole defect.
- ~~**A pinned route is still gated (§3.3):** a task pin naming a non-local route under
  `enforce_air_gap = true` is skipped, not honoured.~~ **Not written, because the pin stage it
  would cover does not exist in slice 1** (see the §3.3 correction). This test moves to slice 4 and
  must land in the same change as the pin stage itself — a gate and the path it guards are not
  separable work.
- **`routeId` slash handling (§3.1):** a model name containing slashes (`hf.co/user/model`, a
  `.gguf` path) round-trips through `route_priority` parsing; an unresolvable entry is warn-logged
  **by name** and dropped (it does not raise — see the §3.1 correction), and the rest of `[llm]`,
  `enforce_air_gap` included, survives it.
- **Lifecycle by `providerId` (§3.5):** `pullModel("ollama", "a-model-with-no-route")` succeeds.
  This is the case that keying on `routeId` would break.
- **Two llama.cpp routes on one `base_url`** are dropped (first wins) and named in the warn log,
  at assembly rather than at parse — same correction as above. Likewise two entries deriving the
  same `<runtime>/<model>` route id.
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

   **Tabular, with the exact columns deferred to implementation**, but two constraints on them:
   `contextWindow` is frequently `undefined` (it is why `meetsCapabilityFloor` fail-opens), so that
   column renders `—` and never a fabricated default; and a single availability column collapses
   two states with different fixes, so "daemon unreachable" and "model not pulled" (§3.4) must be
   distinguishable. A sketch, not a contract:

   ```text
   ROUTE ID       PROVIDER  MODEL       LOCAL  AVAILABLE            CONTEXT
   ollama/qwen3   ollama    qwen3:8b    yes    yes                  8192
   ollama/gemma   ollama    gemma3:12b  yes    no (model not pulled) —
   ```

3. **Consent posture — carried to slice 2, unresolved here, and it does not block slice 1**
   (slice 1 opens no new egress path). The working assumption to confirm before any vendor lands:
   *configuration is consent; there is no per-call HITL on inference*, on the precedent that
   `openai.api_key` already sends indexed prose to OpenAI for embeddings with no prompt, and
   because per-call approval would make agent briefs unusable. **One thing should change about
   that precedent:** today embeddings route remote the moment a key exists. A capability that turns
   itself on as a side effect of a credential being present is the same shape as the air-gap defect
   (#1334) — so enabling a remote vendor must require an explicit opt-in flag, never be inferred
   from key presence.

   **Shape of that flag, answering the review's question:** `enabled = false` by default inside
   each `[llm.remote.<vendor>]` table, matching the `[briefs]` and `[code_execution]` default-off
   precedent — a per-vendor switch rather than one global remote toggle, so enabling Gemini does
   not silently enable Bedrock because an `aws.*` credential happened to be present for a
   connector. Confirm when slice 2 is specced; recorded here so it is not re-litigated.

4. **Slice 2 is blocked on the `LlmRouter.generate()` coverage question** in §4.1 — extend I29's
   `model` class to cover it, or document precisely what it excludes. Not optional, and not
   deferrable past the first remote route.

---

## 8. Decomposition

| Slice | Content | Status |
| --- | --- | --- |
| **1. Model routes** | This document. `(provider, model)` routes, one definition of `isLocal`, vendor-named egress destination, and a route-walked (still **un-ledgered** — see §4.1) overflow fallback. Ships multi-local-model routing and **zero** cloud vendors. | approved, planning next |
| **2. Bearer-key clouds** | Anthropic, OpenAI, Gemini, xAI. One adapter shape, four configs, four Vault keys, the explicit opt-in flag from Open decision 3, and the `D`-rule promotion from Open decision 1. First slice where an `egress_ledger` `model` row is ever written. **Blocked on resolving `LlmRouter.generate()`'s I29 coverage (§4.1) before the first remote route registers.** | not started |
| **3. Bedrock** | SigV4 signing, region, static creds *or* profile/role chain. Kept separate because it shares no auth shape with slice 2; reuses the `aws.*` credential fields connectors already have. | not started |
| **4. Selection surface** | `[llm.tasks]` per-task pinning, `nimbus llm use <vendor>/<model>` writing to `llm_task_defaults`, full `nimbus llm status`. **A ROUTER change, not the surface-only change originally promised:** slice 1 did not build the task-pin resolution stage (§3.3 correction), so slice 4 adds it to `orderedRoutes` — together with the §6 test that a pin is still gated by air-gap. | not started |

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
