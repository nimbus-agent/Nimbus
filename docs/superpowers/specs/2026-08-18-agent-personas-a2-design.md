# Agent personas (A2) — design

**Date:** 2026-08-18
**Spine slot:** S1 (Local Brain) — "Answer-quality surfaces, remaining", first of two halves
**Status:** design approved, not yet implemented
**Roadmap rows:** `docs/roadmap.md` § Phase 7 Wave 6 → "Agent personas (A2)"; § Active → "Answer-quality surfaces, remaining"

---

## 1. What this is

A2 makes the *voice* of Nimbus's answers configurable per profile, so "work Asaf" can be
terse and "personal Asaf" can be verbose. It is the second of the three Wave 6
answer-quality surfaces, after A0 (brief synthesis, 2026-08-16) and A1 (`--devil`,
2026-08-18).

It applies to **both** LLM-facing prose surfaces:

- `nimbus ask` — the conversational turn.
- The fourteen built-in agent briefs — via the A0 synthesis seam.

Not to any other model call. See § 5.2 for why that boundary is load-bearing.

---

## 2. Findings that shaped this design

These were verified against the tree on 2026-08-18, not taken from the roadmap. Two of
them contradict what the roadmap row says.

**F1 — the profile mechanism works, but only through one path.** `nimbus profile switch`
writes `.nimbus-profile`; `cli/src/lib/spawn-gateway.ts` reads it and sets `NIMBUS_PROFILE`
on the child; `config/nimbus-toml.ts`'s `resolveNimbusTomlForProfile` maps that to
`nimbus.<name>.toml`. That chain is real and works.

**F2 — but almost nothing reads the profile-resolved path.** Only three consumers in
`platform/assemble.ts` use `activeTomlPath`: the session TOML, the LLM registry, and the
embedding runtime. Every other loader calls `loadNimbus*FromConfigDir()`, which hardcodes
`nimbus.toml`. **`[agents] synthesis` is one of them** — `loadNimbusAgentsFromConfigDir`
means your synthesis mode is profile-blind today. That is a pre-existing bug, not one A2
introduces, but A2 cannot ship a profile-aware persona sitting next to a profile-blind
synthesis switch without the pairing being incoherent. Fixed here (§ 5.1).

**F3 — the roadmap's acceptance criterion is unsatisfiable as written.** It asks for "an
integration test that toggles persona mid-session and asserts the response shape changes."
`NIMBUS_PROFILE` is set when the gateway process is *spawned*, so switching profiles
mid-session is impossible by construction. Rewritten in § 8.

**F4 — `ProfileManager` and the `profile.*` IPC namespace have never run in production.**
`ipc/server/options.ts` declares `profileManager?`; `ipc/server/dispatchers.ts:705` throws
`"Profile manager is not available on this gateway"` when it is undefined; **nothing ever
sets it** outside tests. This is not dead code: the desktop app has a routed Settings page
(`packages/ui/src/pages/settings/ProfilesPanel.tsx`, 188 lines, `App.tsx:58`), a zustand
slice, four client methods, and four Tauri-allowlisted IPC methods behind it. The desktop
profile switcher has never worked. The gateway is the only unwired link. Fixed here (§ 7).

**F5 — doc drift in the allowlist count.** `CLAUDE.md` and `docs/roadmap.md` record
negotiate as taking `ALLOWED_METHODS` from 105 → 106. The tree has **105** entries with
`agents.negotiate` present, so the running count in the docs is off by one. A2 changes no
allowlist entries, but the roadmap pass that accompanies this work corrects the number
rather than propagating it.

---

## 3. Decisions taken (recorded so they are not relitigated)

**D1 — two of the roadmap's four knobs do not ship.**

`tool_caution` (eager / measured / paranoid) was already recorded as **prohibited** on
2026-08-16: Non-Negotiable #2 ("the consent gate cannot be bypassed or configured away")
and I2's frozen `HITL_REQUIRED_BACKING` set forbid a config knob that changes what triggers
a consent prompt.

`confidence_threshold` ("how often the agent volunteers 'I'm not sure'") is **prohibited on
the same reasoning, one layer up**. Turned down, it is a supported way to make Nimbus sound
more certain than it is. Every S1 agent has spent the last month making honesty
non-optional — I31's disclosure integrity, the 0.86 confidence ceilings on `decisions` and
`premortem`, negotiate's "could not be computed" instead of `0`. A user-tunable dial that
suppresses uncertainty admissions is the same category of mistake as a dial that loosens
HITL, and it is not shipped in either direction. (Rejected alternative: a one-directional
version that may only make the agent hedge *more*. Honest-safe, but a third axis to test
and document for a knob nobody turns.)

