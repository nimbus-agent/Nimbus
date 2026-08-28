# LLM Model Routes — Slice 2: Bearer-Key Clouds

**Date:** 2026-08-28
**Status:** designed — not started
**Slot:** Spine S2 — Local Compute Fleet, row *"bring-your-own-frontier-model routing with local fallback"*
**Slice:** 2 of 4 — see [slice 1's decomposition](./2026-08-27-llm-model-routes-design.md#8-decomposition)
**Predecessor:** slice 1 delivered as PR #1352 (`5ac042c0`, `feat(llm)!`, `v4.0.0`)

Slice 1 is the binding authority for everything it decided. This document decides only what
slice 2 adds, and — where investigation contradicted slice 1's forward-looking prose — says so
explicitly rather than quietly diverging. Those corrections are in §2.

---

## 1. Problem

Slice 1 re-keyed `LlmRouter` from one-seat-per-provider-kind onto `(provider, model)` routes and
shipped **zero** cloud vendors, deliberately: it fixed two correctness gaps while no remote route
existed to exercise either one. Slice 2 registers the first ones — Anthropic, OpenAI, Gemini, xAI —
and is therefore the first slice in the product's history where an `egress_ledger` row with
`source_type = 'model'` is written against a real vendor.

Three things block that first registration. Slice 1's §7 named them; investigation while designing
this slice found the first one materially understated and the second one incomplete.

---

## 2. What investigation changed

### 2.1 `LlmRouter.generate()` is not the chokepoint — CORRECTION to slice 1 §4.1

Slice 1 §4.1 says the un-ledgered surface is `LlmRouter.generate()`, "whose callers are
`engine/run-ask.ts`, `briefs/brief-llm-adapter.ts`, `glossary/glossary-llm-adapter.ts` and
`decisions/decision-llm-adapter.ts`". Grepping every `generate(` in `packages/gateway/src` shows
that list is wrong in both directions:

| Path | Actually calls | Can reach a remote provider? |
| --- | --- | --- |
| `engine/run-conversational-agent.ts:153` | `llmRouter.generate()` | **yes** — the only `router.generate()` caller in production |
| `briefs/brief-llm-adapter.ts:22` | `selectProvider()` then `provider.generate()` | **yes** — has an explicit remote arm, honours `[briefs] prefer_local` |
| `glossary/glossary-llm-adapter.ts:45` | `selectProvider()` then `provider.generate()` | no — `if (!provider.isLocal) return null` |
| `decisions/decision-llm-adapter.ts:160` | `selectProvider()` then `provider.generate()` | no — same guard |
| `llm/router.ts:182` (`generateMarkdown`) | `route.provider.generate()` | yes — ledgered today at the synthesis call site |

`engine/run-ask.ts` calls neither; it reads `prefersLocal()` / `enforcesAirGap()` and delegates.

So appending inside `LlmRouter.generate()` would cover **one** of the two unledgered remote paths
and leave `brief-llm-adapter.ts` — the path whose own doc comment calls source-text egress "the
most privacy-sensitive thing this feature does" — shipping silent. `LlmRouter.generate()` is one
caller among several. `provider.generate()` is the chokepoint.

### 2.2 There is a fifth remote-inference path, outside `LlmRouter` entirely

`gateway-main.ts:102` constructs the Mastra engine agent unconditionally. Its model comes from
`getEffectiveAgentModel()` then `HARDCODED_AGENT_MODEL_DEFAULT = "claude-sonnet-4-6"`
(`config.ts:71`), which `toMastraModelId` (`engine/agent.ts:85`) rewrites to
`anthropic/claude-sonnet-4-6`. `@mastra/core` resolves that string with its own client, its own
key lookup, and its own streaming. It never touches `LlmRouter`, `LlmProvider`, `isLocal`, or the
ledger.

`runTurn` (`run-conversational-agent.ts:202`) reaches it two ways:

1. `prefer_local = false` — the shipped default — sends every `nimbus ask` turn there directly.
2. Under `prefer_local = true`, the local router is tried first, and its `catch` **falls back to
   the agent** with no further gate.

### 2.3 Path 2 is a live air-gap bypass

Traced in full, because "air-gap is enforced somewhere in this file" is not the same claim as
"air-gap is enforced on this branch":

- `enforce_air_gap = true` **plus `prefer_local = false`** — `classifyIntent` throws
  `GatewayAgentUnavailableError{reason:"air_gap"}` (`engine/router.ts:223`), and
  `run-ask.ts:239`'s catch **rethrows** because `prefersLocal()` is false. The ask errors out.
  Safe — but by accident, via the classifier, not by any decision about generation.
- `enforce_air_gap = true` **plus `prefer_local = true`** — classification falls back to local
  indexed context, `runTurn` selects the local router, and **if the local router throws**,
  `run-conversational-agent.ts:211-216` catches, warn-logs `"local LLM router failed; falling back
  to agent"`, and runs the Mastra agent against Anthropic. No air-gap check exists on that branch.
  No `egress_ledger` row is appended. `nimbus prove` reports `model=per-call` with zero rows.

`enforce_air_gap` is a REFUSAL setting (`llm/router.ts` `enforcesAirGap`'s doc comment argues that
distinction at length). A local model dying mid-turn silently downgrading to a cloud vendor is
the #1334 shape — a documented promise that a legacy path beside the correct one does not keep.

Pre-existing, not caused by slice 1 or slice 2. But slice 2 is where "the ledger covers model
egress" becomes a claim, so it is fixed here rather than named and left.

### 2.4 Smaller findings, folded in

- `egress/egress-coverage.ts:88` still documents the `model` class as "enforced INSIDE the appender
  via a required `remote` argument". Slice 1 replaced that argument with derivation from
  `provider.isLocal`. Doc drift; corrected here.
- `openai.api_key` already exists and is read at `embedding/create-embedding-runtime.ts:58`, but
  appears in **neither** `CONNECTOR_VAULT_SECRET_KEYS` nor `PLATFORM_VAULT_KEYS`
  (`scripts/structure-audit/check-nimbus-invariants.ts`). Slice 2's keys close that gap alongside
  their own registration.
- `buildLlmRegistryFromToml` (`platform/assemble.ts:1485`) is synchronous and takes no Vault. Its
  single caller (`assemble.ts:2601`) is already `async` with `vault` in scope, so this is a
  signature change, not a plumbing problem.
- `LlmRegistry` already holds `this.db` (`llm/registry.ts`), so the wrapper needs no new
  constructor argument.

---

## 3. Goals / Non-goals

**Goals**

- Close I29's `model` coverage gap at a real chokepoint, so **every** non-local route is ledgered
  by construction rather than by each caller remembering.
- Close the air-gap bypass in `runTurn`.
- Bring the Mastra engine agent under both the ledger and air-gap, and onto the same opt-in and
  credential path as the routes.
- Register the first four cloud vendors behind a per-vendor, default-off opt-in.
- Pin locality declaration so a cloud adapter cannot claim to be local.

**Non-goals**

- Bedrock / SigV4 — slice 3.
- `[llm.tasks]` per-task pinning and `nimbus llm use` — slice 4, which is a router change (slice 1
  did not build the pin stage).
- Making the Mastra agent literally call `LlmProvider.generate()`. See §6.3 — it is not achievable
  without killing tool-calling, and the property being sought is achieved another way.
- An embeddings appender. `PROSE_HEAVY_TYPES` still routes to OpenAI with no ledger row; that
  exclusion survives slice 2 unchanged and stays documented as such.
- Any per-call HITL on inference. Confirmed, not re-litigated — see §9 decision 1.
- **A local OpenAI-compatible runtime** (LM Studio, LocalAI, llamafile). Unsupported today —
  `KNOWN_LOCAL_RUNTIMES` (`platform/assemble.ts:1301`) admits only `"ollama"` and `"llamacpp"`, and
  anything else is warn-logged and dropped — and still unsupported after slice 2. Deferred
  deliberately, not overlooked. The shape it would take is cheap once §7.3 exists:
  `runtime = "openai-compatible"` under `[llm.local.<name>]`, reusing `openai-provider.ts`'s
  request/response mapping with locality **derived** from `base_url` like the other local runtimes.
  It is deferred because that derived rule is the *inverse* of the hardcoded `isLocal = false` the
  four cloud adapters carry in the same PR, and §7.4 already flags that pair as the easiest thing
  in this slice to get backwards. Shipping four adapters under one uniform locality rule, then
  adding the inverted one where it gets its own attention and its own I34 test row, is the safer
  order. Slice 3 or 4.

---

## 4. Delivery order — two PRs, and the order is load-bearing

Slice 1 §4.1 is explicit: the coverage fix must be provably in place — **wiring, docs, and
enforcement test** — *before* a remote route can be registered by any code path, "not merely before
it is expected to be exercised". Landing vendors in the same PR as the coverage fix is the wrong
order.

| PR | Content | Vendors registered |
| --- | --- | --- |
| **2a — coverage** | `wrapLedgeredProvider` chokepoint (§5), the `egressMethod` field, deletion of the synthesis call-site append, the D-rule promotion, invariant **I34** (§8), the air-gap bypass fix (§6.1), all I29 doc updates | **zero** |
| **2b — vendors** | `[llm.remote.<vendor>]` config plus four Vault keys (§7), four adapters (§7.3), the Mastra unification (§6.2–6.3), `nimbus llm status` columns (§10) | four |

PR 2a is provable the same way slice 1 proved its §4.2 fix: against a fake `isLocal: false`
provider registered in-test. That is an honest bound, stated rather than implied — 2a ships no
end-to-end demonstration, because there is deliberately nothing remote to demonstrate against.

---

## 5. The chokepoint (PR 2a)

### 5.1 Wrap at registration

```ts
// llm/registry.ts
addRoute(provider: LlmProvider, modelName: string, meta?: ProviderMeta): void {
  this.router.registerRoute(wrapLedgeredProvider(this.db, provider), modelName, meta ?? {});
}
```

`wrapLedgeredProvider(db, provider)`:

- returns `provider` **unchanged** when `provider.isLocal` — the locality decision is DERIVED
  inside the wrapper from the provider instance, never accepted as an argument. This is the same
  property `recordSynthesisEgress` documents at length and for the same reason: a caller-supplied
  boolean is unverifiable at the append site, and getting it wrong writes a false zero into the
  ledger `nimbus prove` reports on;
- otherwise returns a decorator whose `generate()` appends exactly one `egress_ledger` row and
  then delegates;
- **fail-closed**: an append that throws propagates as `EgressAppendFailedError` and the delegate
  is never called. Ledger-then-act, never act-then-ledger;
- passes `isAvailable`, `listModels` and `pullModel` through untouched. Availability is not
  egress — and for cloud adapters it makes no network call at all (§7.4).

### 5.2 Why registration, not the router method

Wrapping the provider instance covers, by construction and without any caller cooperation:
`LlmRouter.generate()`, `generateMarkdown()`, every `selectProvider()` then `provider.generate()`
caller including `brief-llm-adapter.ts`, and every caller added later. The alternative — targeted
appends at the two paths that can go remote today — is caller-enforced coverage, which is exactly
the weakness `egress/synthesis-egress.ts`'s own doc comment argues against, and which leaves a
sixth call site silent by default rather than covered by default.

The shape is not new: it is `wrapServerSpec()` then sandbox (I15 / static D10) applied to a
different seam.

### 5.3 The D-rule (Open decision 1's promotion)

`LlmRouter.registerRoute` stays public but is **confined by static rule to `llm/registry.ts`**,
mirroring D22's confinement of the literal `connectors.dispatch` to `executor.ts`. Slice 1 deferred
this promotion on the grounds that "at two members a static rule has almost no teeth"; slice 2
takes it to seven (four cloud adapters, two local runtimes, the Mastra decorator).

Written as **what cannot pass**, not as an allow-list of known-good spellings — an allow-list guard
fails silently when a new spelling appears.

### 5.4 Reconciling with the existing synthesis append

`synthesis-llm.ts` appends today at its call site. Left alone, a synthesized brief would produce
**two** rows — corrupting exactly the counts this subsystem exists to make trustworthy.

Resolution: the wrapper becomes the sole appender.

- `egress/synthesis-egress.ts` `recordSynthesisEgress` is **deleted**; its body and its entire
  doc-comment rationale move into `wrapLedgeredProvider`. The rationale is the valuable part and
  must not be lost in the move.
- `SynthesisLlmDeps.recordEgress` (the DI seam) and `SynthesisEgressRecorder` are deleted with it.
- `LlmGenerateOptions` gains **one optional field**, `egressMethod?: string`, so the ledger keeps
  its per-brief fidelity:

  | Caller | `method` column |
  | --- | --- |
  | `synthesis-llm.ts` | `agents.<briefKind>.synthesis` (passed explicitly) |
  | everything else | `llm.generate.<task>` (derived from `opts.task`) |

  Without it, every model row would read `llm.generate.reasoning` and `nimbus prove` could no
  longer say which brief sent what — a regression in the ledger's usefulness, traded for a smaller
  diff. Not worth it.
- The distinct `SynthesisAttempt.reason = "egress_append_failed"` outcome is preserved by having
  the wrapper throw a typed `EgressAppendFailedError` that `synthesis-llm.ts` catches and maps.
  Without that mapping the reason silently collapses into `provider_error` — and `detail` travels
  to the user on the `briefReady` notification as `SynthesisProvenance`, so the two are kept apart
  for the same reason `timeout` and `provider_error` already are.

**Bound worth stating:** `generateMarkdown` currently calls
`route.provider.generate({ task: "reasoning", prompt })` and must be widened to forward
`egressMethod`. That is the one place the new field is not simply passed through from a caller's
own options object.

---

## 6. The two engine-agent changes

### 6.1 The air-gap bypass fix (PR 2a)

```ts
// engine/run-conversational-agent.ts, runTurn()
catch (e) {
  if (p.agent === undefined) throw e;
  if (llmRouter.enforcesAirGap()) throw e;   // NEW
  conversationalLog.warn({ err: e }, "local LLM router failed; falling back to agent");
}
```

Under air-gap, a failed local router surfaces the failure rather than downgrading to a cloud
vendor. Ships in 2a, ahead of the vendors, because it is a live bug today.

### 6.2 Unifying the agent onto `[llm.remote.*]` (PR 2b)

`createNimbusEngineAgent` stops reading `getEffectiveAgentModel()` and takes a resolved
`{ providerId, modelId, apiKey }` derived from the same `[llm.remote.<vendor>]` table the routes
use. Consequences:

- **`enabled = false` means no remote inference anywhere.** Without this, the per-vendor opt-in
  would have a hole exactly the size of the default `nimbus ask`, because `@mastra/core` resolves
  `ANTHROPIC_API_KEY` from the environment on its own. A capability that turns itself on because a
  credential happens to exist is the air-gap defect's shape, one level up.
- When no vendor is enabled, the agent is **not constructed at all** — `gateway-main.ts:102`
  becomes conditional and `resolveEngineAgent` returns `undefined`. `runTurn` and `runViaAgent`
  already handle `p.agent === undefined` on every branch, so no new failure mode is introduced.
- `NIMBUS_AGENT_MODEL` / `[llm] remote_model` keep working as a model-name override within the
  enabled vendor, so no existing config breaks silently. `applyLlmTomlOverrides` stays.

### 6.3 The ledger seam for the agent (PR 2b)

`MastraModelConfig` (`@mastra/core/dist/llm/model/shared.types.d.ts`) accepts a
`LanguageModelV2 | V3 | V4` **object**, not only a router-id string, and
`ModelRouterLanguageModel` — which `implements MastraLanguageModelV2` — is publicly exported from
`@mastra/core/llm`. So:

```ts
const inner = new ModelRouterLanguageModel({ id: routerId, apiKey });
new Agent({ model: wrapLedgeredMastraModel(db, inner, { providerId, modelId }) });
```

The decorator intercepts `doGenerate` / `doStream` only. Mastra keeps its own client, tool-calling
and streaming — including the three negation tools, which live on the Mastra agent and not on the
router path. No new `@ai-sdk/*` dependency, no private API, no async construction.

**This does not make Mastra call `LlmProvider.generate()`, and cannot.** `llm/types.ts` contains no
`tools` field on `LlmGenerateOptions` — verified by grep, zero occurrences — so an adapter built
over `LlmProvider` would silently kill the agent's tool-calling. The property sought — one ledger,
air-gap honoured, one opt-in — is achieved at the AI-SDK seam instead. Stated plainly because the
shorter phrase "route Mastra through the ledger" invites the wrong implementation.

**Accepted cost, stated rather than hidden:** after 2b there are two HTTP clients for Anthropic —
`llm/anthropic-provider.ts` for the route table, and Mastra's own for the agent. That asymmetry is
real and is the price of keeping tool-calling. It is honest rather than accidental: the agent loop
is Mastra's, so its wire is Mastra's; the route table is ours, so its wire is ours. Both are
ledgered by their respective wrappers.

**`ModelRouterLanguageModel` is public API, not an internal type.** It is exported from
`@mastra/core/llm` (`dist/llm/index.d.ts:39`), the same public entry point the codebase already
imports `Agent` and `createTool` from. Recorded because an upgrade-fragility objection to this
design rests on it being a deep internal import, and it is not.

**Escape hatch if §6.3's verification fails.** If `{ id, apiKey }` forces an OpenAI-compatible wire
format for Anthropic, or if the metadata-fetch traffic proves unacceptable, the fallback is our own
`LanguageModelV4` adapter written **directly against the vendor HTTP APIs** — not over
`LlmProvider`, for the tools reason above. That is materially more work (the full V4 contract:
streaming parts, tool calls, tool results, finish reasons, usage accounting, per vendor — in effect
reimplementing `@ai-sdk/anthropic`), which is why it is the fallback and not the plan. If it is
reached, it is re-specced, not improvised.

**Two things to verify at implementation time, not assume:**

1. That `{ id: "anthropic/…", apiKey }` resolves through Mastra's provider registry rather than
   forcing an OpenAI-compatible wire format. `OpenAICompatibleConfig` is the type's name; the
   `resolveModelConfig` docstring shows `{ id: "openai/gpt-4o", apiKey: "sk-…" }` as a supported
   config-object form, which suggests the name is broader than the shape, but that is inference,
   not verification.
2. Whether `ModelRouterLanguageModel._fetchSupportedUrls` issues a network request. The registry
   also exports `isOfflineMode()`, which implies some paths do. If it does, that traffic is
   invisible to the decorator and becomes a **named I29 exclusion in the docs** — Mastra metadata
   egress the ledger cannot see. It must not be left unstated either way.

### 6.4 Generate-time route fallback (PR 2b) — a gap §7.4 creates

`LlmRouter.generate()` today resolves one route and calls it:

```ts
const route = await this.selectRoute(opts.task);
const adjusted = await this.fitPromptOrFallback(opts, route);
return route.provider.generate(adjusted.opts);
```

There is **no try/catch and no retry** — verified. `firstAvailableRoute` skips routes whose
*availability probe* says unavailable; nothing reacts to a *generation* that throws.

For local routes that was tolerable, because the probe genuinely predicts reachability. §7.4 breaks
that link for remote routes on purpose: availability is answered offline, so a route reports
available whenever it is enabled and keyed, whatever the network is doing. A user with
`route_priority = ["anthropic/claude-sonnet-4-6", "ollama/qwen3"]` and no internet therefore gets a
hard failure rather than falling through to the local model — while the S2 roadmap row this slice
serves promises "bring-your-own-frontier-model routing **with local fallback**". Shipping the
promise without the behaviour is the failure mode this project treats most seriously.

This is the same shape as slice 1's §3.4: a fail-open created by the very change that introduces
the walk, and therefore closed by the slice that creates it.

**Rule, deliberately narrow.** On a failed `generate()`, continue the priority walk to the next
route that passes the same gates — but only for a **transport-class** failure (connection refused,
DNS, timeout, 5xx, 429). An **auth- or request-class** failure (401, 403, 400, model-not-found)
does not retry: a bad key or a malformed request will fail identically on the next vendor, so
retrying only sends the same prompt to a second destination for nothing. Classification lives with
each adapter, which is the only layer that can read a vendor's status codes.

**Two consequences to state rather than discover:**

- **One prompt can produce N ledger rows across N destinations.** That is correct and must not be
  "deduplicated" — each row records a real outbound request, and a ledger that collapsed them
  would under-report egress. The wrapper produces this naturally, one row per attempt.
- **Under `prefer_local = true` with air-gap OFF, a failing local route can now fall through to a
  remote one.** That is already true today by a different door — `runTurn` catches a router failure
  and falls back to the Mastra agent — but the walk makes it a routing decision rather than an
  accident, so it is ledgered and visible in `nimbus llm status`. Under air-gap the walk excludes
  every non-local route, unchanged, and §6.1 closes the Mastra door.

**Alternative considered and rejected:** deferring this to slice 4, which already reopens
`orderedRoutes` for the pin stage. Rejected because it would ship the first four cloud vendors with
the roadmap row's headline property missing, and a claim that outruns the behaviour is worse than a
later slice being slightly larger.

---

## 7. Vendors (PR 2b)

### 7.1 Config

```toml
[llm.remote.anthropic]
enabled  = false                          # DEFAULT. Never inferred from key presence.
model    = "claude-sonnet-4-6"
base_url = "https://api.anthropic.com"    # optional; a proxy does NOT make it local
```

One table per vendor — `anthropic`, `openai`, `gemini`, `xai` — reusing the dynamic sub-table
machinery `[llm.local.<name>]` already uses. Per-vendor rather than one global remote toggle, so
enabling Gemini cannot silently enable another vendor because an unrelated credential exists.

Validation lives in `platform/assemble.ts` **after** the parse, never in the parser: a throw inside
the `[llm]` parser is swallowed by `loadTomlSection`'s bare catch and silently reverts the WHOLE
section to defaults, `enforce_air_gap` included. Unknown vendor id, `enabled = true` with no
resolvable key, empty model — warn-log **by name**, drop that vendor, boot continues. An entry
that vanishes without a word is the shape slice 1's `dropUnresolvableRoutePriorityEntries`
refuses to allow.

**Validation runs AFTER defaults are applied, and that is deliberate — do not "fix" it earlier.**
The instinct is to validate the raw parsed table before defaults so a vendor-specific problem can
be isolated. That instinct moves validation *toward* the parser, which is the hazard: the closer it
gets, the closer a throw gets to `loadTomlSection`'s bare catch, and the outcome of tripping that
catch is not a dropped vendor but a silently reverted `[llm]` section with `enforce_air_gap` back
at its `false` default. Post-default validation loses nothing here, because no field this slice
adds needs absent-versus-explicit discrimination: an absent `enabled` and an explicit
`enabled = false` mean the same thing. Slice 1 hit exactly this with `local_model = ""` and solved
it the same way — check the post-default value in `assemble.ts`, warn by name, keep the default,
carry on (`platform/assemble.ts:1506-1520`).

### 7.2 Vault

`anthropic.api_key`, `openai.api_key`, `gemini.api_key`, `xai.api_key` join `PLATFORM_VAULT_KEYS`;
the single file that reads them joins `VAULT_KEY_ALLOW_LIST`. No key ever reaches logs, IPC, or
config (Non-Negotiable #3).

`openai.api_key` is deliberately **reused** from the embedding runtime — same credential, same
vendor, and a second key for one vendor invites drift. It is also the sharpest available test of
the opt-in: an existing embeddings user already has that key present, so `enabled = false` must
still produce zero chat calls. That case gets its own test (§11).

`buildLlmRegistryFromToml` becomes `async` and takes the vault.

### 7.3 Adapters

Four `LlmProvider` implementations in the shape `OllamaProvider` / `LlamaCppProvider` already have
— three wire formats, since xAI is OpenAI-compatible:

| File | Endpoint |
| --- | --- |
| `llm/anthropic-provider.ts` | `POST /v1/messages` |
| `llm/openai-provider.ts` | `POST /v1/chat/completions` |
| `llm/xai-provider.ts` | same shape, different base URL — reuses the OpenAI request/response mapping |
| `llm/gemini-provider.ts` | `POST /v1beta/models/{model}:generateContent` |

Every byte that leaves is our code, so the ledger cannot be silent about a call nobody wrote. The
key is injected as `() => Promise<string | undefined>`, resolved per call and read from the Vault —
**never from the environment**, so no env var can satisfy a vendor that was not opted into. A key
added after boot works without a restart.

### 7.4 `isLocal` and availability

**Cloud adapters hardcode `readonly isLocal = false`. They do NOT derive it from `base_url`.**

This is the inverse of slice 1's fix and is easy to get backwards. Slice 1 derives locality for
*local runtimes* because an Ollama or llama.cpp base URL can legitimately point at a LAN box, and a
hardcoded `true` there defeated air-gap. But pointing the Anthropic adapter at
`http://127.0.0.1:4000` — a LiteLLM-style proxy — does not make the traffic local; the proxy
forwards to Anthropic. Deriving locality there would hand back the exact bypass slice 1 closed,
through the opposite door. Pinned by I34 (§8).

**Availability is answered offline.** `isAvailable()` returns `enabled && key present`; no network
call. A vendor `/models` probe on every `nimbus llm status` would be real, un-ledgered egress to
four vendors *before the user ever opted into sending a prompt*, and would leak Nimbus usage to
each of them. `listModels()` returns the configured model statically.

**Honest bound:** this reopens §3.4's fail-open for remote routes only. A typo'd model name reports
available, the priority walk stops there, and the call fails at `generate()`. Accepted, because the
only fix costs network egress that contradicts a larger promise. `RouteAvailability.reason` gains a
third member, `not_configured` (enabled, but no key resolvable), so `nimbus llm status` still sends
the user to the right remedy rather than collapsing three different fixes into "unavailable".

---

## 8. Invariant I34 — locality-declaration integrity (PR 2a)

**Decision: I34 lands with slice 2.** This reverses the position taken in PR #1352's review
thread, where a numbered row for locality was declined on the grounds that air-gap always depended
on a locality predicate, that `LOCAL_PROVIDER_IDS` had no row either, and that slice 1 therefore
strengthened the property rather than weakening it.

That argument was right for slice 1 and weakens on exactly the axis slice 2 moves:

- The number of sites where locality can be declared wrong goes from **two to seven** — four cloud
  adapters, two local runtimes, the Mastra decorator.
- The mistake is one word, and it is silent in both directions that matter: a wrong `isLocal: true`
  defeats `enforce_air_gap` **and** writes a false zero into the ledger.
- Blocker 2 requires the pinned test regardless, so two-thirds of the triple lands either way.
  Only the docs row is incremental cost.

**Scope, kept narrow so it does not overlap I29:** I34 is about the *declaration* — the field both
air-gap and the I29 appender read. I29's `model` class extends to name the wrapper chokepoint. Two
rows, one job each.

- **Wiring:** `llm/base-url-locality.ts` `isLoopbackBaseUrl` for the two local runtimes; the
  literal `false` on each cloud adapter; the wrapper deriving from `provider.isLocal`.
- **Docs:** a row in `docs/SECURITY-INVARIANTS.md`, plus the CLAUDE.md / GEMINI.md list.
- **Test:** every registered adapter's `isLocal` matches its class — cloud adapters are `false`
  unconditionally including when constructed with a loopback `base_url`; local runtimes track
  `isLoopbackBaseUrl`.

I28 remains reserved and undisturbed; I34 takes the next free number above the I33 ceiling.

---

## 9. Open decisions, resolved

1. **Consent posture — confirmed, as slice 1's Open decision 3 anticipated.** Configuration is
   consent; there is no per-call HITL on inference. Precedent: `openai.api_key` already sends
   indexed prose to OpenAI for embeddings with no prompt, and per-call approval would make agent
   briefs unusable. The one change slice 1 asked for is delivered: enablement is an explicit
   per-vendor `enabled = false` default, never inferred from key presence.
2. **Opt-in shape — per-vendor `enabled` inside `[llm.remote.<vendor>]`**, matching `[briefs]` and
   `[code_execution]`'s default-off precedent. Settled in slice 1; recorded here so it is not
   re-litigated.
3. **The D-rule promotion — lands in 2a** (§5.3).
4. **I34 — lands in 2a** (§8).

---

## 10. Surface

`nimbus llm status` gains a `LOCAL` column and the `not_configured` availability state.
`contextWindow` still renders an em dash and never a fabricated default.

**Inherited bound, partially closed.** `packages/cli` keeps a PRIVATE copy of the route-status
type — a shared type is forbidden by the IPC-only dependency rule — and nothing pins that copy to
the gateway payload. This has already broken `nimbus llm status` once with the whole suite green,
because CLI tests mock the IPC client wholesale. Slice 2 adds a **structural shape-parity test**
asserting the CLI's copy matches the gateway's `LlmRouteStatus` field-for-field. That closes the
drift without introducing a shared type. It does not make the CLI tests exercise a real payload;
that bound survives.

No `ALLOWED_METHODS` change — slice 2 adds no renderer-exposed IPC method, so the I7 count
assertion is untouched. Response shapes for `llm.getRouterStatus` and `llm.listModels` do change,
so `packages/ui` consumers need checking explicitly: the renderer talks JSON-RPC, so no TypeScript
error crosses that boundary.

---

## 11. Testing

Red-prove by **reverting the specific mechanism**, never by observing a green suite. Slice 1
shipped eight tests that could not fail; a green run proves nothing about a guard.

- **The wrapper (2a):** delete `wrapLedgeredProvider` from `addRoute` — a fake `isLocal: false`
  provider's `generate()` appends zero rows. Assert the row's `destination` is the `providerId`
  and its `method` is `agents.<kind>.synthesis` for the synthesis path.
- **Fail-closed (2a):** an appender that throws — the delegate is called **zero** times, and
  `synthesis-llm.ts` reports `egress_append_failed`, not `provider_error`.
- **No double-append (2a):** one synthesized brief, invoked over the local socket, produces exactly
  one row.
- **Two rows, two classes, when invoked externally (2a):** a brief requested over HTTP
  (`POST /v1/agents/{agent}`) or MCP and synthesized by a non-local provider produces **two** rows
  — one `http`/`mcp` row from `recordAgentBriefEgress` (`egress/agent-brief-egress.ts:36`, called
  at `ipc/agents-rpc.ts:1033`) for the inbound request, and one `model` row from the wrapper for
  the outbound generation. They are distinguished by `source_type` and by `method`
  (`agents.<kind>.synthesis` on the model row). This is not double-appending: they record two
  different events, and a test that only counted rows would read them as one bug and the real
  double-append as correct.
- **Local is untouched (2a):** a local provider is returned unwrapped and appends nothing — not
  even a blocked row, mirroring `LOCAL_ONLY_SYNC_SERVICES`.
- **The air-gap bypass (2a):** revert the guard. Air-gap on, `prefer_local` on, local router made
  to throw — assert the Mastra agent is invoked **`calls === 0`**. Asserting "an error is
  returned" is not the same test; #1334's lesson is to count the calls.
- **The opt-in (2b):** `enabled = false` with BOTH `OPENAI_API_KEY` in the environment and
  `openai.api_key` in the Vault — zero routes registered, zero calls, no agent constructed.
- **Locality (2b, I34):** each cloud adapter constructed with `base_url = "http://127.0.0.1:4000"`
  still reports `isLocal === false`; flipping one to `true` fails the I34 test.
- **Config (2b):** `[llm.remote.*]` round-trip; an unknown vendor / keyless-enabled / empty-model
  entry is warn-logged by name and dropped while the rest of `[llm]` — `enforce_air_gap`
  especially — survives.
- **Status (2b):** `not_configured` is distinguishable from `provider_unreachable` and
  `model_absent`; the CLI shape-parity test.
- **Generate-time fallback (2b, §6.4):** a remote route whose `generate()` throws a transport-class
  error falls through to the next route and the call succeeds; a 401 does **not** fall through and
  the call fails at the first route. Assert the ledger holds one row per attempt — two rows for
  the transport case, one for the 401 — since a test that asserted "exactly one row per prompt"
  would encode the under-reporting bug as the expected behaviour.

Coverage: `llm/` sits under the Engine 85% gate. `audit:coverage-floor` is CI-Linux-authoritative —
verify with `verify:docker --changed`, not a local run.

**Gating.** `bun test packages/gateway packages/cli scripts` exceeds the 600s subagent tool cap and
therefore cannot gate a delegated task. Per-task gating is `typecheck` plus `typecheck:tests`
(advisory on win32, Linux-authoritative) plus scoped tests plus `bun test packages/gateway/test` —
a `src` run never loads that tree. The wide suite is run directly after any change to
`wrapLedgeredProvider`, `LlmGenerateOptions`, or `RouteAvailability`, all of which are widely
consumed. Slice 1 deferred a 10-test regression across 5 files by 5 tasks by skipping this.

---

## 12. Docs

These change **together**, in the same commit as their wiring — the triple rule, and the
"correct a claim at every restatement" rule:

- `docs/SECURITY-INVARIANTS.md` — I29's `model` class widened to the wrapper chokepoint; new I34
  row; the Mastra metadata exclusion if §6.3's verification finds one.
- `CLAUDE.md` plus `GEMINI.md` — the I29 line, the new I34 line, the invariant-ceiling sentence
  ("Invariants through I33 (I28 reserved)"), and the S2 status paragraph, which currently says
  `packages/gateway/src/llm/` "ships only `OllamaProvider` and `LlamaCppProvider` today, so the I29
  `model` egress class is wired but appends zero rows in production". That stops being true in 2b.
- `egress/egress-coverage.ts` lines 82-95 — the `model` class docstring, including the §2.4 drift.
- `packages/cli/src/commands/prove.ts:62` — the scope label, currently `"remotely-synthesized agent
  briefs"`, widens to name the route table and the engine agent.
- `docs/CHANGELOG.md`, `docs/roadmap.md`, `docs/architecture.md`, `docs/cli-reference.md`.

Before pushing anything under `docs/`: `bun run lint:markdown` **and**
`grep -rn "file:///" --include=*.md docs/`. Absolute `file:///` links pass locally and fail lychee
on CI. Both bit slice 1.

---

## 13. Risks

- **`egressMethod` is a new field on a widely-passed options type.** `bun` does not typecheck at
  runtime, so a green test run says nothing; `typecheck` and `typecheck:tests` are both required,
  and the latter exits 0 on win32 while printing violations. Verify in Docker.
- **Mastra's internals are not ours.** §6.3's two verification items are the ones most likely to
  change this design mid-implementation. If `{ id, apiKey }` forces an OpenAI-compatible wire
  format for Anthropic, §6.2's unification needs a different mechanism and should be re-specced
  rather than worked around.
- **Deleting `recordSynthesisEgress` touches an I29 site.** The static D22 rules pin
  `appendEgressEntry` to `egress/*`, so `wrapLedgeredProvider` must live under `egress/` — or the
  rule must be widened deliberately, in the same commit, with a reason. Decide at implementation
  time; the file's home is not settled here, only its behaviour.
- **`mock.module` contamination.** Prefer dependency injection; the wrapper takes `db` explicitly
  for exactly this reason.
- **Editor diagnostics in this checkout are frequently stale.** Verify with real commands only.
