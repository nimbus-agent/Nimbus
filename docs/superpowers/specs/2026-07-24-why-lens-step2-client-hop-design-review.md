# Design Review: Why-lens step 2 — client-hop

This document reviews [2026-07-24-why-lens-step2-client-hop-design.md](./2026-07-24-why-lens-step2-client-hop-design.md) and notes questions, suggestions, and improvements.

---

## 1. Type Unification & Drift Prevention

### `WhyInput` vs `WhyParams`

- **Observation:** The spec suggests keeping `WhyInput` local to the gateway/CLI while the client defines `WhyParams` independently, despite having the exact same structure: `{ ref: string; line?: number }`.
- **Suggestion:** To maximize the "single source of truth" waist pattern, we should consider promoting `WhyParams` (or `WhyInput`) to `@nimbus-dev/sdk` alongside `WhyBrief` and `WhyPeek`. This eliminates type duplication and prevents future parameter drift if additional filtering/parameters are added to the lens.

### Omitted `line` Parameter Mapping

- **Observation:** In request params, `line` is optional (`line?: number`). In `WhyBrief`, the query records it as `line: number | null`.
- **Question:** How does the gateway handle an omitted/undefined `line` internally? Does the RPC handler explicitly map `undefined` to `null` before compiling the `WhyBrief` response? We should ensure the validator and typescript definitions handle this boundary cleanly.

---

## 2. Security & Gateway Integration

### Tauri `ALLOWED_METHODS` Check (Invariant I7)

- **Observation:** While the immediate target is the VS Code extension via the client, the desktop app (Tauri) might eventually want to display the hover lens.
- **Question:** Do `agents.why` and `agents.whyPeek` need to be explicitly added to `ALLOWED_METHODS` in [gateway_bridge.rs](../../../packages/ui/src-tauri/src/gateway_bridge.rs)? Even if Tauri support is a future goal, checking if the current IPC setup guards these methods at the Tauri boundary is a good pre-flight step.

### Circular Dependency Risk

- **Observation:** The gateway's `agents/_lib/why-types.ts` is planned to re-export the promoted types from `./findings.ts`.
- **Suggestion:** Run `bun run audit` or check dependency flows to ensure that re-exporting through `findings.ts` does not introduce any circular imports within the gateway's `agents/_lib/` directory.

---

## 3. Mock & Validation Robustness

### Fixture Completeness

- **Observation:** The Mock client (`src/mock-client.ts`) needs to expose a deterministic mock `WhyBrief` and `WhyPeek`.
- **Suggestion:** Ensure the mock fixtures populate realistic values for all lanes (`WhyLane`) and nullable fields (`subject`, `author`, `pr`, `ticket`) so that consumer UI testing gets high-fidelity mock representations.

### Schema Validation

- **Observation:** `validateWhyPeek` will shape-check `WhyPeek`.
- **Question:** Should we ensure the validator accepts extra fields gracefully (e.g., ignoring extra fields instead of failing fast) to allow future gateway-side additions to `WhyPeek` without breaking older clients?
