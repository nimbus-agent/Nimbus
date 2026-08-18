# Design Review: Agent Personas (A2)

This document collects feedback, suggestions, and open questions on the [Agent Personas (A2) Design](./2026-08-18-agent-personas-a2-design.md).

---

## 1. Open Questions

### Q1: Instruction Conflict (Persona vs. `--devil`)

The design proposes composing the prompt modifiers as:
```ts
const promptWithContext = applyPersona(
  applyDevilAdvocate(buildPromptText(trimmed, p.localContext), p.devil),
  p.persona,
);
```

* **Question:** What happens when the persona and the `--devil` flag have conflicting instructions? For example, if a user runs with `--devil` (which instructs the model to elaborate and aggressively find counter-arguments) while their profile has `tone = "terse"` or `voice = "collective"`, the model will receive contradictory directives (e.g., "be extremely terse and brief" vs. "list at least 3 detailed counter-arguments").
* **Recommendation:** Clarify the priority of instructions in the system/user prompt composition. For instance, if `--devil` is active, it might be beneficial to temporarily relax/override certain constraints like `tone = "terse"` to ensure the quality of the devil's advocate response, or at least document how the model should reconcile these directives (e.g., by ensuring `--devil` instructions are appended last or explicitly take precedence).

### Q2: Unrecognized Enum Value Diagnostics

The spec states: *"An unrecognised value silently keeps the default... a typo must not break the gateway, and must not silently mean something else."*

* **Question:** If the configuration parser silently falls back to default, how will a user debug a typo (e.g., `tone = "tree"` instead of `terse`)? The user might assume their persona is working, while Nimbus is actually using the neutral default.
* **Recommendation:** While the gateway should not crash on invalid config values, it should emit a warning log (e.g., `logger.warn("Invalid persona.tone value: 'tree'. Falling back to 'neutral'.")`) to assist in debugging.

### Q3: Desktop UI Gateway Restart Flow

Section 7 notes: *"Switching a profile still requires a gateway restart... The panel must say so on switch."*

* **Question:** In the desktop (Tauri) application, is it possible to automate the restart of the Gateway process upon profile switch? If the Tauri app spawned the Gateway process, it could potentially kill and re-spawn it, providing a seamless transition rather than forcing the user to manually exit and reopen the app or run terminal commands.
* **Recommendation:** Check if `PlatformServices` or the Tauri bridge has the capability to trigger a gateway restart/re-spawn directly. If so, offer an interactive "Restart Gateway" button or automate it when a profile is changed in the Profiles panel.

---

## 2. Suggestions & Improvements

### 1. Unified Client-Side Config Schema Validation

Since the config enums for `tone` and `voice` are closed sets (`neutral` | `terse` | `formal` | `casual` | `verbose` and `neutral` | `opinionated` | `collective`), we should ensure these schemas are shared or validated at the CLI/UI level.
* **Proposal:** Export the TypeScript string union types or a Zod/Valibot schema representing the persona configuration from the configuration package, ensuring the desktop UI settings page and CLI validation helper reuse the same definition and cannot drift.

### 2. High Discard Rate Warning for Terse Synthesis

Section 5.3 acknowledges that `tone = "terse"` increases the brief discard rate due to required phrases being omitted or truncated.
* **Proposal:** Since this is a known UX cost, consider adding a debug log or trace when a brief falls back to deterministic rendering specifically when `tone = "terse"` is active, so developers/testers can easily measure how often the terse directive causes honesty contract violations.
