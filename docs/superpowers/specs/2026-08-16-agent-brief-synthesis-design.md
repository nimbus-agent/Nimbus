# Agent Brief Synthesis (W6-A0) — Design

**Date:** 2026-08-16
**Status:** IMPLEMENTED — shipped in #1234. This document is the design as agreed; where the
shipped code has since moved past it, `packages/gateway/src/agents/_lib/` is authoritative. Two
known divergences: the honesty guard (`requiredPhrases`) enforces contract survival only for
`negotiate`'s seven nullable lanes today, not for all fourteen brief kinds as the test table
below implies — the rest return an empty requirement set and are follow-up work; and
`recordSynthesisEgress` takes the resolved provider rather than a `remote` boolean.
**Spine slot:** S1 (Local Brain) — the last remaining S1 row, *Answer-quality surfaces*.
**Position:** sub-project **A0** of Phase 7 Wave 6, and a prerequisite for **A1** (`--devil`) and
**A2** (agent personas). A0 ships on its own merits — briefs become readable — independently of
whether A1 or A2 ever land.
**Ships as:** one PR. No migration, no new security invariant, no Tauri allowlist change.
**Plan boundary:** the implementation plan that follows this spec covers **A0 only**. A1 and A2 get
their own spec → plan cycles once A0 has merged, because both depend on whether an LLM is in the
brief path at all — a question A0 answers and neither can assume.

---

## 1. Why this exists

`docs/roadmap.md` Wave 6 specifies four answer-quality surfaces. Each was checked against the tree
before any design work. **Three of the four describe inputs that do not exist as written.**

| Wave 6 claim | Verdict | Evidence |
| --- | --- | --- |
| Devil's-advocate is a "five-line prompt change" | ⚠️ misleading | Two independent prompt sites exist, not one — `engine/agent.ts:460,468,476` (three Mastra `instructions:` literals) and `engine/run-conversational-agent.ts:126` (a separate hardcoded `systemPrompt`). A change at one silently no-ops on the other. |
| Personas extend profiles via `[profile.<name>.persona]` | ❌ wrong shape | `config/profiles.ts` implements profiles as whole-**file** swaps (`nimbus.<name>.toml` plus a `.nimbus-profile` marker). There is no `[profile.<name>]` table to extend. |
| `tool_caution` "affects HITL escalation defaults" | ❌ prohibited | Non-Negotiable #2 — the consent gate "cannot be bypassed or configured away" — and I2's frozen `HITL_REQUIRED_BACKING` set. A config knob that loosens HITL cannot be built. |
| "The structured index already handles negation natively" | ⚠️ true only of raw SQL | `cli/src/commands/query.ts` (200 lines) accepts `--service` / `--type` / `--since` / `--limit` → `index.queryItems`, plus `--sql` → guarded `index.querySql`. **There is no predicate language.** `--negate "pr touches tests"` means inventing one. |

**A0's PR corrects all four rows**, even though it implements none of them. They document one wave,
they were all wrong on the same reading, and splitting the correction across three PRs and two
spine slots would leave the roadmap asserting things the tree contradicts for however long A1, A2
and W6-B take to land. A0 additionally corrects the row this spec exists because of: Wave 6's
agent-facing plan was written against a code path that does not execute (§1.1).

### 1.1 The finding that reshaped this work

Wave 6's agent-facing half was originally scoped as a second prompt variant in
`agents/_lib/synthesize.ts` — one seam reaching all fourteen built-in agents. That seam is real
structurally and **dead operationally**.

`AgentsRpcContext.llm` is optional (`ipc/agents-rpc.ts:57`) and **neither production caller
supplies it**:

- `ipc/server/dispatchers.ts:133` — the socket dispatcher. Passes `db`, `notify`, `configDir`,
  `index`, `selfIdentity`, `caller`. No `llm`.
