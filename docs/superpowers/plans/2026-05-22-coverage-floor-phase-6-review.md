# Phase 6 Coverage Floor Implementation Plan - Review

## Overall Assessment
The implementation plan for "Coverage Floor Phase 6" is exceptionally detailed, well-structured, and appropriately targets the CLI long-tail coverage gaps. The ordering of tasks (from harness foundations -> pure helpers -> stateful helpers -> command families) minimizes risk and ensures robust test utilities are built before tackling complex IPC surfaces.

The attention to detail regarding specific Bun behaviors, like `mock.module` being process-global during coverage and TTY environment variables in CI, demonstrates a deep understanding of the testing environment.

## Open Questions & Suggestions for Improvement

### 1. Enforcing Serial Test Execution
The plan rightly emphasizes that `bun test --concurrent` must never be invoked due to the global fixture state reliance (`globalThis.__nimbusCliFixture`).
**Suggestion:** Consider explicitly adding `--seq` or ensuring the coverage-floor script enforces serial execution programmatically. This prevents accidental regressions if default execution modes change in future Bun versions or if another developer modifies the CI test script.

### 2. Platform Mocking in `paths.test.ts`
In Task 3 (`paths.ts`), the plan accepts that OS-specific path resolution will top out at ~50-60% line coverage because only the current platform's logic is reachable without a source refactor.
**Suggestion:** Instead of refactoring the source code to expose the internal OS constructors, you can mock `process.platform` within the test to exercise all OS branches on a single machine:
```typescript
Object.defineProperty(process, 'platform', { value: 'linux' });
```
*(Make sure to restore the original `process.platform` in `afterEach` or `afterAll`)*. This approach achieves 100% coverage of path resolution logic without structural changes.

### 3. Subprocess Wrapper for Orphan-Reap Pattern
In Task 5, the "Subprocess orphan-reap pattern" requires developers to manually add every spawned process to `liveProcs: Set<Bun.Subprocess>`. If missed, orphan processes might linger.
**Suggestion:** Provide a simple `spawnWrapped` helper in `cli-mocks.ts` or a new test helper that wraps `Bun.spawn` and automatically registers the returned subprocess in the file-level `liveProcs` set. This removes the risk of human error when writing the tests.

