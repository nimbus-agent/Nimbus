# Review of Phase 6 Slice 1 Over-the-Wire Federation Implementation Plan

This document reviews [2026-06-05-phase6-federation-over-the-wire.md](file:///C:/gitrep/Nimbus/.worktrees/dev/asafgolombek/phase6-slice1-federation-wire/docs/superpowers/plans/2026-06-05-phase6-federation-over-the-wire.md) and suggests open questions, design improvements, and refinement steps.

---

## 1. Plan Verification & Scope Analysis

### P1. Transport Configuration Alignment (`[lan]` vs `[federation]`)

* **Plan Task:** Spec refinements (Refinement #1) & Task 10
* **Observation:** The plan states: *"The `LanServer` sources bind/port/pairing/rate-limit from `[lan]`; it is started only when `[federation].enabled`."*
* **Question/Risk:** If a user configures `[lan].enabled = false` but has `[federation].enabled = true`, does the server still start?
* **Recommendation:** Explicitly clarify in the code (Task 10 / `assemble.ts`) that the `LanServer` will boot if *either* `[lan].enabled` is true *or* `[federation].enabled` is true (or if `[federation].enabled` forces `LanServer` boot regardless of `[lan].enabled`'s setting).

### P2. E2E In-Process Socket Lifecycle and Port Allocation

* **Plan Task:** Task 9 (`federation-server.test.ts`) & Task 16 (`two-gateway-wire.integration.test.ts`)
* **Observation:** The tests bind to port `0` to get ephemeral ports, which is excellent for avoiding collisions.
* **Suggestion:** When stopping the server (`await server.stop()`), ensure all active socket connections are forcibly closed/destroyed to prevent tests from hanging or leaking file descriptors under CI. Bun sockets should be closed, and the test teardown (`afterEach`) must wait for the stop promise to resolve completely.

---

## 2. CLI Command and Param Improvements

### C1. Error Handling in `nimbus team consent <requestId> approve|deny`

* **Plan Task:** Task 12
* **Observation:** The runner calls `client.call("federation.consentRespond", ...)` and outputs `consent approved/denied`.
* **Suggestion:** If the `requestId` is invalid, expired, or doesn't exist, the RPC call `federation.consentRespond` might return an error or fail silently. The CLI command should wrap this in a `try/catch` and output a clear error message (e.g. `Error responding to consent request: <error message>`) instead of letting the exception propagate directly as a raw stack trace.

### C2. Handling Cancellation in `nimbus team listen`

* **Plan Task:** Task 13
* **Observation:** Uses `@clack/prompts confirm`.
* **Suggestion:** If the user cancels the prompt using `Ctrl+C` or exits the menu, `isCancel(ok)` evaluates to true. Ensure that if cancelled, the command exits gracefully or skips responding, and does not submit an unintentional `approved: false` response back to the gateway unless that is the desired default behavior.
* **Actionable Improvement:** If `isCancel(ok)` is true, output a cancellation message and exit or ignore, rather than submitting `approved: false` directly.