- `agent-runs/agent-http-invoke.ts:98` — the HTTP dispatcher. Same, and its comment at line 75 says
  so on purpose: *"omitting `llm`, which that path also omits, so an HTTP brief and a socket brief
  are the same"*.

`ipc/agents-rpc.ts:960` defines `dispatchAgentsRpc`; those two are its only non-test callers.
Therefore `ctx.llm` is **always `undefined` in production**, every built-in brief takes the
deterministic path, and `SYNTHESIS_INSTRUCTIONS` never executes. `synthesize.ts` documents a live
confirmation of this: with `[llm].local_model` set, `prefer_local = true`, and Ollama running —
a configuration `nimbus ask` used successfully in the same session — `nimbus why` still emitted the
`DETERMINISTIC_FOOTER`.

**The plumbing is otherwise complete.** `ctx.llm` already threads to every agent
(`agents-rpc.ts:294,305,315,330,449,490,559,639,699,842`), `emit-brief.ts:40` accepts it, and
`emit-brief.ts:59` forwards it to `synthesize`. Exactly fourteen agent modules import
`emitBriefWithSynthesis`; `why-peek.ts` contains no reference to `llm` or synthesis at all, so its
exemption is structural rather than a policy this design has to enforce.

The work is therefore **not** plumbing. It is the policy that plumbing has never needed: which
provider may serve a brief, what leaves the machine when one does, and what stops a generative
rewrite from softening a disclaimer that a downstream reader treats as a contract.

---

## 2. What ships

Populate `llm` at both production callers from **one** factory, and gate what that factory returns
on new configuration. Everything else follows from that.

### 2.1 Configuration

```toml
[agents]
synthesis = "local"   # "off" | "local" | "allow-remote"   (default: "local")
```

Tri-state rather than two booleans, so "keep briefs deterministic forever" stays expressible for a
user who wants today's behaviour pinned.

| Value | Behaviour | Egress |
| --- | --- | --- |
| `"off"` | `ctx.llm` stays `undefined`. Today's behaviour exactly. | none, by construction |
| `"local"` (default) | Synthesis runs **only** if the resolved provider runs on this machine. No local provider → deterministic render. | none, by construction |
| `"allow-remote"` | Synthesis may use a remote provider. | one ledger row per remote call |

The default is `"local"` and not `"allow-remote"` because `"allow-remote"` is the first path by which indexed content
can leave the machine without a connector being involved. That is opt-in or it is a surprise.

### 2.2 Provider resolution must not use the plain router

`LlmRouter.prefersLocal()` (`llm/router.ts:70`) is only a *preference*. The router's own comment at
`llm/router.ts:39` states it "falls through to `remote` when no local provider answers." So
`prefer_local = true` does **not** guarantee a local provider, and calling
`llmRouter.generate()` naively under `synthesis = "local"` would silently reach a remote model
whenever Ollama happened to be down — the exact failure this mode exists to prevent.

New module `agents/_lib/synthesis-llm.ts`:

1. Resolves the provider **before** generating, **per invocation — never cached**. The router
   already probes availability on every `selectProvider` call (`llm/router.ts:103`), so this is its
   natural shape rather than an added cost, and caching would be wrong on a local-first machine
   where Ollama starts and stops under a long-lived Gateway.
2. Under `"local"`, a non-local resolution is refused outright — return `undefined` so the caller
   renders deterministically. Refusal is the normal path on a machine without Ollama, not an error.
3. Under `"allow-remote"`, a non-local resolution appends its egress row (§2.3) and only then generates.

`LlmGenerateResult` already carries `providerId` (`llm/router.ts:23`) and an optional `fallback`
(`:29`), so "did this go remote" is answerable — but only *after* the call. That is too late for a
fail-closed ledger, which is why resolution is a separate step rather than a post-hoc inspection.
Whether the existing air-gap mode (`llm/router.ts:148`) already exposes a no-remote-fallback
generate path is an implementation question for the plan; if it does, reuse it rather than adding a
parallel mechanism.