### 4. Testing `cli/src/index.ts` Entry Point
Task 1 structurally excludes `cli/src/index.ts` because of the top-level `await main()` execution.
**Suggestion (Long-term):** Wrap the top-level execution in an `if (import.meta.main)` or `if (require.main === module)` (or Bun's equivalent check) block, and export the `main` function. This would allow `index.ts` to be imported and tested in-process for argv dispatching without triggering side effects upon import, potentially eliminating the need for this structural exclusion in the future.

### 5. `mock.module` Dependency Inversion
The plan documents a known constraint with `mock.module` acting process-global when running `bun test --coverage` and mitigates it intelligently via a single `cli-mocks.ts` module.
**Suggestion (Long-term):** While the centralized mock module is a pragmatic fix for this phase, a more durable architectural approach would be dependency inversion—passing `GatewayStateReader` or `IPCClientFactory` as dependencies to the dispatchers instead of importing them directly. This avoids `mock.module` entirely and scales better for concurrent testing.

## Conclusion
The plan is approved to proceed as written. The suggestions above are enhancements to consider either within the execution of this phase (e.g., the `process.platform` mock) or in future refactoring cycles.

---

## Dispositions

Walkthrough of each suggestion with a fix-now / defer decision and rationale. Applied changes land in the implementation plan in the same commit as this review update.

### 1. Enforcing serial test execution — **Defer**

`bun test` has no `--seq` flag. That option is a Vitest/Jest concept. Bun's default is already serial-within-process for test files in one `bun test` invocation; there is no inverse "force serial" flag because serial is the existing default.

A programmatic guard inside `cli-mocks.ts` (e.g. throw if `globalThis.__nimbusCliFixture` is already set when `setFixture` runs) is technically possible, but it would false-positive under nested `describe` blocks where a parent `beforeEach` sets the fixture and a child's `beforeEach` legitimately overrides it before the parent's `afterEach` clears. The cost of the false-positive risk outweighs the benefit.

Existing defenses are sufficient:

- Pre-implementation guardrail #2 in the plan documents the constraint.
- The header comment in `cli-mocks.ts` (Task 2) reiterates "never invoke `bun test --concurrent` against the CLI suite".
- If Bun ever changes its default behavior, the test runner output would surface new flags during the upgrade — a moment that already prompts a re-evaluation of all CI assumptions.

No plan change.

### 2. `process.platform` mock in `paths.test.ts` — **Fix now**

The suggestion is correct AND surfaced a latent bug in the original plan: Task 3's `paths.test.ts` skeleton imported `createWindowsPaths` / `createDarwinPaths` / `createLinuxPaths`, but those functions are NOT exported by `packages/cli/src/paths.ts`. The OS branches are inline inside `getCliPlatformPaths()`, dispatching via `switch (process.platform)`. The original skeleton would have failed at the import line.

Applied fix: replaced the Task 3 paths.test.ts skeleton with a version that:

- Imports only the actually-exported `resolveSocketPath` and `getCliPlatformPaths`.
- Stubs `process.platform` via `Object.defineProperty(process, "platform", { value, configurable: true })` with `PropertyDescriptor`-captured restoration in `afterEach`.
- Drives all three OS branches (win32 / darwin / linux) from a single CI runner.
- Cleanly separates the test into 4 `describe` blocks: `resolveSocketPath`, `getCliPlatformPaths — win32 branch`, `— darwin branch`, `— linux branch`.

**Caveat the plan now documents:** `node:os.homedir()` and `node:os.tmpdir()` read the underlying OS at call time and do NOT change when `process.platform` is stubbed. On Linux CI, `homedir()` returns `/home/user` even when platform is stubbed to `"win32"`. Assertions therefore use `join(homedir(), ...)` against the same operands the source uses, never hardcoded paths (Phase 5 lesson 4 — `node:path.join` portability).

Coverage target rises from "~50-60% on a single OS" to ≥80% on every OS without any source refactor. This is a strict improvement.

### 3. `spawnWrapped` helper — **Defer**

The suggestion is sound: a small wrapper would auto-register subprocesses and eliminate the per-spawn `liveProcs.add(proc)` line. But Task 5 has only 3 test files, each spawning 2-3 subprocesses for ~6-9 manual `add()` calls total. The wrapper saves marginal effort here.

Cost of building the wrapper now: one more helper file (~20 lines), one more pattern for implementers to learn. Cost of NOT building it: implementers follow the documented manual pattern, which is already specified verbatim in Test hygiene §"Subprocess orphan-reap pattern".

Decision: build it if a future phase introduces more subprocess-managing tests (Phase 7's MCP-connector contract tests are unlikely to spawn subprocesses; Phase 8 client/SDK is unlikely too). If Task 5's implementer-review reports the manual pattern was error-prone, file a follow-up to extract the helper.

No plan change. Pattern is already documented.

### 4. Refactor `cli/src/index.ts` to expose `main()` — **Defer**

The suggestion is correct: wrapping the top-level `await main()` in an `if (import.meta.main)` check would let `index.ts` be imported in tests, eliminating the structural exclusion. The pattern is well-established in Node/Bun ecosystems.

But this is a future-phase change. Two reasons:

1. **Consistency requirement.** `packages/gateway/src/index.ts` uses the same top-level-`await main()` pattern and is also structurally excluded (`exclusions.ts:87`). The exemption rationale comment explicitly says "Helpers like `emitSandboxPostureBannerIfDegraded` would need to be extracted to a sibling to test, which is out of scope for this batch." Refactoring `cli/src/index.ts` alone would create inconsistency with the gateway sibling.

2. **Phase 6 scope.** Phase 6's purpose is to close the CLI coverage gap via test additions. The structural exclusion is the spec-sanctioned approach for entry-point files. Refactoring `cli/src/index.ts` would also need a corresponding test file, expanding scope.

If we want to revisit this someday, it's a separate Phase 7+ initiative that also refactors `gateway/src/index.ts` and `packages/github-actions/*/src/main.ts` (also excluded for the same reason). Flag in the spec's "Phase 6 → Phase 7+ transition" section as a candidate.

No plan change.

### 5. Dependency inversion architecture — **Defer**

The suggestion is architecturally correct: passing `GatewayStateReader` / `IPCClientFactory` as constructor or function parameters to dispatchers would entirely eliminate the `mock.module` need for `../lib/gateway-process.ts`.

But the cost is significantly larger than Phase 6's already substantial scope:

- Every command dispatcher signature changes to accept the factory deps.
- 39 source files × bigger refactor each ≈ 39 × 30-50 lines vs Phase 6's current ~10 lines/command sub-handler extraction.
- All 38+ family-commit tests would need updating to pass the new deps.
- The pattern propagates: lib helpers that read gateway state would also need refactoring for consistency.

For comparison, Phase 6 currently sits at 14 commits / ~50 test files / ~199 cases. Adding architectural refactoring on top would balloon the PR by another 14 commits' worth of source-touch work.

The Antigravity suggestion correctly tags this as "Long-term". It belongs in a separate Phase 7+ initiative — likely Phase 9 alongside the gateway `embedding/model.ts` routing-runtime DI refactor that's already deferred to Phase 9. A unified "architectural cleanup" phase could carry both.

No plan change. Reference the architectural direction in the spec's transition section if/when authoring Phase 7's scope.

---

## Summary

| # | Suggestion | Decision | Plan change? |
|---|---|---|---|
| 1 | `--seq` / programmatic serial enforcement | Defer | None — Bun has no such flag; existing guardrails are sufficient. |
| 2 | `process.platform` mock in `paths.test.ts` | **Fix now** | Task 3 paths.test.ts skeleton rewritten to cover all 3 OS branches on a single CI runner. |
| 3 | `spawnWrapped` test helper | Defer | None — manual pattern is documented in Test hygiene; build the helper if a future phase warrants it. |
| 4 | Refactor `cli/src/index.ts` to expose `main()` | Defer | None — would also need `gateway/src/index.ts` for consistency; Phase 7+ initiative. |
| 5 | Dependency inversion for IPC client | Defer | None — Phase 7+ architectural direction; significantly beyond Phase 6's test-adding scope. |

One fix applied, four deferred with explicit rationale. The applied fix also closed a latent plan bug (importing functions that aren't exported). Plan is ready to execute.