So A2 ships exactly **`tone` and `voice`**.

**D2 — persona applies to `ask` and briefs, not to every model call.** See § 5.2.

**D3 — persona resolves per-invocation, never cached.** A0's precedent
(`agents/_lib/synthesis-llm.ts` resolves its provider per invocation because Ollama can
start and stop under a long-lived Gateway). The same reasoning applies: the TOML can change
under a running gateway. This is also the only thing that makes the feature testable at all
(§ 8).

**D4 — no free-text persona files.** A rejected alternative was letting the user supply a
`persona.<name>.md` injected verbatim, which the roadmap's "whole-file swap" correction
hints at. Rejected: it pipes unbounded user text into the brief-synthesis prompt — the
exact path I31's anchor checks guard — and leaves nothing enumerable to test. The enum
leaves room to add this later if there is demand.

**D5 — the broken desktop Profiles panel is fixed, not deleted.** See § 7.

---

## 4. Config surface

A new `[persona]` section, two keys, both closed enums, both defaulting to a value that is
a **strict no-op**:

```toml
[persona]
tone  = "terse"        # neutral (default) | terse | formal | casual | verbose
voice = "opinionated"  # neutral (default) | opinionated | collective
```

- `tone` controls length and register.
- `voice` controls stance: `neutral` states findings; `opinionated` is willing to
  recommend; `collective` uses first-person-plural ("we should…").

**Constraint on the directive text itself (D6).** Every `tone` and `voice` directive governs
*how something is expressed* — register, sentence length, stance — and never *whether a
piece of content appears*. `terse` means "say it in fewer words", never "leave things out".
No persona directive may contain an instruction to omit, drop, skip, summarise-away or
limit the number of items. This is a rule on the constant in `engine/persona.ts`, pinned by
a test that asserts no directive string matches an omission-verb pattern.

This constraint is load-bearing twice over: it is what keeps `terse` from fighting `--devil`
(§ 5.4), and what keeps `terse` from pushing against I31's disclosure contract (§ 5.3).
Getting it right in the directive text is cheaper and more reliable than detecting the
conflict at runtime.

Parsed in `config/nimbus-toml.ts` mirroring the existing `[agents]` block:
`NimbusPersonaToml`, `DEFAULT_NIMBUS_PERSONA_TOML`, `applyNimbusPersonaKey`,
`parseNimbusPersonaToml`. An unrecognised value silently keeps the default, matching how
`applyNimbusAgentsKey` treats an unknown `synthesis` mode — a typo must not break the
gateway, and must not silently mean something else.

`DEFAULT_NIMBUS_PERSONA_TOML` is `{ tone: "neutral", voice: "neutral" }`, and that value
makes `applyPersona` the identity function. **A gateway with no `[persona]` section must
produce byte-identical output to today.** This is the same discipline as
`applyDevilAdvocate` returning its input unchanged when the flag is off.

One qualifier, so this does not read as a promise the PR breaks elsewhere: the
byte-identical claim is about *persona*. The `[agents]` path fix in § 5.1 is a separate,
deliberate behaviour change in the same PR — a user who had `synthesis` set in a profile
TOML starts having it honoured. That is stated in the changelog, and it is the only
intended output change for a user who sets no `[persona]` at all.

---

## 5. Where it loads and where it applies

### 5.1 Loading — profile-aware by construction

```ts
loadPersonaOrWarn(resolveNimbusTomlForProfile(configDir), logger)
```

The `OrWarn` suffix is not decoration. An unrecognised enum value keeps the default (§ 4),
which on its own means a typo — `tone = "tree"` — leaves the user believing a persona is
active when it is not. The loader therefore takes a logger and warns once per unrecognised
key/value at load, naming the key, the rejected value and the default it fell back to.

This mirrors `loadServiceConfigsOrDegrade(paths.configDir, syncLogger)` in
`platform/assemble.ts`, which is the established shape in this codebase for "malformed
config degrades rather than aborts, and says so". The parser in `config/nimbus-toml.ts`
stays pure — it has no logger and must not acquire one — so the warn lives in the loader
that the boot site calls, not in `applyNimbusPersonaKey`.

