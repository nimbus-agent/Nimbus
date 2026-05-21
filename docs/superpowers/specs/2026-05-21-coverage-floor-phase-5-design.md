# Coverage Floor Phase 5 — Finish the Gateway

**Date:** 2026-05-21
**Spec parent:** [`2026-05-17-coverage-floor-design.md`](./2026-05-17-coverage-floor-design.md) §"Phasing"
**Direct predecessor:** [`2026-05-20-coverage-floor-phase-4-design.md`](./2026-05-20-coverage-floor-phase-4-design.md)
**Branch:** `dev/asafgolombek/coverage-floor-phase-5-2026-05-21`
**Worktree:** `.worktrees/coverage-floor-phase-5-2026-05-21/`
**Branched from:** `main` at `5e660ecf` (Phase 4 merge, PR #375)

---

## Goal

Finish the Gateway long-tail. Either get the Gateway baseline entries above the
80% per-file line-coverage floor, or admit honest structural exclusions where a
file is genuinely untestable on a single OS in a Linux CI run (parallel to
`platform/sandbox/sandbox-runner.ts`'s existing exclusion).

Concretely:

- Drop **6 stale baseline entries** that Phase 4 commit 1 left in `coverage-baseline.json` even though their files were structurally excluded in the same PR.
- Re-examine **8 historically-pinned files** (Phase 2B + Windows-regression) per the user's "per-file honest decision" framing. Test six; structurally exclude two.
- Close out **5 Phase 4 partials** stranded in the 73–79% band.
- Cover the **2 dependency-resolution files** PR #374 introduced that landed in baseline (`extensions/install-from-local.ts` 66.9%, `extensions/registry-fetcher.ts` 0%).
- Retry **`embedding/model.ts`** (13.51%) — last commit's `mock.module` collision can be unblocked by running its test in an isolated bun process.

The PR is shaped as one bundled PR per the precedent of PR #365 (Phase 2C),
PR #369 (Phase 3A), PR #370 (Phase 3B-rest), and PR #375 (Phase 4).

**Expected outcome:** baseline drops from 116 → ~94 entries (about 22 entries removed: 14 raised to ≥80% [5 Tier A + 6 testable Tier B + 2 Tier C + 1 Tier D retry] + 2 newly structurally excluded + 6 stale housekeeping). The remaining ~94 entries are entirely outside the Gateway and packaged for Phase 6+ work:

- ~51 CLI entries (`commands/*.ts`, `lib/*.ts`, `tui/App.tsx`, `paths.ts`, `index.ts`, `types/agents.ts`)
- ~5 client entries (`@nimbus-dev/client`)
- ~4 SDK entries (`crypto/canonical-json.ts`, `crypto/verify-signature.ts`, `ipc/index.ts`, `ipc/ndjson-line-reader.ts`)
- ~30 mcp-connectors entries (every `**/server.ts` plus `jenkins/src/jenkins-api.ts`)
- (Voice and any other Phase 4 partial-raise watermarks ride along)

After Phase 5 the Gateway baseline is empty (or near-empty, only `embedding/model.ts` if the isolation retry lands at a raised watermark instead of ≥80%) — every remaining Gateway file is either ≥80% or in `EXCLUSIONS`.

---

## Scope

### Tier S — Housekeeping (zero risk)

The 6 entries below were marked for removal in Phase 4 commit 1 (Task 1 Step 6) but ended up retained in `coverage-baseline.json` after the final `update-baseline` regenerated the file. They are listed in `EXCLUSIONS` already, so the floor gate doesn't fail on them — but they're stale and inflate the baseline count.

| File | Baseline | Why it's stale |
|---|---|---|
| `packages/gateway/src/connectors/index.ts` | 0% | Already in `EXCLUSIONS` (line 60, pure re-export) |
| `packages/gateway/src/db/query-guard-worker.ts` | 0% | Already in `EXCLUSIONS` (line 71, Bun Worker entry) |
| `packages/gateway/src/embedding/embedding-runtime.ts` | 0% | Already in `EXCLUSIONS` (line 87, type-only) |
| `packages/gateway/src/embedding/embedding-worker.ts` | 0% | Already in `EXCLUSIONS` (line 72, Bun Worker entry) |
| `packages/gateway/src/index/ranked-item.ts` | 0% | Already in `EXCLUSIONS` (line 88, type-only) |
| `packages/gateway/src/vault/nimbus-vault.ts` | 0% | Already in `EXCLUSIONS` (line 89, interface-only) |

### Tier A — Phase 4 partials (75–79% band, 1–2 cases each)

| File | Baseline | Approach |
|---|---|---|
| `packages/gateway/src/agents/impact.ts` | 77.81% | Cover empty-corpus path + LLM-disabled deterministic fallback |
| `packages/gateway/src/db/verify.ts` | 78.44% | 1–2 extra cases — FTS5-orphan or schema-newer remaining branches |
| `packages/gateway/src/embedding/create-embedding-runtime.ts` | 77.38% | One extra branch — likely OpenAI-API-key-empty vs missing vs valid distinction |
| `packages/gateway/src/platform/assemble.ts` | 77.75% | 1–2 extra cases — likely a `XDG_*` env permutation Phase 4 didn't quite reach |
| `packages/gateway/src/connectors/filesystem-v2-sync.ts` | 73.82% | 2–3 cases via `connector-sync-harness.ts` |

These are honest 1-test-each wins. Bundle into a single commit per Phase 4 commit 2 precedent.

### Tier B — Pinned files: test

Each of the six files below has a real, tractable coverage path that was simply never written.

| File | Baseline | Approach |
|---|---|---|
| `packages/gateway/src/ipc/http-server.ts` (417 L) | 65.12% | New test file. Spawn server with `port: 0` (already supported, lines 305-307), make real `fetch` calls. Cases: GET happy path, 405 on POST without write surface, 405 on GET targeting a write-only route, 404, write-surface mounted with `resolveDeploymentToken`, cleanup branches. |
| `packages/gateway/src/ipc/server/server.ts` (259 L) | 76.7% | Extend the existing 89-line test. Cover the listener-startup arm (Linux: `startBunUnixListener` path; Windows: `startWin32NetServer` path) using a `tmp/<uuid>.sock` listenPath. |
| `packages/gateway/src/ipc/server/socket-listeners.ts` (102 L) | 45.21% | New test file. Pure helpers (`removeStaleUnixSocketIfPresent`, `chmodListenSocketBestEffort`) tested directly. `attachWin32Socket` is cross-platform-testable — it's event-listener wiring on a `net.Socket`; use `net.connect()` against a real `net.createServer()` to drive it. `startBunUnixListener` covered via `Bun.listen` on a tmp socket + client connect. `startWin32NetServer` covered on Linux too (it just uses `net.createServer`, the "win32" in the name signals intent, not platform requirement). |
| `packages/gateway/src/platform/paths.ts` (73 L) | 39.62% | New test file. All three functions are pure, exported, parameterized by env vars. Stub `processEnvGet` with `mock.module("./env-access.ts", ...)`. Easy 100%. The reason it's at 39% is *no test exists*, not that it's untestable. |
| `packages/cli/src/tui/App.tsx` (363 L) | 57.6% | Extend the existing 155-line test using `ink-testing-library` (already a CLI dep at `^4.0.0`). Drive state transitions: idle → streaming → awaiting-hitl → disconnected. The TUI state machine `tui/state.ts` is already covered; this is about exercising the surface that reacts to it. **TTY guard:** `App.tsx` reads `process.stdout.isTTY` / `.columns` / `.rows` (mirroring `detect-fallback.ts`'s checks) and falls back to a non-Ink branch when those are absent. Headless CI has `isTTY=false`. The test setup must explicitly stub TTY properties via `Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })` + restore in `afterEach`, otherwise tests silently exercise the fallback render path (not the interactive surface they aim to cover) and 80% won't be reached. |
| `packages/cli/src/tui/detect-fallback.ts` (44 L) | 69.23% | Extend the existing 53-line test. Cover `currentFallbackEnv()` (reads from `process.stdout`/`process.env` globals) and any first-match branches of `detectFallbackReason` not exercised. Trivial. |

### Tier B — Pinned files: structurally exclude

Both files are async per-OS dispatchers identical in shape to the already-excluded `platform/sandbox/sandbox-runner.ts`. Their existing test file headers (lines 1-17 each) admit that only the freebsd default branch is cross-OS reachable: the `case "win32" | "darwin" | "linux"` arms each call `await import("./<os>.ts").create()` (or `.DpapiVault(...)`) and the actual module load fails on the wrong OS.

| File | Baseline | Justification |
|---|---|---|
| `packages/gateway/src/platform/index.ts` (35 L) | 63.64% | Async dispatcher. Existing test file's own header admits only the default branch is reachable. Direct parallel to `platform/sandbox/sandbox-runner.ts` (already excluded line 52, `EXCLUSIONS`). |
| `packages/gateway/src/vault/factory.ts` (23 L) | 75% | Identical pattern. Existing test header makes the same admission. |

The added exclusion comment in `EXCLUSIONS` references the parallel to `sandbox/sandbox-runner.ts`. The existing tests stay in place — they cover the unsupported-platform default branch and prove the `PlatformInitError` re-export contract.

### Tier C — Extensions / T2 PR 4 carryover

| File | Baseline | Approach |
|---|---|---|
| `packages/gateway/src/extensions/registry-fetcher.ts` (50 L) | 0% | New test file. Cases: in-vault publisher key path, missing-key path, on-disk manifest lookup for installed dep, registry-unreachable fallback. |
| `packages/gateway/src/extensions/install-from-local.ts` (808 L) | 66.9% | Extend the existing test if present (likely is, given the 66.9% measurement). Target the audit-on-rejection paths, the `completeExtensionInstallAfterCopy` failure modes, and the signature-mismatch branches. ~6-8 cases. **Read the source first** to confirm which branches are uncovered; the cases below are guesses. **The plan author may split this into two commits (Tier C-1: error-handling / early-rejection branches; Tier C-2: signature-verification branches) if the read-pass identifies two clearly disjoint mock surfaces** — same surgical-revertability rationale as Phase 4's mesh.ts split. Decision deferred to plan-authoring time, not mandated here. |

### Tier D — Phase 4 hard one (retry)

| File | Baseline | Approach |
|---|---|---|
| `packages/gateway/src/embedding/model.ts` (64 L) | 13.51% | Phase 4 hit a `mock.module("@xenova/transformers", ...)` collision because `embedding/create-routing-runtime.test.ts` mocks the same module path. Bun's `mock.module` is process-global, and — confirmed against `scripts/coverage-floor/build-lcov.sh` — that script runs `bun test --coverage` once per package, picking up both colocated `*.test.ts` and `test/integration/**/*.test.ts` in a single bun-test process. **Process isolation via the `test:integration` script does NOT propagate to coverage builds**, so re-homing the test file alone does not solve the collision. **Fix: extract-and-exclude refactor.** Create `packages/gateway/src/embedding/load-transformer-pipeline.ts` (a tiny 4-line module wrapping `await import("@xenova/transformers")`). Have `model.ts` call `loadTransformerPipeline()` from the sibling. `model.test.ts` mocks `./load-transformer-pipeline.ts` (unique target path — no collision with `create-routing-runtime.test.ts`'s `@xenova/transformers` mock). Add the new sibling to `EXCLUSIONS` with a "thin dynamic-import shim" rationale comment (parallel to `vault/ffi-ptr.ts`'s exclusion). `model.ts` itself becomes test-friendly and reaches 80%+ via cases for `createLocalEmbedder` (init success, init failure, embed-with-mock-pipeline, empty-input early-return) + `tensorToRowVectors` (1×384 + 2×384 batch). Final fallback per spec rule 3 is raised watermark. |

### Out of scope (pinned for Phase 6+)

Untouched. These remain in baseline at their current watermarks:

| Bucket | Count | Examples |
|---|---|---|
| CLI commands | ~38 | `commands/ask.ts` 4.76, `commands/audit.ts` 4.21, … 38 files, most <20% |
| CLI lib | ~10 | `lib/cli-logger.ts` 18.18, `lib/gateway-process.ts` 15.22, … |
| CLI misc | 3 | `paths.ts` 46.48, `index.ts` 0, `types/agents.ts` 6.67 |
| Client package | 5 | `client/src/{index,ipc-transport,mock-client,nimbus-client,stream-events}.ts` |
| SDK | 4 | `crypto/canonical-json.ts` 30.77, `crypto/verify-signature.ts` 18.68, `ipc/index.ts` 0, `ipc/ndjson-line-reader.ts` 2.94 |
| MCP connectors | ~30 | every `**/server.ts` at 0%, plus `jenkins/src/jenkins-api.ts` 17.89 |

Phase 6 (proposed): CLI commands en masse with a shared `MockClient`-driven harness. Phase 7: MCP connectors via a shared contract-test harness. Phase 8: client + SDK final cleanup. Sequenced this way because each non-gateway bucket needs its own harness design discussion — not a long-tail nudge.

---

## Commit Structure

Single PR, 13 commits ordered low-risk → high-risk:

| # | Commit subject | Files | New tests |
|---|---|---|---|
| 1 | `chore(coverage-floor): drop 6 stale baseline entries already in structural exclusions` | `coverage-baseline.json` | 0 |
| 2 | `chore(coverage-floor): structurally exclude per-OS async dispatchers (platform/index.ts + vault/factory.ts)` | `exclusions.ts` + `sonar-project.properties` + `coverage-baseline.json` | 0 (existing parity test covers) |
| 3 | `test(near-floor): finish 5 Phase 4 partials (Tier A)` | 5 gateway files | ~8 |
| 4 | `test(platform): cover paths.ts cross-platform via env stubbing` | 1 file | ~5 |
| 5 | `test(tui): nudge detect-fallback.ts above 80%` | 1 file | ~2 |
| 6 | `test(extensions): cover registry-fetcher.ts (Tier C)` | 1 file | ~4 |
| 7 | `test(ipc): cover http-server.ts via spawned port:0 fixture (Tier B)` | 1 file | ~6 |
| 8 | `test(ipc): cover server/server.ts listener startup arm (Tier B)` | 1 file (extend existing) | ~3 |
| 9 | `test(ipc): cover socket-listeners.ts helpers + attach + listen (Tier B)` | 1 file | ~6 |
| 10 | `test(tui): extend App.tsx coverage via ink-testing-library (Tier B)` | 1 file (extend existing) | ~4 |
| 11 | `test(extensions): raise install-from-local.ts above 80% (Tier C)` | 1 file (extend existing) | ~7 |
| 12 | `test(embedding): refactor model.ts to use load-transformer-pipeline shim + cover model.ts (Tier D retry)` | 2 files (new `embedding/load-transformer-pipeline.ts` source + `embedding/model.test.ts`) + `exclusions.ts` + `sonar-project.properties` | ~6 (or partial + raised watermark) |
| 13 | `chore(coverage-floor): drop raised entries + Phase 5 plan + spec` | `coverage-baseline.json`, plan, spec, `CLAUDE.md` + `GEMINI.md` status row | 0 |

**Totals:** ~51 new tests across ~12 test files + 3 exclusion entries (commit 2: `platform/index.ts` + `vault/factory.ts`; commit 12: `embedding/load-transformer-pipeline.ts`) + 6 stale baseline housekeeping + final baseline drop. The new `embedding/load-transformer-pipeline.ts` source file is created in commit 12, not commit 2 — its exclusion lands in lockstep with the file's introduction.

**Ordering rationale:**

- Commits 1+2 ship first because they're pure-config (zero reversibility risk).
- Tier A (commit 3) is the easiest fail-safe win — locks in Phase 4 leftovers.
- Small-file Tier B nudges (commits 4–6) come before the harder Tier B integration tests.
- The hardest Tier B file (`http-server.ts` integration tests, commit 7) lands mid-PR with room either side for fixups.
- Tier C / install-from-local (commit 11) is the largest single test investment — placed late so easier work isn't gated by its mock surface.
- Tier D retry (commit 12) is last among test commits so any `mock.module` isolation surprises don't gate progress on easier work.
- Final commit (13) lands baseline drops + spec + plan + CLAUDE/GEMINI status row together.

---

## Test Infrastructure

**No new shared harness needed.** Reuse existing infrastructure:

| Pattern | Used by |
|---|---|
| Spawned `Bun.serve` with `port: 0` + real `fetch` | `ipc/http-server.ts` (commit 7) |
| Spawned `Bun.listen` / `net.createServer` on tmp socket | `ipc/server/server.ts` (commit 8), `ipc/server/socket-listeners.ts` (commit 9) |
| `ink-testing-library` driving state-machine props | `cli/src/tui/App.tsx` (commit 10) |
| `MockVault` from `@nimbus-dev/sdk/testing` | `extensions/install-from-local.ts` (commit 11), `extensions/registry-fetcher.ts` (commit 6) |
| `connector-sync-harness.ts` (Phase 2) | `connectors/filesystem-v2-sync.ts` (commit 3) |
| `mock.module("./env-access.ts", ...)` env stubbing | `platform/paths.ts` (commit 4) |
| Extract-dynamic-import-to-shim refactor + mock the sibling shim path (no collision with sibling tests that mock `@xenova/transformers`) | `embedding/model.ts` (commit 12) |
| Tmp-dir + real fs ops | `extensions/install-from-local.ts` (commit 11), `ipc/server/socket-listeners.ts` (commit 9) |

**Test file locations:** colocated next to source file per Phase 3/4 precedent — `<name>.test.ts` next to `<name>.ts`. `embedding/model.test.ts` stays colocated; the `mock.module` collision with `create-routing-runtime.test.ts` is solved at the *target* layer (commit 12 introduces a new sibling `load-transformer-pipeline.ts` that `model.test.ts` mocks, leaving `@xenova/transformers` for `create-routing-runtime.test.ts` to mock independently) rather than at the test-discovery layer (which `build-lcov.sh` collapses into one bun-test process per package regardless of `test/integration/` placement).

---

## Carry-forwards from Phase 4

All Phase 4 carry-forwards apply identically. Repeating them here so the implementer doesn't have to cross-reference:

- **CI Linux is authoritative.** Local Windows lcov diverges on a known set of pinned files. Never lower a baseline watermark to match local Windows lcov — only match CI Linux.
- **TS strictness modes that trip during test authoring:**
  - `noUncheckedIndexedAccess` — `arr[i]` is `T | undefined`; use `arr[i]?.field`
  - `noPropertyAccessFromIndexSignature` — `Record<string, unknown>` needs bracket access `obj["key"]`
  - `exactOptionalPropertyTypes: true` — pass no property instead of `prop: undefined`
- `bun:test`'s `test.each(table)` requires a **mutable** array — never `readonly T[]`.
- For `fetch` stubs: closures that throw infer `Promise<never>` and need `as unknown as typeof fetch`; closures that return `Response` use plain `as typeof fetch`.
- `mock.module(...)` is process-global; sibling test files that mock the same module path collide. Commit 12's separate-process placement is the explicit answer to this.
- IDE false positives to ignore: `await expect(...).rejects.toThrow(...)` "await has no effect", `bun:sqlite` / `bun:test` "declared but never read" on used imports.
- `db.run` / `db.exec` in test files is fine (static auditor skips `*.test.ts`).
- Run `bun run lint:fix` before every commit.
- The plan's per-file case suggestions are *guesses*. Read the source FIRST; target the actual uncovered branches; document divergence in implementer reports.

---

## Acceptance

1. `bun run audit:coverage-floor:build-lcov && bun run audit:coverage-floor` exits 0 locally (CI Linux is authoritative for the merge gate).
2. `bun run audit:exclusion-parity` exits 0 — `sonar-project.properties` and `exclusions.ts` agree on the 2 new entries.
3. `bun run audit:invariants` exits 0 — D10 / D12 / vault-key allow-list unchanged.
4. `bun run lint` + `bun run typecheck` exit 0.
5. Baseline file's `min_coverage_pct` either rises to the new measured value (only for `embedding/model.ts` if isolation fallback engages) or the entry is dropped entirely (all other targets).
6. ~22 baseline entries are removed (14 raised + 2 moved to exclusions + 6 stale housekeeping); none added. The only exception is `embedding/model.ts` if the isolation retry doesn't reach 80% — that entry stays at a raised watermark, not dropped.
7. No file currently above 80% drops below 80% — checked by the floor gate.
8. The 6 explicitly-out-of-scope buckets (CLI commands, CLI lib, CLI misc, client, SDK, mcp-connectors) remain untouched at their current baseline watermarks.

---

## Risks

| Risk | Mitigation |
|---|---|
| `http-server.ts` integration tests racy on shared CI runners (port-bind collisions) | The source already supports `port: 0` for OS-assigned free ports. Use that exclusively; never pass a hardcoded port. Confirm via `handle.port` in test assertions. |
| `socket-listeners.ts` Windows-only functions (`startWin32NetServer`, `attachWin32Socket`) measured as 0% on Ubuntu CI even though the implementation is cross-platform | The functions use plain `net` module APIs (`net.createServer`, `net.Socket`) which work cross-platform. The function names imply Windows but the code does not. Tests pass a unix-socket path under tmp dir (e.g. `mkdtempSync(...)` + `nimbus-test.sock`), **never** a `\\.\pipe\...` path (the latter would silently fail on Linux). If it turns out platform-specific behavior is genuinely involved (named pipes), split the file: extract the cross-platform pure-handler logic to `socket-listeners.ts`, leave a tiny `win32-listener.ts` shim, exclude the shim. **Parity-bump checklist for the split case:** (a) add `win32-listener.ts` to `EXCLUSIONS` in `scripts/coverage-floor/exclusions.ts`, (b) mirror the same path in `sonar-project.properties` under `sonar.coverage.exclusions`, (c) verify `bun run audit:exclusion-parity` exits 0 before the commit lands — skipping (b) is the most common parity-check failure mode. |
| `App.tsx` ink-testing-library state-machine drive proves harder than expected (363 lines of React Ink) | Cover the top-level state-machine transitions only — disconnected → connecting → idle → streaming → awaiting-hitl → idle. Don't try to exercise every render branch. Raise watermark if 80% isn't reached. |
| `install-from-local.ts` (808 lines) — large mock surface; getting from 66.9% → 80% may need substantial test growth | Read the source first to identify the specific uncovered branches. The file has a strict `completeExtensionInstallAfterCopy` + I16 signature verification path; tests should target those branches deliberately. |
| `embedding/model.ts` refactor (commit 12) — the `load-transformer-pipeline.ts` shim must be importable as a typed function from `model.ts` without changing `model.ts`'s public API | The shim is 4 lines: `export async function loadTransformerPipeline(): Promise<typeof pipeline> { return (await import("@xenova/transformers")).pipeline; }`. `model.ts`'s `createLocalEmbedder` calls `loadTransformerPipeline()` instead of `await import(...)` directly. Public exports of `model.ts` (`createLocalEmbedder`, `tensorToRowVectors`) are unchanged — no caller refactor needed. If the typed return signature proves awkward to express, drop typing and accept `unknown` at the shim boundary. Final fallback: raised watermark for `model.ts`. |
| `platform/index.ts` + `vault/factory.ts` exclusion comments need to reference `platform/sandbox/sandbox-runner.ts` precedent exactly | The `EXCLUSIONS` registry has explicit rationale comments for parallel cases (line 46-52 for sandbox-runner.ts). Mirror that comment style — name the parallel file and the dynamic-import-with-side-effects reason. Saves future reviewers the spelunking. |
| 6 stale baseline housekeeping (commit 1) might surprise the floor gate if any file's coverage actually went 0% → measurable since Phase 4 merge | Run `bun run audit:coverage-floor:build-lcov && bun run audit:coverage-floor` after the drop. If any of the 6 files now has measurable coverage that's >80%, no change needed (exclusion takes precedence anyway). If <80%, the exclusion still wins — but verify visually in the diff. |

---

## Out-of-band cleanup

Before starting the Phase 5 worktree, `rm -rf` any stale Phase 4 worktree directory left over from PR #375 (Windows "Filename too long" historically prevents `git worktree remove` cleanup; the branch is already gone).

**Windows long-path fallback:** Git Bash's `rm -rf` may itself fail on deep `node_modules` hierarchies on Windows (the same "Filename too long" symptom). If it does, drop into PowerShell and run `Remove-Item -LiteralPath '.worktrees/coverage-floor-phase-4-2026-05-21' -Recurse -Force` — PowerShell handles the `\\?\` long-path prefix natively. If both fail, leave the stale directory in place (it's already git-ignored under `.worktrees/`); the only cost is disk space, not correctness.

Worktree creation itself is handled by Task 0 of the implementation plan.

---

## Phase 5 → Phase 6+ transition

After this PR merges, the baseline should be ~94 entries:

- ~51 cli entries
- ~5 client entries
- ~4 sdk entries
- ~30 mcp-connectors entries
- (Voice and any other Phase 4 partial-raise watermarks remain)
- **0 gateway entries** — Phase 5 closes the Gateway.

Phase 6 then attacks the CLI commands package en masse with a shared `MockClient`-driven harness. Phase 7 attacks the MCP connectors via a shared contract-test harness. Phase 8 mops up client + SDK. Each is one design discussion + one bundled PR.