### 2.3 Egress

New `egress/synthesis-egress.ts` exporting `recordSynthesisEgress`, joining `recordAgentBriefEgress`
(`egress/agent-brief-egress.ts:36`) and `recordSyncEgress` (`egress/sync-egress.ts:64`). Keeping the
appender inside `egress/` satisfies D22 rule (b), which confines `appendEgressEntry` to that
directory; no new static rule is required.

Under `synthesis = "allow-remote"`, when the resolved provider is non-local, **one row is appended before the
generate call**, matching I29's append-before-egress ordering everywhere else.

**On append failure, the brief falls back to the deterministic render rather than failing.** This is
still fail-closed in I29's sense — nothing egresses — and is strictly better than erroring, because
the deterministic render is an already-supported, already-correct output rather than a degraded one.
This is a deliberate divergence from the executor's abort-the-action behaviour, and it is safe only
because a brief has a complete non-egressing fallback that a connector dispatch does not.

#### 2.3.1 The class is `model`, and it already exists

**Correction to an earlier draft:** it said `nimbus prove` "gains a `synthesis` coverage class."
Wrong on both counts. `"model"` is already a member of the **frozen** `EGRESS_SOURCE_TYPES` union
(`egress/egress-source-type.ts`), commented *"inference + embeddings, local or remote"*, and that
file states the union landed complete "including members whose appenders do not exist yet (`boot`,
`degraded` arrive with the boot marker; `sync`, `model`, `peer` arrive in later phases)."
`"model"` is likewise already a `COVERAGE_CLASSES` member sitting at `"none"`, and
`THIS_BINARY_COVERAGE`'s docstring says *"Later phases raise `model`, `peer`, `session`."*

**W6-A0 is that later phase for `model`.** So the work is not to add a vocabulary entry — adding one
would break a deliberate freeze, and `COVERAGE_CLASSES` order *is* the wire format serialized into
the boot marker's hashed `source_id`. The work is:

- `recordSynthesisEgress` appends with `sourceType: "model"`.
- `THIS_BINARY_COVERAGE.model` rises `"none"` → `"per-call"`.
- `COVERAGE_CLASS_LABELS` in `packages/cli/src/commands/prove.ts` gains a `model` entry. That map is
  a hand-maintained mirror — the CLI cannot import the gateway module — so it is a required, not
  optional, second edit.

#### 2.3.2 Raising `model` naively would overclaim, and embeddings are why

`model` is defined as *"inference **and embeddings**, local or remote."* Embeddings already egress:
`PROSE_HEAVY_TYPES` routes to OpenAI's 1536-dim table when a key is set, and **that path appends
nothing**. Raising `model` to `"per-call"` on the strength of a brief-synthesis appender alone would
claim ledger coverage over embedding egress that is not ledgered — which is verbatim the defect
`THIS_BINARY_COVERAGE`'s own docstring names: *"raising an entry without landing its appender is the
exact defect this vector exists to prevent."*

The established fix is precedent, not invention: **every** non-`none` class here covers less than its
name and says so where the claim is made. `mcp` is briefs only, not the six read-only index tools on
the same server. `http` is briefs only, not the HTTP read surface. `sync` is configured connectors
only, and `per-run` rather than `per-call` because the weaker of its two appenders governs.

`model` follows them: raised to `"per-call"`, narrowed **in the docstring** to brief synthesis, with
embedding egress named explicitly as not covered. The `prove` label carries the same narrowing for a
human reader — `"agent brief synthesis calls"`, never `"model calls"`.

A reviewer may reasonably judge this narrowing thinner than its siblings', because embedding traffic
is continuous and large while the six index tools are incidental. The alternative — leave `model` at
`"none"` and append rows under a class disclaiming coverage — was already considered and rejected
once for `mcp`: the source-type freeze notes that reusing `session` "would have recorded MCP briefs
and disclaimed them in the same breath." **Open for review; not settled by precedent alone.**