Never `loadPersonaFromConfigDir`. Per F2, a `…FromConfigDir` loader would read
`nimbus.toml` regardless of the active profile, which would make a per-profile persona
silently not per-profile — the entire point of A2.

To avoid shipping that trap next door, **the same PR moves `[agents]` onto the
profile-resolved path**: `buildAgentSynthesisRunner`'s `configDir` handling switches from
`loadNimbusAgentsFromConfigDir(configDir)` to loading from
`resolveNimbusTomlForProfile(configDir)`. This is a behaviour change — a user with
`synthesis` set in a profile TOML starts getting it honoured — and it is the correct one.
It gets its own test and its own line in the changelog rather than riding along silently.

### 5.2 Two application sites, one definition

The persona *sentence* has exactly one definition. It is *applied* at two places, because
there are two genuinely different prompt surfaces with different rules: a brief carries
reserved-section instructions and an `ask` turn does not.

This is the A1 discipline. A1's `devil-advocate.ts` doc comment is explicit that the risk
being managed is **two definitions drifting apart**, not two call sites existing. One
definition, two applications, both tested independently.

**Site 1 — `nimbus ask`.** `engine/run-ask.ts` resolves the persona from
`paths.configDir` (already on `RunAskParams`) and threads it to `runConversationalAgent`
as `persona?`. It is applied at the *same single site above the router-vs-agent fork* that
A1 uses, composing outward:

```ts
const promptWithContext = applyPersona(
  applyDevilAdvocate(buildPromptText(trimmed, p.localContext), p.devil),
  p.persona,
);
```

`applyDevilAdvocate` stays innermost so the devil directive keeps its position immediately
above the question; persona wraps it. Both execution paths (`runViaLocalRouter`,
`runViaAgent`) and both IPC dispatchers (`agent.invoke` and `engine.askStream` — the latter
being the path the desktop UI and the VS Code extension use) are covered by construction.
A1 discovered the two-dispatcher trap the expensive way; A2 inherits the fix for free, and
tests it rather than assuming it.

**Site 2 — briefs.** Persona is appended to `synthesisInstructionsFor(brief)` in
`agents/_lib/synthesize.ts`, threaded in from `buildAgentSynthesisRunner` — the single
factory both production brief paths already share
(`ipc/server/dispatchers.ts`'s socket path and `agent-runs/agent-http-invoke.ts`'s HTTP
path). Because both go through that one factory, a socket brief and an HTTP brief stay
byte-identical under every persona, exactly as they already do under every synthesis mode.

**Nowhere else.** Persona must not reach the intent classifier, glossary consolidation,
decision extraction, or any embedding call. Those are structured-extraction calls whose
output is parsed, not read; a "verbose, opinionated" instruction corrupts them. This is
why persona is not applied in the `LlmRouter` or provider layer, which would have been
fewer sites and wrong.

### 5.3 The I31 interaction — no new guard needed

A "terse" persona is literally an instruction to say less, aimed at a path whose governing
invariant is that a rewrite must never say less than the deterministic render promised.
That deserves scrutiny, and the conclusion is that **I31 already makes this safe by
construction**:

- **Reserved sections** (`## Gaps` for all fourteen kinds, plus `negotiate`'s `## Sources`
  and `## Evidence not available from the index`) are built by the renderer and re-attached
  verbatim after synthesis. They are never shown to the model. No persona can drop one,
  because no persona can reach one.
- **Interleaved disclosures** are anchor-checked against `brief-disclosures.ts` via
  `brief-contract.ts`'s `requiredPhrases`. A rewrite that drops one is a contract violation
  and is discarded whole.

So the failure mode a terse persona actually introduces is **a higher discard rate** —
more briefs falling back to the deterministic render — not a lost disclosure. That is a
UX cost, and it is documented rather than guarded against a second time.

One regression test pins the claim: a brief synthesized under `tone = "terse"` still
carries every required anchor and every reserved section. That is a test of the existing
mechanism under new pressure, not a new mechanism.

**Making the discard rate measurable.** Because a raised discard rate is the predicted
cost, it must be observable in production rather than inferred. The synthesis provenance
already carries a rejection reason (`timeout` / `contract_violation` / `provider_error` /
`egress_append_failed` / `empty_result`) out to the reader on the `briefReady`
notification's `synthesis` field — shipped with A0 precisely so "why is my brief still
deterministic?" is answerable without a debug build. A2 adds the **resolved persona** to
that same provenance object. A `contract_violation` under `tone = "terse"` is then
self-describing on the notification a user can already see, with no new log channel and
nothing that only exists in a debug build.

