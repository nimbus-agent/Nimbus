# Review: Coverage Floor Phase 5 Design Spec

**Date:** 2026-05-21 (rev 2 — corrected after external design-review feedback)
**Target Spec:** [2026-05-21-coverage-floor-phase-5-design.md](../specs/2026-05-21-coverage-floor-phase-5-design.md)
**Reviewer:** Self-review (same session); point #1 corrected after external design-review at [`2026-05-21-coverage-floor-phase-5-design-review.md`](../specs/2026-05-21-coverage-floor-phase-5-design-review.md) flagged the broken hypothesis.

Phase 5 is shaped as the Gateway-finishing PR — close the long-tail by either testing pinned files (now possible thanks to Phase 4's commit-7 precedent) or honestly admitting structural exclusions. The spec is consistent with Phase 4's structural conventions: low-risk-first commit ordering, per-file triage tables, explicit carry-forwards. Two structural-exclusion calls (`platform/index.ts`, `vault/factory.ts`) are load-bearing and the rest of the scope hinges on hypotheses I verified during the review pass below.

This review surfaces 5 points the plan author should adopt before authoring the implementation plan.

---

## 1. ~~Verified~~ **CORRECTED** — commit 12's test-process isolation hypothesis is WRONG for the coverage build (rev 2)

**Original concern:** Commit 12's `embedding/model.ts` isolation approach claims that placing the test under `packages/gateway/test/integration/embedding/model-isolated.test.ts` gives it a separate process from `create-routing-runtime.test.ts`'s `mock.module("@xenova/transformers", ...)`.

**Original evidence (partial — only covered `test:ci`):** `test:integration` is its own script in root `package.json`:

```json
"test:integration": "bun test packages/gateway/test/integration/ packages/cli/test/integration/"
```

`test:ci` invokes `bun test` first, then `bun run test:integration` as a follow-on shell command — two separate `bun test` invocations. This part of the original evidence still holds, but it's **the wrong process to care about**.

**Correction (external design-review caught this, 2026-05-21):** Coverage measurement is driven by `bun run audit:coverage-floor:build-lcov`, which runs `scripts/coverage-floor/build-lcov.sh`. That script (line 32) does:

```bash
(cd "${pkg}"; bun test --coverage --coverage-reporter=lcov)
```

— **one `bun test` invocation per package**, no path args. `bun test` then discovers ALL `*.test.ts` files recursively in the package, including both colocated `src/embedding/model.test.ts` AND `test/integration/embedding/model-isolated.test.ts`. They share the same bun-test process. They share the same `mock.module` global registry. The collision persists.

**The `test:ci` finding is irrelevant** because Phase 5 is measured against `build-lcov.sh` lcov, not `test:ci` lcov.

**Resolution:** Commit 12 now uses the **extract-and-exclude refactor** (originally listed as fallback). Spec rev 2 makes that approach primary:

- Create `packages/gateway/src/embedding/load-transformer-pipeline.ts` — a 4-line shim around `await import("@xenova/transformers")`.
- `model.ts`'s `createLocalEmbedder` calls `loadTransformerPipeline()` from the sibling.
- `model.test.ts` mocks `./load-transformer-pipeline.ts` — a unique target path that does NOT collide with `create-routing-runtime.test.ts`'s `@xenova/transformers` mock.
- The new shim is added to `EXCLUSIONS` + `sonar-project.properties` in lockstep (commit 12 carries both).

**Plan implication:** Task 12 now refactors `model.ts` to call `loadTransformerPipeline()`, adds the new sibling, adds the exclusion in lockstep, then writes the test against the local mock target. The "isolated test process" framing is dead; do not reintroduce it.

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

## Conclusion (rev 2)

Rev 1 of this review claimed all three big hypotheses held up. The external design-review (at [`docs/superpowers/specs/2026-05-21-coverage-floor-phase-5-design-review.md`](../specs/2026-05-21-coverage-floor-phase-5-design-review.md)) caught that point #1 was load-bearing wrong — `test:integration` is a separate bun-test process from `test` only under `test:ci`; the **coverage build** uses `scripts/coverage-floor/build-lcov.sh` which runs `bun test --coverage` per package and pulls in `test/integration/**/*.test.ts` into the same process as colocated `*.test.ts`. The `mock.module` collision persists.

Spec rev 2 fixes commit 12 to use the extract-and-exclude refactor (introduce `embedding/load-transformer-pipeline.ts` shim, exclude it, mock the local path in `model.test.ts`). The other two hypotheses (commit 7 lifecycle-only test, commit 9 cross-platform `net.createServer`) still hold.

The other four external-review concerns:

- **TUI TTY mocking (concern 2):** Folded into spec's Tier B `App.tsx` row + adds explicit `Object.defineProperty(process.stdout, 'isTTY', ...)` guidance with `afterEach` restore.
- **install-from-local.ts split (concern 3):** Deferred to plan-author judgment with split-criteria added to the spec's Tier C row.
- **socket-listeners.ts shim parity (concern 4):** Risk row now lists the explicit (a)/(b)/(c) parity-bump checklist.
- **Windows long-path cleanup (concern 5):** Out-of-band cleanup section now lists the PowerShell fallback.

**Actions for the plan author (carried into the implementation plan, not back into the spec):**

1. Task 12 (rev 2): refactor `model.ts` to call `loadTransformerPipeline()` from the new sibling; add the sibling to both `EXCLUSIONS` and `sonar-project.properties`; bump count assertions; then write the test against `./load-transformer-pipeline.ts` as the mock target. **Do NOT relocate the test to `test/integration/` — that doesn't isolate it from the colocated test under coverage builds.**
2. Task 7: explicit "lifecycle, not route coverage — see precedent `openapi-route.test.ts`" guidance.
3. Task 9: explicit "use a unix socket path under tmp dir, not a `\\.\pipe\...` path" guidance.
4. Task 10: existing `App.test.tsx` ink-testing-library imports; no `bun add` needed; explicit TTY stubs in `beforeEach` + restore in `afterEach`; watermark fallback if 80% out of reach.
5. Task 11: include a "Read the source and identify uncovered branches" step; **judge whether to split into Tier C-1 + C-2** per the spec's deferred option.

**Spec status (rev 2): ready to inform the implementation plan.**
