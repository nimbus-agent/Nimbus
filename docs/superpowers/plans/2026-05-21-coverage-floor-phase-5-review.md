# Review: Coverage Floor Phase 5 Design Spec

**Date:** 2026-05-21
**Target Spec:** [2026-05-21-coverage-floor-phase-5-design.md](../specs/2026-05-21-coverage-floor-phase-5-design.md)
**Reviewer:** Self-review (same session)

Phase 5 is shaped as the Gateway-finishing PR — close the long-tail by either testing pinned files (now possible thanks to Phase 4's commit-7 precedent) or honestly admitting structural exclusions. The spec is consistent with Phase 4's structural conventions: low-risk-first commit ordering, per-file triage tables, explicit carry-forwards. Two structural-exclusion calls (`platform/index.ts`, `vault/factory.ts`) are load-bearing and the rest of the scope hinges on hypotheses I verified during the review pass below.

This review surfaces 5 points the plan author should adopt before authoring the implementation plan.

---

## 1. Verified: `bun test` and `bun run test:integration` are separate processes (good news for commit 12)

**Concern:** Commit 12's `embedding/model.ts` isolation approach claims that placing the test under `packages/gateway/test/integration/embedding/model-isolated.test.ts` gives it a separate process from `create-routing-runtime.test.ts`'s `mock.module("@xenova/transformers", ...)`. If they're the same `bun test` invocation, the mock state collides regardless of file path.

**Evidence:** Inspected the root `package.json`. `test:integration` is its own script:

```json
"test:integration": "bun test packages/gateway/test/integration/ packages/cli/test/integration/"
```

And `test:ci` invokes `bun test` first, then `bun run test:integration` as a follow-on shell command — two separate `bun test` invocations, two separate Node-ish processes, two independent `mock.module` global registries.

**Conclusion:** Commit 12's isolation approach works because of how the CI scripts invoke bun, not because of the directory placement alone. The plan should make this explicit so a future reader doesn't try to move the test back to a colocated `*.test.ts` under `embedding/` and re-introduce the collision. **Plan should add an explicit "Why a separate integration test process?" note in Task 12.**

---

## 2. Verified: `startReadOnlyHttpServer` integration tests have well-established precedent

**Concern:** Commit 7 calls for spawning the HTTP server with `port: 0` and making real `fetch` calls. Does that pattern already exist in the repo? Spec implies yes ("already supports `port: 0`") but doesn't cite test precedent.

**Evidence:** Found three precedent tests:

- [`packages/gateway/test/integration/http/openapi-route.test.ts`](../../packages/gateway/test/integration/http/openapi-route.test.ts)
- [`packages/gateway/test/integration/http/metrics-dora-route.test.ts`](../../packages/gateway/test/integration/http/metrics-dora-route.test.ts)
- [`packages/gateway/test/integration/http/deployments-post-route.test.ts`](../../packages/gateway/test/integration/http/deployments-post-route.test.ts)

All three follow the same pattern: `startReadOnlyHttpServer(dbPath, 0)` → grab `handle.port` → `fetch(\`http://127.0.0.1:${port}/...\`)`. tmp-dir + empty SQLite per test.

**Implication for commit 7:** The 65.12% baseline already comes from these route-targeted tests. The 35% uncovered isn't route coverage — it's the **lifecycle scaffolding** (the `Bun.serve` shape itself, the `stop()` cleanup arms, the write-surface POST mounting branch, the 405-on-known-write-path branch). Commit 7's test file should target lifecycle, not re-implement route tests. **Plan should make this explicit so the implementer doesn't duplicate work already done by `openapi-route.test.ts` et al.**

---

## 3. Verified: `socket-listeners.ts`'s "win32" functions are cross-platform-testable

**Concern:** Commit 9 claims `startWin32NetServer` is "cross-platform-testable on Linux" despite its name. Important — if false, commit 9 needs split or partial-coverage planning.

**Evidence:** Read the implementation (lines 59-74 of `socket-listeners.ts`). The function uses `net.createServer(...)` + `.listen(listenPath, ...)`. These are pure Node `net` module APIs. On Linux, `net.createServer().listen("/tmp/nimbus-test.sock", ...)` creates a unix domain socket. On Windows, the same code with a `\\.\pipe\...` path creates a named pipe. The `Win32` in the function name signals *production intent* (it's the Windows code path), not platform requirement of the implementation.

**Conclusion:** Test passes a unix socket path on Linux CI; it works. **Plan should note this hypothesis as confirmed and call out that the test must use a tmp-dir unix socket path, not a `\\.\pipe\...` path** (the latter would silently fail on Linux).

---

## 4. Verified: `ink-testing-library` is already a CLI dependency

**Concern:** Commit 10 plans to extend `App.tsx` coverage via `ink-testing-library`. Is it a declared dependency? If not, the plan needs a `bun add -d ink-testing-library` step gated by `bun run check-package` per CLAUDE.md's dependency-safety rule.

**Evidence:** `grep "ink-testing-library" packages/cli/package.json` returns `"ink-testing-library": "^4.0.0"`.

**Conclusion:** Already a dependency. No `bun add` needed in commit 10. The plan should reference the existing `App.test.tsx` pattern (155 lines, likely already imports `ink-testing-library`) and just add cases.

---

## 5. Spec gap: `install-from-local.ts` 808-line investment isn't budgeted

**Concern:** The spec mentions install-from-local.ts is 808 lines (3x larger than Phase 4's largest single-file commit, `mesh.ts` at ~500 lines, which got 8 cases). Spec budgets "~7" cases but doesn't bound the investment.

**Recommendation:** Two clarifications belong in the spec — adopt either both or neither:

a) **Set a soft upper bound.** "If 80% requires >12 cases after the first read pass, raise watermark to the new measured value and document residual in PR body" — standard spec rule 3 fallback. Phase 4 commit 9 (`worker-bridge.ts`) used this exact escape.

b) **Identify the load-bearing uncovered branches in the spec.** The plan author should grep `src/extensions/install-from-local.ts` for `completeExtensionInstallAfterCopy`, `verifyManifestSignature`, `appendAuditEntry` and confirm which of those code paths the existing test does NOT cover. If the I16-related branches are already covered (likely — they were added in T2 PR 2), the remaining gap is probably error-handling shells which need fewer cases than feared.

**Effort to apply:** 30 minutes of source-reading + a sentence in the spec. **Plan author should do this read during plan authoring; recommend the spec stays as-is and the plan's Task 11 carries the specific branch list.**

---

## 6. Minor: `App.tsx` 363-line file may not reach 80% via state-machine tests alone

**Concern:** Commit 10 plans to extend coverage via "state-machine transitions". `App.tsx` is React Ink — much of its 363 lines is conditional JSX render logic for sub-components like `QueryInput`, `ConnectorHealth`, `WatcherPane`. State-machine tests cover decision points; rendered JSX is only covered when a child component is actually mounted.

**Mitigation:** Already in Risks table — "Raise watermark if 80% isn't reached." Good. **No spec change needed.** The plan should reiterate the partial-watermark fallback in Task 10's checklist so the implementer doesn't burn cycles chasing 80% if the render branches are genuinely hard.

---

## Conclusion

The spec is internally consistent, mirrors Phase 4 conventions cleanly, and its three biggest load-bearing hypotheses (test-process isolation for commit 12, cross-platform `net.createServer` for commit 9, `port: 0` integration-test precedent for commit 7) all hold up under inspection. The structural-exclusion calls for `platform/index.ts` + `vault/factory.ts` are well-justified — they mirror the existing `sandbox-runner.ts` exclusion verbatim in shape.

**Actions for the plan author (carried into the implementation plan, not back into the spec):**

1. Task 12: explicit "Why a separate integration test process?" note citing `package.json:86`.
2. Task 7: explicit "lifecycle, not route coverage — see precedent `openapi-route.test.ts`" guidance.
3. Task 9: explicit "use a unix socket path under tmp dir, not a `\\.\pipe\...` path" guidance.
4. Task 10: explicit "use existing `App.test.tsx` ink-testing-library imports; no `bun add` needed" + reiterate watermark fallback.
5. Task 11: include a "Read the source and identify uncovered branches" step (Phase 4 Task 7 did this for `mesh.ts` and it worked).

None of these are spec-changing — they're plan-level execution guidance that prevents the implementer from re-discovering the same hypotheses.

**Spec status: ready to inform the implementation plan.**