### 5.4 Precedence against `--devil`

`--devil` and a persona can both be active. The composition order is fixed and stated here
so it is not rediscovered by experiment: the persona directive is outermost, the devil
directive sits immediately above the question, and the question is last.

```
[persona directive]
[devil directive]
[prompt text + local context]
```

`applyDevilAdvocate` stays innermost deliberately. The devil directive is the one that must
not be diluted — it is the whole point of the invocation — and proximity to the question is
the cheapest available emphasis.

**There is less conflict here than there appears to be, and D6 is why.** A directive that
governs register cannot contradict a directive that governs content: "argue against the
plan, in few words" is a coherent instruction, where "argue against the plan, and omit some
objections" would not be. Because no `tone` value may contain an omission instruction (D6),
the incoherent form cannot be written.

Two things this deliberately does **not** do:

- **No runtime override.** `--devil` does not silently relax `tone = "terse"`. A flag that
  quietly discards a user's configured setting is harder to explain than either setting
  alone, and D6 removes the need for it.
- **No conflict detection.** There is no code that inspects the two directives for
  contradiction. The constraint is enforced on the constants at authoring time, by test,
  which is where it is cheap.

A test asserts both directives are present, in this order, when both are active.

---

## 6. New and changed files

| File | Change |
| --- | --- |
| `config/nimbus-toml.ts` | `NimbusPersonaToml`, defaults, key applier, parser, `loadPersonaFromTomlPath` |
| `engine/persona.ts` | **new** — the single `PERSONA_DIRECTIVES` definition + `applyPersona` |
| `engine/run-conversational-agent.ts` | `persona?` on params; one composed application line |
| `engine/run-ask.ts` | resolve persona from `paths.configDir`; thread through |
| `ipc/agent-invoke.ts`, `ipc/engine-ask-stream.ts` | nothing — persona is config, not a per-call flag |
| `agents/_lib/synthesize.ts` | accept persona in opts; append to `synthesisInstructionsFor` |
| `agents/_lib/agent-synthesis-runner.ts` | resolve persona; **move `[agents]` onto the profile-resolved path (§ 5.1)** |
| `platform/assemble.ts` | construct `ProfileManager`, set `ipcOpts.profileManager` (§ 7) |
| `packages/docs/` | `[persona]` reference + the restart caveat |

Persona is **not** a per-call IPC parameter, so `agent-invoke.ts` and `engine-ask-stream.ts`
need no new field — a deliberate contrast with `--devil`, which is per-call.

---

## 7. Fixing the Profiles panel (F4)

`platform/assemble.ts` constructs a `ProfileManager(paths.configDir)` and assigns it to
`ipcOpts.profileManager`. That is the whole fix — roughly three lines — and it turns four
Tauri-allowlisted IPC methods and a 188-line Settings page from always-throwing into
working.

Included in A2 rather than split out because A2 is the work that makes profiles worth
switching. Shipping a per-profile persona while the desktop app's profile switcher throws
would be shipping a feature behind a broken door.

**Scope limits, stated:**

- No allowlist change. `profile.list` / `create` / `switch` / `delete` are already on
  `ALLOWED_METHODS`, and `profile.switched` is already in `GLOBAL_BROADCAST_METHODS`. The
  count stays 105 and `allowlist_exact_size` is untouched.
- **Switching a profile still requires a gateway restart** — `NIMBUS_PROFILE` is read at
  spawn. The panel must say so on switch, the same way the CLI already prints *"Restart the
  Gateway (nimbus stop && nimbus start)."* Making the gateway hot-swap its whole config at
  runtime is out of scope and probably a bad idea.
- The gateway `ProfileManager` and `cli/src/commands/profile.ts` remain two implementations
  of the same file format. Converging them is follow-up work, recorded here so it is not
  mistaken for an oversight. They agree on the marker filename, the prefix and the suffix;
  a drift test pinning that agreement is cheap and is included.

---

## 8. Testing, and the rewritten acceptance criterion

The roadmap's criterion — *"switching `nimbus profile switch personal` then querying
produces output with the persona-configured tone, verified by an integration test that
toggles persona mid-session and asserts the response shape changes"* — is replaced, for the
same reason A1's was: it asserts something untestable and something impossible.

