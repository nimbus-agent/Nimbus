# Design Review: Why-lens step 2 — SDK → client hop — Implementation Plan

This document reviews [2026-07-24-why-lens-step2-client-hop.md](./2026-07-24-why-lens-step2-client-hop.md) and identifies open questions, potential improvements, and suggestions.

---

## 1. Sync vs Async Methods Consistency

### `agentsWhy` vs `agentsWhyPeek` Implementation

- **Observation:** `agentsWhy` uses `runAgent("why", p, o)` to initiate the agent, which handles background execution, `sessionId`, and waits for the brief. `agentsWhyPeek` directly uses `this.ipc.call("agents.whyPeek", ...)` synchronously.
- **Suggestion:** Verify if the timeout setting handles synchronous methods properly. If `agentsWhyPeek` takes longer (e.g. executing git blame across large files or commits), should it support an optional `timeoutMs` parameter as well? Adding `o?: { timeoutMs?: number }` to `agentsWhyPeek` signature would ensure API parity with the async one and protect client invocations from hanging.

---

## 2. Test Execution Details

### CLI Workspace Verification

- **Observation:** The plan targets three different directories: `C:/gitrep/nimbus-sdk`, `C:/gitrep/nimbus-client`, and `C:/gitrep/Nimbus/.claude/worktrees/why-lens-step2`.
- **Suggestion:** Make sure the tasks explicitly remind the agent or human runner to run `bun install` or similar lockfile updates on the *gateway* side after changing the workspace references, especially since the monorepo structure might hoard node_modules.
- **Bi-directional compilation check:** In Task 8, suggest checking `bun test` inside the gateway before removing `why-types.ts` types to confirm a baseline green, then verifying that the build and type checking remain green after the re-export swap.

---

## 3. Tauri Allowed Methods Audit

### `ALLOWED_METHODS` Check

- **Observation:** Although VS Code is the primary consumer for Step 2a, we should verify if `agents.why` and `agents.whyPeek` need to be exposed via Tauri to support future Tauri-based UI renders.
- **Suggestion:** Add a step in Phase 3 to verify or add these methods to `ALLOWED_METHODS` in `ui/src-tauri/src/gateway_bridge.rs` (Invariant I7). This guarantees that both CLI, extension, and Tauri can access the lens.
