# Design Review Response: Agent Personas (A2)

Response to [`2026-08-18-agent-personas-a2-design-review.md`](./2026-08-18-agent-personas-a2-design-review.md).
Every item was checked against the tree on 2026-08-18 before being accepted or declined.

**Outcome:** 3 accepted (2 in modified form), 1 deferred, 1 rejected.

| # | Item | Outcome | Spec change |
| --- | --- | --- | --- |
| Q1 | Persona vs `--devil` conflict | **Accepted, modified** | D6 + § 5.4 |
| Q2 | Silent enum fallback | **Accepted, relocated** | § 5.1 `loadPersonaOrWarn` |
| Q3 | Auto-restart gateway on profile switch | **Deferred** | § 11 |
| S1 | Shared persona-enum schema across packages | **Rejected** | § 11 |
| S2 | Terse-discard observability | **Accepted, improved** | § 5.3 |

---

## Q1 — Persona vs `--devil`: accepted, in modified form

**One factual correction first.** The review's concrete example — that `--devil` instructs
the model to "list at least 3 detailed counter-arguments" — is not in the code.
`DEVIL_ADVOCATE_DIRECTIVE` (`engine/devil-advocate.ts`) contains no count instruction at
all; grepping it for `three` / `3` / `at least` returns zero hits. The "at least 3 distinct
counter-arguments" phrasing comes from A1's *rejected* roadmap acceptance criterion, which
was deliberately not implemented because it grades model prose and needs a live LLM. So the
sharpest version of the conflict does not exist.

**The underlying concern is still real, in a milder form.** "Say it in fewer words" and
"give the strongest case, and do not flatten this into a balanced summary" do pull in
different directions.

**Also worth noting: the review's own recommendation is already satisfied by the design.**
It suggests `--devil` "be appended last or explicitly take precedence".
`applyDevilAdvocate` is already the inner call, which puts the devil directive *below* the
persona directive and immediately above the question — later in the prompt and closer to
the subject. What the spec was missing was not the ordering, but any statement of it.

**What changed.** Two things, neither of them a runtime mechanism:

1. **D6** — a rule on the directive constants: every `tone`/`voice` directive governs how
   something is expressed, never whether content appears. `terse` means "fewer words", never
   "leave things out". No directive may contain an omission instruction, pinned by a test
   over the constants (criterion 10).
2. **§ 5.4** — the precedence is now written down, with the reasoning for why the devil
   directive stays innermost, plus a test that both appear in order when both are active
   (criterion 11).

D6 dissolves most of the conflict rather than managing it: a register directive cannot
contradict a content directive. "Argue against the plan, in few words" is coherent; "argue
against the plan, and omit some objections" is not — and D6 makes the second unwritable.

**What was declined, and why.** The review floats letting `--devil` "temporarily
relax/override" `tone = "terse"`. Rejected: a flag that silently discards a setting the user
configured is harder to explain than either setting alone, and D6 removes the need for it.
Likewise no runtime conflict-detection code — the constraint is enforced on constants at
authoring time, which is where it is cheap.

D6 turned out to pay for itself twice: it is also what keeps `terse` from pushing against
I31's disclosure contract (§ 5.3), which the original spec argued for on I31's structure
alone.

---

## Q2 — Silent enum fallback: accepted, relocated

The concern is correct. `tone = "tree"` silently yielding `neutral` leaves the user
believing a persona is active when it is not, and § 4's "must not silently mean something
else" only covered *meaning something else*, not *silently doing nothing*.

**Relocated rather than implemented as proposed.** The review suggests the warning go where
the parse happens. `config/nimbus-toml.ts` is a pure parsing module with no logger and no
`console` — verified — and it should not acquire one: it is called from many contexts, and a
parser that logs turns every config read into an I/O event.

Instead the warning lives in the loader the boot site calls:
`loadPersonaOrWarn(tomlPath, logger)`, warning once per unrecognised key/value with the key,
the rejected value and the fallback. This mirrors
`loadServiceConfigsOrDegrade(paths.configDir, syncLogger)` in `platform/assemble.ts` — the
established shape here for "malformed config degrades rather than aborts, and says so."

Note the existing `[agents]` parser has exactly the same silent-fallback behaviour today.
A2 does not retrofit a warning onto it; that is a separate, larger sweep, and claiming it
here would overstate the change.

Criterion 12 added.

---

## Q3 — Auto-restart the gateway on profile switch: deferred

**The premise checks out.** `packages/ui/src-tauri/src/gateway_bridge.rs` already has
`shell_start_gateway`, invoking `nimbus start` through the Tauri shell plugin, and the CLI
has a `stop` command. A `shell_restart_gateway` is a small addition. The review is right
that this is possible.

**Deferred on consequences, not feasibility.** A gateway restart terminates in-flight
connector syncs, running agent briefs, and **pending HITL consent prompts**. Performing
that as a silent side effect of flipping a dropdown in a settings panel is a destructive
action taken without asking — the opposite of how the rest of the product treats
interruption.

The right shape is an explicit "Restart Gateway" button that names what it will interrupt,
which is desktop UX work with its own design questions (what if a HITL prompt is open? what
if a sync is 90% done?). That belongs in its own issue, not folded into a persona spec.

For A2, the panel says a restart is required — matching what the CLI already prints. Nothing
regresses; the gap is recorded in § 11 rather than quietly left out.

---

## S1 — Shared persona-enum schema across packages: rejected

Two independent reasons, either sufficient.

**It violates the package dependency rule.** `CLAUDE.md`: "`cli` and `ui` reach the gateway
IPC-only (no source imports)." Exporting a TypeScript union or a Zod schema from the gateway
config module for the UI settings page and a CLI validation helper to import is exactly the
coupling that rule forbids. (Zod *is* a gateway dependency, so the proposal is
technically constructible — which is what makes it worth declining explicitly rather than
on availability grounds.) The sanctioned route would be the published `@nimbus-dev/client`
package, which is a real but heavy path for two string enums.

**Nothing would consume it.** The desktop UI authors no configuration at all — grepping
`packages/ui/src` for a `nimbus.toml` write path or a config-set IPC call returns nothing.
`[persona]` is edited by opening the TOML. There is no UI surface to validate, so the shared
schema would have exactly one consumer, which is the gateway that already owns it. YAGNI.

If a config-editing surface is ever built, this becomes worth revisiting on the
`@nimbus-dev/client` path. Recorded in § 11.

---

## S2 — Terse-discard observability: accepted, in a better form

The proposal is a debug log or trace when a brief falls back to deterministic under
`tone = "terse"`.

**Half of this already exists, and better than a log.** A0 shipped rejection reasons
(`timeout` / `contract_violation` / `provider_error` / `egress_append_failed` /
`empty_result`) on the `briefReady` notification's `synthesis` field — deliberately not
"only logged", so that "why is my brief still deterministic?" is answerable without a debug
build. A new debug-only log would be a strictly weaker channel than the one already there.

**What was genuinely missing is the correlation**, which is the actual point of the
suggestion: the reason is visible but the persona that provoked it is not. So A2 adds the
resolved persona to that same provenance object. A `contract_violation` under
`tone = "terse"` becomes self-describing on a notification the user can already see, in
production, with no new channel.

Recorded in § 5.3.