#### 2.3.3 Zero means different things per mode

The label must state that `"off"` and `"local"` emit nothing *by construction* rather than *by
observation*. A zero count under those modes is a structural guarantee, and the label must not let
it read as a measurement that happened to come back empty.

### 2.4 Honesty enforcement is a guard, not a prompt promise

`SYNTHESIS_INSTRUCTIONS` currently says *"Never invent evidence rows; only paraphrase or reorder
what is already in the JSON."* That rule is unenforced today for the simple reason that it never
runs. Once live it becomes the only thing between a generative rewrite and the properties several
agents were explicitly built around:

- `negotiate`'s honesty contract — a lane that could not be computed renders `_could not be
  computed_`, never `0` (`agents/_lib/render.ts:662,690,716,743,764,841,865`).
- The 0.86 confidence ceilings stated by `glossary`, `decisions` and `premortem`.
- Per-brief truncation counts keyed on `body_complete = 0`.
- Every `GapNote` and its `remediation` (`render.ts:39`).

**Superseded during implementation, on two counts.** First, a factual error in this list rather
than a scope narrowing: `glossary` has no 0.86 confidence-ceiling concept at all — only `decisions`
and `premortem` (`THEME_CONFIDENCE_CEILING`, `premortem/theme-identity.ts`) do; `glossary`'s own
honesty disclosure is per-brief truncation counts and definition provenance
(`snippet`/`manual`/`llm`), not a confidence score. Second, this list reads as though
`requiredPhrases` ends up protecting all four properties — it protects only the first. What
shipped (`brief-contract.ts`) derives real phrases solely for `negotiate`'s null lanes; every other
brief kind, including the confidence ceilings and truncation counts named above, returns an empty
set and is not yet guarded — an LLM rewrite of those kinds could silently drop either disclosure
today. See `docs/roadmap.md`'s A0 entry for the corrected, current accounting.

So the design does not trust the instruction. A `requiredPhrases(brief)` function derives, per brief
kind, the contractual strings the deterministic render produced. **If the synthesized markdown drops
any of them, the synthesis is discarded and the deterministic render is emitted.** Written as what
cannot pass rather than what should hold, so a model that softens a disclaimer fails closed and a
model that merely rephrases prose does not.

**Matching is normalized, and scoped to the section that owns the phrase.** Both halves matter:

- *Normalized* — strip markdown emphasis (`_`, `*`, `` ` ``), collapse whitespace, compare
  case-insensitively. Without this, a model that renders `_could not be computed_` as
  `*could not be computed*` fails the guard, every synthesis is rejected, and the feature is
  silently inert for the second time in its life.
- *Section-scoped* — a bare substring check over the whole document cannot tell **which** lane lost
  its disclaimer. `render.ts:660` emits each null negotiate lane as `## PRs authored` / blank /
  `_could not be computed_`, so a brief with six null lanes and one surviving phrase would pass a
  document-wide check while five lanes silently read as measured. `SYNTHESIS_INSTRUCTIONS` already
  requires "Keep all section headings", so the heading is available as the scope key. Each required
  phrase is therefore checked against the content under its own heading.

A missing heading is itself a rejection — otherwise dropping the whole section would pass a check
that only looks inside sections that exist.

`requiredPhrases` dispatches over the same `SynthInput` union `deterministicRender` does and reuses
the `assertNeverBrief` exhaustiveness guard (`synthesize.ts`), so a fifteenth brief kind is a
compile error rather than an unguarded brief.

### 2.5 The footer claim changes

`DETERMINISTIC_FOOTER` reads *"Rendered deterministically — built-in briefs do not use an LLM,
regardless of `[llm]` settings."* Under `synthesis = "off"` or `"local"`-with-no-local-provider that
stays true and the footer stays. On the synthesized path it becomes false, so that path gets its own
footer naming the model and whether it ran locally — reusing the `synthesis: {model, remote,
disclosure?}` provenance shape the research-briefs surface already established, rather than
inventing a second vocabulary for the same fact.

