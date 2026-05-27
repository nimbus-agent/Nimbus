# Phase 7 Coverage Floor Implementation Plan — Review

## Overall Assessment

The Phase 7 plan is well-scoped and lower-risk than Phase 6: 7 commits across four packages, only one novel refactor (`model.ts` sibling-shim DI), and 34 of the 41 removed baseline entries are lcov-independent exempt-prunes. The ordering (config prune → pure SDK logic → isolated connector → client DI → client socket → gateway refactor → closeout) front-loads the deterministic work and isolates the two judgement-call files (`ipc-transport.ts`, `model.ts`) into late commits with explicit watermark-hold fallbacks.

The plan correctly internalises the three load-bearing Phase 6 lessons: process-global `mock.module` (only `model.test.ts` uses it, against the shim path, restored in `afterAll`), CI-Linux-authoritative baseline edits (raised drop in Task 7 only, `update-baseline` never run), and the `mkdtempSync` CodeQL sanitiser (Task 5).

## Open Questions & Dispositions

### 1. `__resetJenkinsCrumbCacheForTests` may trip the dead-code audit — **Verify during execution**

- **Observation:** Task 3 adds an exported `__resetJenkinsCrumbCacheForTests()` to production source, used only by the colocated test.
- **Risk:** `bun run audit:dead-code` (knip / D7) could flag a test-only export as an orphan.
- **Disposition:** The repo is test-heavy and almost certainly configures knip to count `*.test.ts` as consumers (otherwise many existing test-only exports would already fail D7). The Task 3 implementer **must run `bun run audit:dead-code` before committing**. If it flags the export, fall back to resetting the cache by re-importing the module under a cache-busting query (`await import("./jenkins-api.ts?t=" + Date.now())`) or add the symbol to the knip ignore list with a one-line comment. Added as an explicit verification step expectation; no plan rewrite needed.

### 2. `ipc-transport.ts` may land below 80% on Linux — **Accepted, watermark-hold fallback**

- **Observation:** `connectWindows` (named pipes) and `connectUnixNode` (the non-Bun branch) are unreachable on the Bun-Linux CI runner. With ~60 of 278 lines in connection paths, the real-socket test may leave the file just under 80%.
- **Disposition:** This is anticipated. The Bun unix path + full dispatch core is the bulk of the file and should clear 80%, but Task 7 Step 1 explicitly checks the CI-Linux number and Step 2 keeps `ipc-transport.ts` at a **raised watermark** (rather than dropping it) if it is genuinely below 80%. Spec acceptance 9 sanctions this. The file still moves from 10.81% to a much higher watermark — net progress even in the worst case.

### 3. `flush()` oversize branch in Task 2 is awkward to hit — **Flagged inline**

- **Observation:** The plan's `flush()`-oversize case duplicates the `push()`-oversize trip (push throws before flush can be reached with an oversized pending buffer).
- **Disposition:** The plan flags this inline ("if coverage shows `flush()`'s limit branch is still uncovered, …") and points at the custom-limit-reader workaround. `flush()`'s other branches (pending-with-CR, empty-pending, normal-pending) are covered by dedicated cases, so the file reaches ≥80% even if the single oversize-in-flush line stays uncovered. Acceptable.

### 4. `NimbusClient` private-constructor cast — **Accepted**

- **Observation:** Task 4 constructs `NimbusClient` via `new (NimbusClient as unknown as { new (ipc): NimbusClient })(ipc)` to bypass the TS-private constructor.
- **Disposition:** `private` is a compile-time-only constraint in TypeScript; the constructor is runtime-callable. The cast is confined to a test helper (`makeClient`) and is the least-invasive way to inject a `FakeIpc` without changing the production class. The existing `nimbus-client-surface.test.ts` already pokes the prototype, so this is consistent with the package's conventions.

### 5. Task 5 `Bun.listen` socket-handler shape — **Read-source-first covers it**

- **Observation:** The exact `Bun.listen({ unix, socket: { open, data } })` handler signatures must match the installed Bun version.
- **Disposition:** Guardrail 7 + Task 5 Step 1 require reading the source and the Bun API first; the test skeleton is illustrative and the implementer adjusts the handler arity to the real API. The unused `open`/`sockets` bookkeeping can be dropped — only `data` (to reply) is load-bearing.

### 6. Two `exclusions.ts` + `sonar-project.properties` edits in one PR (Tasks 1 and 6) — **Accepted**

- **Observation:** The exclusion registry is touched twice (3 entries in Task 1, 1 in Task 6 when the shim is created).
- **Disposition:** Intentional — the shim does not exist until Task 6, so its exclusion cannot be added earlier. Both tasks run `bun run audit:exclusion-parity` immediately after editing, so drift is caught per-commit. Splitting keeps each commit self-consistent (every commit passes parity on its own).

## Conclusion

Approved to execute as written via `superpowers:subagent-driven-development`. The two items needing live verification — the knip dead-code check after Task 3 and the CI-Linux coverage number for `ipc-transport.ts` before its Task 7 drop — are both explicitly wired into the relevant task steps. No plan rewrite required.

## Summary

| # | Item | Decision | Plan change? |
|---|---|---|---|
| 1 | Jenkins test-only export vs knip | Verify in Task 3 | None — verification step expectation noted |
| 2 | ipc-transport possibly <80% | Watermark-hold fallback | None — already in Task 7 + acceptance 9 |
| 3 | flush() oversize branch | Flagged inline | None — already flagged in Task 2 |
| 4 | NimbusClient private-ctor cast | Accepted | None |
| 5 | Bun.listen handler shape | Read-source-first | None |
| 6 | Two exclusion edits | Accepted | None |
