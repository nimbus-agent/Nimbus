# Phase 6 Slice 6b — Federated Action Requests — Implementation Plan Review

This document lists open questions, suggestions, and potential improvements identified during the review of the [2026-06-11-phase6-slice6b-federated-action-requests.md](./2026-06-11-phase6-slice6b-federated-action-requests.md) implementation plan.

---

## 1. Open Questions & Plan Discrepancies

### Q1: Timer `.unref()` and Test Execution Hanging

- **Context:** Task 7 Step 3 specifies the `PreflightConsentBroker.request` method with:

  ```typescript
  const timer = setTimeout(() => {
    this.pending.delete(requestId);
    resolve(false);
  }, ttlMs);
  timer.unref?.();
  ```

- **Question:** Does the `timer.unref?.()` call run safely under Bun when the test suite is executed, and will it prevent hanging? If `timeout 60 bun test` executes in an environment that does not support unreffing natively or has constraints on unref timers (as noted in §6 "Timers: TTL timers follow the `bun test` unref-timer guidance — no `.unref()` on an awaited path"), could this cause test execution inconsistencies?
- **Recommendation:** Verify if `unref` behaves perfectly during test runs when resolving timeouts, and ensure the test mocks do not hang if the promise is not explicitly resolved.

### Q2: Exit-Code Leak Mitigation in CLI Tests

- **Context:** Task 13 Step 7 notes that we must reset `process.exitCode` in tests to prevent leaks that can cause the entire test suite run to fail.
- **Question:** Since `process.exitCode` can persist across subsequent test cases in the same Bun process, should we wrap CLI tests in a helper that resets `process.exitCode = 0` in an `afterEach` block?
- **Recommendation:** Explicitly add a `afterEach(() => { process.exitCode = undefined; });` block to `packages/cli/src/commands/preflight.test.ts` to guarantee test isolation.

### Q3: Sandbox CWD Path Isolation

- **Context:** In Task 8 Step 3, the `preflightManifest` function grants the sandbox read/write permissions for `cwd` via:

  ```typescript
  permissions: { filesystem: { read: [cwd], write: [cwd] }, network: [] }
  ```

- **Question:** If `cwd` resolves to a path outside the repository root or workspace (e.g. `/`), does `createSandboxRunner` restrict it, or does the downstream owner have to trust that their own local config `nimbus.toml` doesn't point to high-risk paths?
- **Recommendation:** Although `nimbus.toml` is local and owner-controlled, we should add a quick sanity check in `preflight-runner.ts` (or document the assumption) to ensure `cwd` is absolute or normalized relative to the workspace root to prevent unintended filesystem exposure inside the sandbox.

---

## 2. Suggestions & Improvements

### S1: Unified CLI Option Parser for Federated CLI Commands

- **Problem:** Adding flag parsers across multiple CLI files (`janitor.ts`, `preflight.ts`) might trigger SonarCloud new-code duplication alerts (as mentioned in Task 16 Step 5).
- **Suggestion:** If duplication becomes an issue, consider extracting the string-flag value extractor (`flagValue(args, i, flag)`) into a common utility (e.g., in a helper file or `_agent-brief-cli.ts`) so it can be shared between `janitor.ts` and `preflight.ts`.

### S2: Port binding for Integration Tests

- **Problem:** If parallel execution is enabled in future CI runs, port conflicts on LAN bindings could occur.
- **Suggestion:** Task 15 Step 1 leverages the two-gateway harness that binds `port: 0` (random available port). This is excellent and should be explicitly highlighted in the integration test instructions as a prerequisite to keep the CI environment stable.