- **Impossible:** a mid-session profile toggle. `NIMBUS_PROFILE` is fixed at spawn (F3).
- **Untestable:** "output with the persona-configured tone" grades model prose. It needs a
  live model the suite does not have, and would be flaky where one exists — precisely the
  trap A1's "at least 3 distinct counter-arguments" criterion fell into.

**Replacement criteria, all mechanically assertable:**

1. Editing `[persona]` in the **active** profile's TOML changes the next response's prompt
   with no restart (per-invocation resolution, D3).
2. Switching profiles requires a restart, as every other setting does; the CLI and the
   desktop panel both say so.
3. The persona directive reaches the prompt on **both** execution paths
   (`runViaLocalRouter`, `runViaAgent`) and across **both** dispatchers (`agent.invoke`,
   `engine.askStream`); breaking either leg fails only its own test.
4. The default persona is the identity function: a gateway with no `[persona]` section
   produces a byte-identical prompt to today.
5. Persona composes with `--devil` — both directives present, neither displacing the other,
   in the expected order.
6. Persona reaches brief synthesis through `buildAgentSynthesisRunner`, so the socket and
   HTTP paths agree.
7. A brief synthesized under `tone = "terse"` still carries every `requiredPhrases` anchor
   and every reserved section (§ 5.3).
8. `[agents] synthesis` set in a profile TOML is honoured (§ 5.1 — the F2 fix).
9. `profile.list` succeeds against an assembled gateway rather than throwing (§ 7).
10. No `PERSONA_DIRECTIVES` string contains an omission instruction (D6) — asserted against
    an omission-verb pattern over the constants, so a future directive edit that reintroduces
    "leave out" / "limit to N" / "skip" fails at authoring time.
11. With `--devil` and a persona both active, both directives are present in the documented
    order (§ 5.4).
12. An unrecognised `[persona]` value warns once, naming key, rejected value and fallback,
    and still yields the default (§ 5.1).

**Recorded gap:** nothing asserts that a terse persona's prose is actually terser. That
grades model output. This is a deliberate, recorded limitation — the same one A1 carries —
not an oversight.

---

## 9. Out of scope

No schema migration. No new IPC method. No new HTTP route. No new security invariant. No
Tauri allowlist change. No connector change.

`tool_caution` and `confidence_threshold` are not deferred — they are **rejected**, with
reasons, in D1.

---

## 10. Known bounds

- A prompt-level directive carries less weight with most models than a system-level one.
  A1 accepted this bound deliberately to keep a single application site; A2 accepts the
  same bound for the same reason.
- Persona raises the brief-synthesis discard rate under terse settings (§ 5.3). Users who
  see more deterministic briefs after setting a terse persona are seeing the honesty
  contract working, and the docs say so.
- The gateway and CLI profile implementations stay duplicated (§ 7).
- `[persona]` joins `[agents]` on the profile-resolved path; the other ~20
  `loadNimbus*FromConfigDir` loaders remain profile-blind. Auditing all of them is separate
  work and is not silently claimed here.
- D6 is enforced on the directive *constants*, not on model output. A model can still
  respond tersely enough to drop an objection under `--devil`; what D6 guarantees is that
  Nimbus never *asked* it to. For briefs, I31 catches the result; for `ask`, there is no
  equivalent contract and none is proposed here.

---

## 11. Deferred from design review

Recorded so they are not re-raised as oversights. Full reasoning in
`2026-08-18-agent-personas-a2-design-review-response.md`.

- **Auto-restart the gateway on desktop profile switch.** Feasible — Tauri already has
  `shell_start_gateway` (`gateway_bridge.rs`) invoking `nimbus start`. Deferred because a
  restart kills in-flight syncs, agent runs and pending HITL prompts; doing that as a
  silent side effect of a settings toggle is a destructive action taken without consent.
  The right shape is an explicit "Restart Gateway" button that says what it will interrupt.
  Desktop UX work, its own issue, not A2.
- **A shared persona-enum schema across gateway / CLI / UI.** Rejected. `ui` and `cli` must
  not import gateway source (dependency rule), so the union cannot be shared directly; and
  the UI authors no config at all — it has no `nimbus.toml` write path — so nothing would
  consume it. YAGNI until a config-editing surface exists.
