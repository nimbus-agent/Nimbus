# Review & Feedback: True Coverage — Sub-project D2 Spec Review

**Review Date:** 2026-06-14  
**Design Document Reviewed:** [2026-06-14-true-coverage-D2-shrink-exclusions-design.md](file:///C:/gitrep/Nimbus/.claude/worktrees/tc-D2/docs/superpowers/specs/2026-06-14-true-coverage-D2-shrink-exclusions-design.md)  
**Status:** Review Feedback / Suggestions / Open Questions

---

## 1. Concurrency and Output Interception in `team.ts` Tests

### Context

In **§4** (Tests), the design mentions:
> Output captured via the existing `captureOutput` helper; no `process.std*` global reliance.

### Open Question / Warning

- **Async Leakage:** Bun executes tests concurrently by default. If `captureOutput` intercepts global output (e.g., patching `process.stdout` or `console.log` globally during a test), output from concurrent test blocks can bleed into each other, leading to flaky assertions.
- **Recommendation:** We should ensure that either:
  1. The test suite for `team.ts` is configured to run sequentially (e.g., using `describe.serial` or similar if supported, or running the assertions synchronously), OR
  2. We inject a mock `console` / custom formatter or pass an output buffer/writer directly into the extracted functions (`runTeamFederationRpc`, `handleConsentNotification`, `renderAuditTable`) so they don't print directly to the global stdout/stderr during test runs. Dependency-injecting the writer is much cleaner and safer for concurrent tests.

---

## 2. Dead Code in `start.ts` (Addressing §5)

### Context

In **§5** (Observed-but-out-of-scope), the spec notes:
> `resolveReadyWaitTimeoutMs` is the only untested pure logic, and `decideStartAction` is **dead** (`runStart` inlines the equivalent decision via `handleExistingGatewayState`, never calling `decideStartAction`). Both are pre-existing; a separate cleanup PR can extract/remove them.

### Suggestion

- **Annotate or Remove:** While major refactoring is out of scope, leaving dead code in a file marked as a documented exclusion makes the codebase harder to maintain.
- **Action:** Since `decideStartAction` is verified dead, we should either:
  - Delete it in this branch (if it is safe and has zero callers), or
  - Annotate it with a clear comment (e.g., `// TODO: Remove - dead code, replaced by handleExistingGatewayState`) to prevent future developers from trying to write tests for it or being confused by it.

---

## 3. RPC Error Handling for `handleConsentNotification`

### Context

In **§4** (Decision 2), the spec proposes extracting:
> `handleConsentNotification(client, params): Promise<void>` — the body of the `client.onNotification("federation.consentRequest", …)` callback.

### Open Question

- **Error Propagation in IPC:** In many JSON-RPC systems, errors thrown inside an asynchronous `onNotification` callback are swallowed or logged by the RPC library and do not bubble up to crash the main process.
- We should verify the error propagation behavior of the underlying Nimbus `IPCClient`.
- Ensure that `handleConsentNotification` wraps its internal logic in a robust `try/catch` and explicitly logs errors or notifies the operator appropriately, rather than relying on the caller's frame to handle errors.

---

## 4. Automation for Type-Only Exclusions (Addressing §6)

### Context

In **§6** (options.ts reclassification), the spec corrects a guess:
> the file is **100% type declarations** ... it emits **no `SF:` lcov record**, so the gate reads it as 0% and it can **never** rejoin the floor.

### Suggestion

- **Pre-flight / Exclusion Auditing Tooling:** If files containing *only* type declarations or interfaces can never be covered (no `SF:` record), we should consider updating the pre-flight scripts or `exclusions.ts` parsing logic in a future phase to automatically ignore any file that lacks executable AST nodes (e.g. using a quick Babel/TypeScript parser check). This will prevent developers from having to manually triage and exclude type-only files in the future.