Every other place in the tree that asserts briefs do not use an LLM changes in the same commit. This
is the wiring + docs + test triple applied to a claim rather than an invariant, and the claim is
load-bearing: users were told it unconditionally.

**Superseded during implementation:** this section describes one second footer. What shipped is
four footer forms, not two — `packages/gateway/src/agents/_lib/synthesize.ts`: `DETERMINISTIC_FOOTER`
(no runner at all — `[agents].synthesis = "off"`, where "regardless of `[llm]` settings" stays
true), a dedicated `no_eligible_provider` footer (a runner WAS invoked but nothing resolved —
added by the Task 7 honesty pass, because the `DETERMINISTIC_FOOTER` clause it originally reused is
false once `[llm]` settings are typically the reason nothing resolved), a discarded-synthesis
footer naming why a called runner's output was thrown away, and the used-synthesis footer this
section describes (`_Synthesized by <model> (local|remote)._`). See that file's
`withDeterministicFooter` / `withNoEligibleProviderFooter` / `withDiscardedSynthesisFooter` /
`withProvenanceFooter` for the shipped shape and the reasoning each one is true under.

### 2.6 Latency and timeout

**Correction to an earlier draft of this spec:** it claimed an LLM call would "blow the latency
budget the `nimbus-agent-patterns` skill sets." Checked — that skill pins exactly one number, and it
is `why-peek`'s sub-300ms; there is no per-brief numeric budget to inherit. The pressure is also
lower than that framing implied, because briefs are **fire-and-forget**:
`emit-brief.ts:54` returns `{ sessionId }` immediately and delivers the brief later by
`briefReady` notification. Nobody is blocked on a synchronous response.

So the timeout does not exist to protect a budget. It exists so a hung or unreachable provider
produces a brief rather than none at all — under a fire-and-forget shape, no timeout means the
`briefReady` notification simply never arrives and the surface hangs with no error.

```toml
[agents]
synthesis_timeout_ms = 20000   # default
```

The default is deliberately generous rather than the 3–5s a synchronous path would want: a cold
Ollama's first-token latency on low-end hardware routinely exceeds that, and a default that
silently rejects every synthesis on slow machines reproduces exactly the inert-feature failure
this whole sub-project exists to correct. It is configurable so a user who would rather have a fast
deterministic brief than a slow synthesized one can say so.

On timeout the deterministic render is emitted, with the timeout disclosed as a rejection reason
(§2.7). `why-peek` is unaffected — it never enters this path (§1.1).

### 2.7 Rejection must be visible

A deterministic fallback is indistinguishable from today's output, so a fully broken synthesis path
would present as "nothing changed" — the risk §5 names. There is no logger in this path to warn
into: `emit-brief.ts` and the agent modules do no logging at all, and adding a logging dependency to
a fire-and-forget notification path to carry a fact the caller should already receive is the wrong
shape.

The `briefReady` notification carries the fact instead. `emit-brief.ts:59` already emits
`{ sessionId, brief, findings }`; this adds a fourth field:

```ts
synthesis:
  | { attempted: false; reason: "disabled" | "no_eligible_provider" }
  | { attempted: true; used: true;  model: string; remote: boolean }
  | { attempted: true; used: false; reason: "timeout" | "contract_violation" | "egress_append_failed";
      missingPhrases?: string[] }
```

This is the same `{model, remote, disclosure?}` provenance shape §2.5 adopts for the footer, widened
to carry rejection. It reaches the CLI, the HTTP surface and the Tauri renderer through the existing
notification, so "why is my brief still deterministic?" is answerable without a debug build — and
`missingPhrases` names precisely which contract the model broke.

