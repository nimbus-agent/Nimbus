# Agent Brief Synthesis (W6-A0) — Design

**Date:** 2026-08-16
**Status:** DESIGN — not implemented.
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
synthesis = "local"   # "off" | "local" | "any"   (default: "local")
```

Tri-state rather than two booleans, so "keep briefs deterministic forever" stays expressible for a
user who wants today's behaviour pinned.

| Value | Behaviour | Egress |
| --- | --- | --- |
| `"off"` | `ctx.llm` stays `undefined`. Today's behaviour exactly. | none, by construction |
| `"local"` (default) | Synthesis runs **only** if the resolved provider runs on this machine. No local provider → deterministic render. | none, by construction |
| `"any"` | Synthesis may use a remote provider. | one ledger row per remote call |

The default is `"local"` and not `"any"` because `"any"` is the first path by which indexed content
can leave the machine without a connector being involved. That is opt-in or it is a surprise.

### 2.2 Provider resolution must not use the plain router

`LlmRouter.prefersLocal()` (`llm/router.ts:70`) is only a *preference*. The router's own comment at
`llm/router.ts:39` states it "falls through to `remote` when no local provider answers." So
`prefer_local = true` does **not** guarantee a local provider, and calling
`llmRouter.generate()` naively under `synthesis = "local"` would silently reach a remote model
whenever Ollama happened to be down — the exact failure this mode exists to prevent.

New module `agents/_lib/synthesis-llm.ts`:

1. Resolves the provider **before** generating.
2. Under `"local"`, a non-local resolution is refused outright — return `undefined` so the caller
   renders deterministically. Refusal is the normal path on a machine without Ollama, not an error.
3. Under `"any"`, a non-local resolution appends its egress row (§2.3) and only then generates.

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

Under `synthesis = "any"`, when the resolved provider is non-local, **one row is appended before the
generate call**, matching I29's append-before-egress ordering everywhere else.

**On append failure, the brief falls back to the deterministic render rather than failing.** This is
still fail-closed in I29's sense — nothing egresses — and is strictly better than erroring, because
the deterministic render is an already-supported, already-correct output rather than a degraded one.
This is a deliberate divergence from the executor's abort-the-action behaviour, and it is safe only
because a brief has a complete non-egressing fallback that a connector dispatch does not.

`nimbus prove` gains a `synthesis` coverage class. Its scope label must state that `"off"` and
`"local"` emit nothing *by construction* rather than *by observation* — a zero count under those
modes is a structural guarantee, and the label should not let it read as a measurement that happened
to come back empty.

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

So the design does not trust the instruction. A `requiredPhrases(brief)` function derives, per brief
kind, the contractual strings the deterministic render produced. **If the synthesized markdown drops
any of them, the synthesis is discarded and the deterministic render is emitted.** Written as what
cannot pass rather than what should hold, so a model that softens a disclaimer fails closed and a
model that merely rephrases prose does not.

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

### 2.6 Latency

An LLM call per brief would otherwise blow the latency budget the `nimbus-agent-patterns` skill
sets. Synthesis is timeout-bounded; on timeout, the deterministic render is emitted. `why-peek` is
unaffected — it never enters this path (§1.1).

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
| `"local"` never egresses | Router with only a remote provider registered, `synthesis = "local"` → no synthesis **and** zero ledger rows. |
| `"any"` appends before calling | Remote provider resolved → exactly one row, ordered before the generate call. |
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
- **`synthesis = "any"` is a genuinely new egress path.** It is off by default, ledger-covered when
  on, and named as such in `nimbus prove`'s scope label — but it is new, and the roadmap's claim
  that built-in agents "append nothing to the egress ledger" becomes conditional rather than
  absolute.
- **The deterministic fallback can mask a broken synthesis.** If the contract guard rejects every
  synthesis, briefs silently look exactly as they do today. The plan must surface rejection rate
  somewhere observable rather than letting a fully-broken synthesis path present as "unchanged".