**Superseded during implementation:** the field shipped as `violations`, not `missingPhrases` —
`SynthesisProvenance` in `packages/gateway/src/agents/_lib/synthesize.ts`. The discard-reason union
also grew two members past this draft's three: `provider_error` (a called provider that answered
with a failure, kept distinct from `timeout` so the two are not conflated in the footer or the
notification) and `empty_result` (a provider that returns `ok: true` with blank text — a
well-formed `SynthesisAttempt` that still must not reach the reader as a brief). `violations` is
populated only for `contract_violation`, same role `missingPhrases` was designed to play here.

---

## 3. What A0 does not do

- **No `--devil`** (A1) and **no personas** (A2). A0 decides whether an LLM is in the brief path;
  it does not add a second voice or a configurable one.
- **No change to `nimbus ask`.** That path is already LLM-backed and is where A1 and A2 do most of
  their work.
- **No new invariant.** Synthesis egress rides I29's existing ledger and D22's existing rule (b).
- **No migration, no Tauri allowlist change.**

---

## 4. Testing

| Property | Test |
| --- | --- |
| Contract survival | For all fourteen brief kinds, a stub LLM returning disclaimer-stripped markdown must produce the deterministic render, not the stripped one. Red-proved by reverting the guard. |
| Reformatting is **not** a violation | A stub returning `*could not be computed*` for `_could not be computed_` must be **accepted**. This test is what keeps the guard from rejecting every real synthesis. |
| Section scoping | A negotiate brief with two null lanes, where the stub drops the disclaimer from one and keeps it in the other, must be **rejected** — the failure a document-wide substring check would pass. |
| Dropped heading | A stub that omits a whole required section is rejected, not passed by a check that only inspects sections present. |
| Timeout yields a brief | A stub that never resolves must still produce a `briefReady` with the deterministic render, never a hang and never only `briefError`. |
| Rejection is visible | Each rejection reason (`timeout`, `contract_violation`, `egress_append_failed`) appears on the notification's `synthesis` field, with `missingPhrases` populated for the contract case. |
| `"local"` never egresses | Router with only a remote provider registered, `synthesis = "local"` → no synthesis **and** zero ledger rows. |
| `"allow-remote"` appends before calling | Remote provider resolved → exactly one row, ordered before the generate call. |
| Append failure is fail-closed | Forced append failure → zero synthesis, deterministic render, no egress. |
| HTTP ≡ socket | The same brief requested over both transports returns identical payloads, preserving what `agent-http-invoke.ts:75` asserts by comment today. |
| `why-peek` exemption | Stays structural — assert it never reaches the synthesis path under any `[agents].synthesis` value. |
| Exhaustiveness | A new brief kind without a `requiredPhrases` arm fails to compile. |

The contract-survival test is the one that matters most, and it is deterministic — the stub LLM
makes it a pure function test rather than an assertion about real model output. No test in A0
asserts anything about what a live model writes.

---

## 5. Risks

- **This changes what every built-in brief is.** Fourteen surfaces that have only ever emitted
  deterministic text may now emit rewritten text. The contract guard (§2.4) bounds the damage but
  does not eliminate the change in character.
- **`synthesis = "allow-remote"` is a genuinely new egress path.** It is off by default, ledger-covered when
  on, and named as such in `nimbus prove`'s scope label — but it is new, and the roadmap's claim
  that built-in agents "append nothing to the egress ledger" becomes conditional rather than
  absolute.
- **The deterministic fallback can mask a broken synthesis.** If the contract guard rejects every
  synthesis, briefs look exactly as they do today. §2.7 addresses this — every rejection is carried
  on the `briefReady` notification with its reason — so the failure is now reportable rather than
  silent. It is not fully retired: a user who never inspects the notification still sees only an
  unchanged brief, and the two tests that bound it (reformatting-is-not-a-violation, and
  timeout-still-yields-a-brief) are the ones most worth red-proving.
