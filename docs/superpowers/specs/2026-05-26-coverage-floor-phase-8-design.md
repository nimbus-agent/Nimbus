# Coverage Floor Phase 8 — CLI Deep Cuts + Program Closeout

**Date:** 2026-05-26
**Spec parent:** [`2026-05-17-coverage-floor-design.md`](./2026-05-17-coverage-floor-design.md) §"Phasing"
**Direct predecessor:** [`2026-05-25-coverage-floor-phase-7-design.md`](./2026-05-25-coverage-floor-phase-7-design.md)
**Branch:** `dev/asafgolombek/coverage-floor-phase-8-2026-05-26`
**Branched from:** `main` at `497b46c4` (Phase 7 merge, PR #427)

---

## Goal

Take the per-file coverage-floor baseline from **10 → 0 entries** — the finale of the coverage-floor program. After Phase 8 the baseline (`docs/structure-audit/coverage-baseline.json`) has an **empty `files: {}`** object: every in-scope source file is either above the 80% floor or structurally excluded with a documented reason.

The 10 entries on `main` are exactly the CLI deep cuts Phase 7 deferred:

| File | Baseline | Phase 8 disposition |
|---|---|---|
| `packages/cli/src/commands/connector.ts` | 40.5% | **Test to ≥80%** — `auth <service>` machinery via fake-IPC + env |
| `packages/cli/src/commands/doctor.ts` | 46.22% | **Test to ≥80%** — `doctorRunGatewayRpcs` + `runDoctor` fixture permutations |
| `packages/cli/src/commands/extension.ts` | 72.13% | **Test to ≥80%** — `keygen`/`sign` handlers (0% today) via temp dirs |
| `packages/cli/src/commands/repl.ts` | 74.36% | **Test to ≥80%** — mock `node:readline/promises` |
| `packages/cli/src/commands/serve.ts` | 68.63% | **Test to ≥80%** — local-mock `spawn-gateway.ts` |
| `packages/cli/src/commands/test.ts` | 76.47% | **Test to ≥80%** — mock `node:child_process` |
| `packages/cli/src/commands/update.ts` | 34.18% | **Test to ≥80%** — `runUpdate` dispatcher via fixture |
| `packages/cli/src/commands/start.ts` | 30.61% | **Exclude** — real detached-subprocess spawn + socket poll + onboarding loop |
| `packages/cli/src/commands/tui.tsx` | 45.59% | **Exclude** — Ink render loop needs a real TTY |
| `packages/cli/src/lib/gateway-process.ts` | 15.22% | **Exclude** — intentional mock-target duplicate of `gw-state-helpers.ts` |

**Expected outcome:** baseline 10 → 0 (7 raised to ≥80% and dropped; 3 structurally excluded and dropped). Three new structural exclusions are added to `exclusions.ts` + `sonar-project.properties`.

---

## Approach

Unlike Phase 7 (heterogeneous across four packages), Phase 8's 10 files all live in `packages/cli` and all share the **Phase 6 CLI test harness** (`packages/cli/test/helpers/cli-mocks.ts`): a process-global `mock.module` of `@clack/prompts`, `lib/gateway-process.ts`, and `ipc-client/index.ts`, driven by `setFixture({ gatewayState, processAlive, ipcClient })` + `createMockIpcClient([...responses])` + `captureOutput()`. No new shared harness is invented; the per-file work is either (a) more cases on that harness, (b) a small local `mock.module` of a leaf dependency, or (c) temp-dir fs isolation for the local-only handlers.

The phase is a single PR of small commits ordered low-risk → high-risk, with the lcov-dependent baseline drop confined to the **final commit** (the Phase 5/6/7 CI-Linux-authoritative discipline). All seven test-only files require **zero source changes** — every uncovered region is reachable through a seam that already exists. The three exclusions require **no new tests** (their pure logic is already covered by existing tests; only the entry/seam shim is uncovered).

### Why three exclusions, not zero

The coverage-floor guide (`docs/contributors/coverage.md` §"Requesting an exclusion") sanctions exclusion for files "structurally untestable in a single CI run (top-level side effects, OS-specific bindings, code-generation outputs)." All three Phase 8 exclusions meet that bar, and in each case the *logic* is already tested elsewhere — exclusion removes dead lcov weight, it does not hide untested behavior.

1. **`lib/gateway-process.ts` — strongest case in the codebase.** It is an *intentional* byte-for-byte duplicate of `lib/gw-state-helpers.ts`. Both files' headers (`gateway-process.ts:1-16`, `gw-state-helpers.ts:1-16`) document why: the CLI harness does `mock.module("../../src/lib/gateway-process.ts", ...)`, and Bun's process-global mock propagates through ESM re-export live bindings on Linux/macOS — so a re-export would shadow the colocated unit test. The duplication cuts that propagation. `gateway-process.test.ts` imports from the **twin** (`gw-state-helpers.ts`) and branch-covers every function (invalid shape, missing socketPath, non-finite pid, array/null roots, malformed JSON, real-PID roundtrip). The production copy executes only when a command test does *not* mock it, which is rare → 15.22%. This is a mock seam, not undertested logic; the path is uncoverable **by design**.

2. **`commands/start.ts` — real lifecycle integration.** The pure decision layer (`decideStartAction`, `wantsNoWizard`) is already extracted and fully tested in `start.test.ts`. The uncovered bulk (`start.ts:194-254`) is `spawnGateway(paths)` launching a **real detached subprocess**, `waitForGatewayReady` polling a **real socket** with real timers, `maybePrintFirstRunHints` opening a real `IPCClient` in a 30-iteration loop, and `GatewayLogTailer` tailing a real log file. None of `spawn-gateway.ts` / `gateway-log-tail.ts` is in the harness mock set; deterministically faking a detached spawn + socket bind on CI is exactly what the exclusion mechanism exists for (same class as the already-excluded `gateway/src/index.ts` top-level `await main()`). `spawn-gateway.ts` itself is separately covered by `lib/spawn-gateway.test.ts`.

3. **`commands/tui.tsx` — Ink render shim.** The three dispatch branches (`--help`/`-h`, gateway-missing, fallback-to-REPL) are covered by `tui.test.tsx`. The uncovered bulk (`tui.tsx:41-87`) is the Ink render block: `inkRender(<App .../>)` + `ink.waitUntilExit()` + the SIGINT/SIGTERM/exit signal handlers, which need a real TTY + raw-mode stdin (the test file documents this at lines 8-11). `.tsx` matches no existing exclusion regex, so it needs an **exact** entry. The Ink surface is exercised by the e2e desktop/TUI suite, not the in-process unit layer.

The user (design lead) explicitly chose **exclude-as-is** for `start.ts` and `tui.tsx` over a harness refactor that fakes `spawnGateway`/`waitForGatewayReady`/`inkRender` — those are inherently integration-level paths and the marginal lifecycle-helper extraction is not worth the churn.

### Reuse, don't invent

Every seam below is already demonstrated in the CLI package:

- The `cli-mocks.ts` fixture harness — used by `status.test.ts`, `connector.test.ts`, `extension.test.ts`, and ~40 other command tests.
- Per-file local `mock.module` of a leaf dependency — `tui.test.tsx` already locally mocks `./repl.ts`; the same pattern applies to `node:readline/promises` (repl), `../lib/spawn-gateway.ts` (serve), and `node:child_process` (test).
- `mkdtemp` fs isolation for handlers that touch only `node:fs` — `extension`'s `keygen`/`sign` need no IPC mock at all.

---

## Scope

### Tier E — Structural exclusions (3 files, 0 new tests)

Add three `{ kind: "exact", path }` entries to `EXCLUSIONS` in `scripts/coverage-floor/exclusions.ts`, mirror them into `sonar-project.properties` line 65 (`sonar.coverage.exclusions`), and remove the three entries from the baseline. Verified by `bun run audit:exclusion-parity` (exit 0). Existing tests for these files' pure helpers stay unchanged.

| File | Baseline | Justification (goes in the `exclusions.ts` comment) |
|---|---|---|
| `packages/cli/src/lib/gateway-process.ts` | 15.22% | Intentional mock-target duplicate of `gw-state-helpers.ts`. The shared CLI harness `mock.module`s this exact path, shadowing its body in nearly every command test; the identical logic is fully branch-covered by `gateway-process.test.ts` against the un-mocked twin. The two files must stay separate module records (ESM re-export live-binding propagation defeats the mock isolation on Linux/macOS). |
| `packages/cli/src/commands/start.ts` | 30.61% | The dominant uncovered region (`start.ts:194-254`) is a real detached-subprocess spawn (`spawnGateway`) + real-socket readiness poll (`waitForGatewayReady`) + 30-iteration onboarding `IPCClient` loop — structurally unrunnable in a single Ubuntu CI run. The pure decision layer (`decideStartAction`, `wantsNoWizard`) is extracted and tested in `start.test.ts`. Same rationale as the `gateway/src/index.ts` top-level `await main()` exclusion. |
| `packages/cli/src/commands/tui.tsx` | 45.59% | CLI Ink TUI entry shim — `inkRender(...)` + `ink.waitUntilExit()` require a real TTY + raw-mode stdin, unrunnable under `bun test` on headless Ubuntu CI. The dispatch branches (`--help`, gateway-missing, fallback-to-REPL) are covered by `tui.test.tsx`; the Ink surface is covered by the e2e suite. `.tsx` matches no existing regex, so an exact entry is required. |

### Tier N — Near-floor nudges (4 files, small additions)

These sit at 68–76%; a handful of cases on the existing harness closes each gap.

| File | Baseline | Seam / cases |
|---|---|---|
| `commands/extension.ts` | 72.13% | New sibling test `extension-keygen-sign.test.ts`. The `keygen` (`extension.ts:397-431`) and `sign` (`433-471`) handlers are 0%-covered (~75 dead lines) and touch only `node:fs` + SDK crypto. Temp `mkdtemp` dir; capture `process.stdout.write`/`process.stderr.write` directly (these use `process.*.write`, not `console.*`). Cases: keygen default + `--out`, EEXIST without `--force` → exit 2, `--force` overwrite; sign missing/`--`-prefixed extDir → 2, unreadable key → 2, short key (≠32 bytes) → 2, unreadable manifest → 2, happy path → 0 with a `signature` field written. |
| `commands/repl.ts` | 74.36% | `mock.module("node:readline/promises")` so `rl.question` returns `"exit"` immediately, covering `runRepl` connect + loop-entry + break + `finally` cleanup (`repl.ts:92-114`). A second case returning a query then `"quit"` covers the `runReplTurn` call. Harness `IPCClient` mock + fixture make `loadReplPreconditions` succeed. |
| `commands/serve.ts` | 68.63% | Local `mock.module("../lib/spawn-gateway.ts")`. Two `runServe` cases (`serve.ts:62-77`): gateway-not-running + spawn resolves → assert HTTP/socket/log output; spawn rejects → assert `process.exitCode === 1`. `@clack` spinner is already a harness no-op. |
| `commands/test.ts` | 76.47% | `mock.module("node:child_process")` returning a fake child (`EventEmitter`). Valid manifest + a `package.json` with `scripts.test`, then emit `close` 0 (resolve → "contract OK"), `close` 1 (reject → "exited with code 1"), and `error` (reject) to cover `test.ts:80-96`. |

### Tier D — Dispatcher / fixture tests (2 files)

| File | Baseline | Seam / cases |
|---|---|---|
| `commands/doctor.ts` | 46.22% | (1) export-call `bunVersionOk` + `doctorPrintBunCheck`; (2) `doctorRunGatewayRpcs(createMockIpcClient([ping, validate, snapshot]).client)` asserting printed lines + exit code (the single biggest uncovered block, `doctor.ts:156-174`); (3) `runDoctor([])` through the four `setFixture` permutations — no-state, stale-pid, live+IPC-ok, live+IPC-throws (`176-221`). No source change. The Linux `secret-tool` branch in `doctorPrintVaultCheck` (`81/84`) is the only residual (~1-2 lines). |
| `commands/update.ts` | 34.18% | `runUpdate(argv)` dispatcher via `setFixture({ gatewayState, ipcClient })` (same pattern as `status.test.ts`): (1) `["--check"]` → check output + exit code; (2) `["--yes"]` → `updater.applyUpdate` called + success line; (3) `[]` with `updateAvailable:false` → "No update available."; (4) `[]` with `updateAvailable:true` → "Aborted." (under `bun test` stdin is non-TTY, so `readLine` returns `""` and the abort path runs). The TTY-affirmative branch in `readLine` (`update.ts:105-112`, ~3 lines) is the only residual. |

### Tier B — The big one (1 file)

| File | Baseline | Seam / cases |
|---|---|---|
| `commands/connector.ts` | 40.5% | The dominant uncovered region is the entire `auth` credential-resolution machinery (`connector.ts:258-928`, >half the file): 19 `apply*ConnectorAuth` functions + the `CONNECTOR_AUTH_PARAM_APPLIERS` table + `runConnectorAuth`'s IPC call + post-success output. All reachable through `runConnector(["auth", <service>, ...flags])` with the existing fixture — no refactor, no exclusion. Cases per applier: one **success** (minimal valid flags, queue one `connector.auth` response, assert the params object + the vault-PAT vs OAuth-scopes output branch) and one **primary error** (missing required flag/env — throws *before* `withIpc`, so no fixture needed). Plus the four OAuth `--help` arms (`260-275`), `--port`/`--scopes` happy + invalid, and one env-fallback case to cover `firstEnvTrimmed` (`289-297`). |

---

## Commit Structure

Single PR, 6 commits ordered low-risk → high-risk:

| # | Commit subject | Files | Baseline effect |
|---|---|---|---|
| 1 | `chore(coverage-floor): exclude CLI entry/seam shims` | `exclusions.ts` (+3), `sonar-project.properties` (+3), `coverage-baseline.json` (−3) | −3 (start, tui, gateway-process) |
| 2 | `test(cli): cover doctor + update dispatchers` | `doctor.test.ts` (extend), `update.test.ts` (extend) | none (drop in commit 6) |
| 3 | `test(cli): cover repl + serve + test command tails` | `repl.test.ts`, `serve.test.ts`, `test.test.ts` (extend) | none (drop in commit 6) |
| 4 | `test(cli): cover extension keygen + sign` | `extension-keygen-sign.test.ts` (new) | none (drop in commit 6) |
| 5 | `test(cli): cover connector auth machinery` | `connector.test.ts` (extend) | none (drop in commit 6) |
| 6 | `chore(coverage-floor): empty baseline + Phase 8 closeout` | `coverage-baseline.json` (−7 → `{}`), `CLAUDE.md`, `GEMINI.md`, this spec + plan + review docs | −7 (the raised entries) |

**Totals:** ~50–60 new test cases across 6 test files (1 new + 5 extend), **zero source changes**, 3 new exclusions, 10 baseline entries removed → empty baseline.

**Ordering rationale:**

- Commit 1 first: pure config + lcov-independent exclusion prune, zero reversibility risk (Phase 5/6/7 precedent for the structural-exclusion commit going first).
- Commits 2–4: the cheap, deterministic wins (dispatcher fixtures, leaf-dep mocks, temp-dir fs) before the large `connector` auth pass.
- Commit 5 (`connector`) is the largest test addition — landed last among the test commits so a failure there does not block the others.
- Commit 6 drops the 7 raised entries and empties the baseline. **`update-baseline` is never run** — the baseline edits are hand-made, gated on CI-Linux measurement.

---

## Test Infrastructure

No new shared harness. The CLI package's existing patterns:

### `cli-mocks.ts` fixture harness (used by Tiers D + B and parts of N)

`setFixture({ gatewayState, processAlive, ipcClient })` controls the mocked `readGatewayState`/`isProcessAlive`/`IPCClient`. `createMockIpcClient([...responses])` builds a response-queue stub whose `.call()` shifts the next seeded response. `captureOutput()` intercepts `console.*` (note: NOT `process.stdout.write` — the `extension` keygen/sign handlers use `process.*.write` and need direct capture).

### Per-file leaf-dependency `mock.module` (Tier N)

Follow the `tui.test.tsx` → `./repl.ts` precedent. `mock.module` is process-global and only affects FUTURE imports; restore the real module in `afterAll`. The three leaf mocks are independent module paths (`node:readline/promises`, `../lib/spawn-gateway.ts`, `node:child_process`) so they do not collide with each other across the single per-package `bun test --coverage` process. Where a handler under test calls `process.exit(code)`, stub it (existing pattern in `extension.test.ts`).

### Temp-dir fs isolation (Tier N — extension)

`mkdtempSync(join(tmpdir(), "nimbus-ext-"))` per test; the keygen/sign handlers take `args` and return an exit code, with all I/O against the temp dir. Generate the test key via the file's own `runExtensionKeygen` (or SDK `generateEd25519Keypair`) so the sign happy-path uses a real 32-byte key.

---

## Carry-forwards

### Phase 4 (still apply)

- **CI Linux is authoritative.** Never lower a baseline watermark to match local Windows lcov — only match CI Linux.
- TS strictness: `noUncheckedIndexedAccess` (`arr[i]?.x`), `noPropertyAccessFromIndexSignature` (`obj["key"]`), `exactOptionalPropertyTypes: true` (omit the prop, don't pass `undefined`).
- `bun:test`'s `test.each(table)` requires a **mutable** array — never `readonly T[]`.
- `node:path.join` is platform-dependent — use `join(...)` against the same operands the source uses; never hardcode separators.
- Run `bun run lint:fix` before every commit.

### Phase 5/6/7 execution (Phase 8 guardrails)

1. **`mock.module(...)` is process-global AND only affects FUTURE imports.** `build-lcov` runs `bun test --coverage` once per package, so a `mock.module` leaks to every later file in that package's process; `afterAll` restore does not undo it for files already loaded. **Phase 8 application:** every leaf mock (`node:readline/promises`, `spawn-gateway.ts`, `node:child_process`) restores in `afterAll`; they mock distinct leaf paths, not a shared module other tests depend on. The harness mocks (`gateway-process.ts` etc.) are owned by `cli-mocks.ts` and are not re-registered per test.
2. **Never run `bun run audit:coverage-floor:update-baseline`.** Baseline edits are hand-made: the exclusion removals in commit 1 (lcov-independent) and the 7 raised drops in commit 6 only. Phase 5 Task 9 was reverted for running `update-baseline` against local Windows lcov (fixup `06628373`).
3. **The 7 raised drops land in commit 6 only, against CI-Linux measurement.** You develop on Windows; push the PR, let CI run, download the `coverage-lcov-merged` artifact (`gh run download <id> --name coverage-lcov-merged --dir coverage`), confirm each of the 7 is ≥80% on CI Linux, then hand-edit the baseline. Do not drop a file the CI-Linux run shows <80%.
4. **Don't commit auto-modified files** (e.g. `.claude/settings.local.json`). Stage explicit paths; never `git add -A` / `git add .`.
5. **The per-file case lists above are grounded in the current source but may drift.** Read the source FIRST, run coverage, target the ACTUAL uncovered lines, and document any divergence in the implementer report.
6. **Branch-update strategy.** `main` moves fast. Merge `main` as needed; `CLAUDE.md`/`GEMINI.md` status rows conflict — keep both the Phase 8 row and any new rows from main.

---

## Acceptance

1. `bun run audit:coverage-floor:build-lcov && bun run audit:coverage-floor` exits 0 locally and reports **0 baselined files** (CI Linux authoritative for the merge gate).
2. `bun run audit:exclusion-parity` exits 0 — `sonar-project.properties` and `exclusions.ts` agree on the 3 new entries.
3. `bun run audit:invariants` exits 0 — D10 / D12 / vault-key allow-list unchanged.
4. `bun run lint` + `bun run typecheck` exit 0.
5. `docs/structure-audit/coverage-baseline.json` has an empty `files: {}` object — the program is complete.
6. The 7 raised files (`connector`, `doctor`, `extension`, `repl`, `serve`, `test`, `update`) are each ≥80% on CI Linux; the 3 excluded files (`start`, `tui.tsx`, `gateway-process`) are matched by `isExempt`.
7. No file currently ≥80% drops below 80% — enforced by the floor gate.
8. Zero source changes to the seven test-only files (verified by `git diff --stat` showing only `*.test.ts(x)` + the commit-1/6 config files).
9. If a Tier-N/D/B file genuinely cannot reach 80% on CI Linux after the planned cases, it is **held at a raised watermark** (not dropped, not newly excluded) and the implementer report states the residual uncovered branches. (This is the only path that leaves the baseline non-empty; the goal is empty.)

---

## Risks

| Risk | Mitigation |
|---|---|
| `connector.ts` doesn't clear 80% after the per-applier pass | The `auth` machinery is >half the file and near-zero covered today; one success + one error per applier plus the help/flag edges has large margin. If short, add the remaining env-fallback branches (each `apply*` has one) — all reachable through the same fixture, no refactor. |
| A leaf `mock.module` leaks into a sibling CLI test in the same coverage process | Each mocks a distinct leaf path and restores in `afterAll`; none mocks a module that other command tests import for their own logic. The harness-owned mocks are untouched. (Carry-forward 1.) |
| Local Windows lcov diverges from CI for the 7 raised entries | Carry-forward 3: drop the 7 only in commit 6, against the CI-Linux `coverage-lcov-merged` artifact; never `update-baseline`. `doctor.ts`'s `secret-tool` branch and `update.ts`'s `readLine` TTY branch flip per-OS but are ≤3 lines each — confirm the CI-Linux number, not the local one. |
| Excluding 3 CLI files is seen as hiding untested logic | Each exclusion's logic is already covered elsewhere (`gw-state-helpers.ts` twin tests; `decideStartAction`/`wantsNoWizard` in `start.test.ts`; the three dispatch branches in `tui.test.tsx`). The exclusion comments cite the covering test. This matches the existing entry-shim precedent (`gateway/src/index.ts`, `cli/src/index.ts`, worker entries). |
| `extension` keygen/sign coverage measured against `console.*` capture misses the lines | These handlers write to `process.stdout.write`/`process.stderr.write`, not `console.*` — capture those directly (the `extension.test.ts:705` pattern), or coverage won't move even with passing assertions. |
| `extension-keygen-sign.test.ts` leaves temp dirs on disk | `rmSync(tmp, { recursive: true, force: true })` in `afterEach`; `mkdtempSync` per test (the `nimbus-testing` isolation rule). |

---

## Program Closeout

Phase 8 is the last phase. After this PR merges:

- The per-file coverage floor is **fully ratcheted**: `coverage-baseline.json` is empty, so the gate now enforces a hard 80% floor on every new non-exempt source file with no grandfathered exceptions.
- The exclusion registry (`exclusions.ts`) is the single documented list of structurally-untestable files, each with a comment and (where applicable) a covering test or twin.
- The deferred architectural cleanups noted in Phase 7 (refactor `cli/src/index.ts` + `gateway/src/index.ts` to expose a testable `main()`; dependency-invert the CLI dispatchers' IPC client construction) remain optional future work — they would let `start.ts`/`tui.tsx` be un-excluded, but are not required for the floor program and carry integration-test cost that exceeds their value.

The `CLAUDE.md` + `GEMINI.md` coverage-floor status line records: `Phase 8 ✅ — CLI deep cuts + closeout (baseline 10 → 0; floor fully ratcheted)`.

---

## Review & Suggestions

Self-review pass. Each point shows the observation and the **Disposition** applied.

**1. Could `start.ts` reach 80% by reusing the `serve.ts` `spawn-gateway` mock?**
- **Observation:** `serve.ts` reaches 80% by locally mocking `spawn-gateway.ts`; `start.ts` also calls `spawnGateway`.
- **Disposition:** No. `serve.ts`'s tail is just the spawn + a print/catch. `start.ts`'s tail additionally runs `waitForGatewayReady` (real socket poll, real timers), `maybePrintFirstRunHints` (30-iteration real `IPCClient` loop), and `GatewayLogTailer` — none mocked by the harness. Faking all three deterministically is a non-trivial harness refactor for an integration path; the user chose exclude-as-is.

**2. Is excluding `gateway-process.ts` legitimate, or a coverage dodge?**
- **Observation:** 15.22% is the lowest number in the codebase.
- **Disposition:** Legitimate and the strongest case. The number is low *because* the harness mocks the file's exact path in nearly every command test — the body is shadowed, not untested. Its identical twin `gw-state-helpers.ts` is branch-covered by `gateway-process.test.ts`. Both file headers document the duplication as load-bearing for mock isolation. Exclusion removes dead lcov weight.

**3. Zero source changes — is that realistic for `connector.ts` at 40.5%?**
- **Observation:** Closing a ~40-point gap usually implies a refactor.
- **Disposition:** Realistic here. The `auth` logic (>half the file) is already factored into pure, side-effect-free `apply*` helpers reachable through `runConnector(["auth", ...])`; they are simply not exported, and they don't need to be — the existing fixture drives them end-to-end. The exploration agent confirmed 0% of the gap needs a refactor and 0% needs exclusion.

**4. Single PR vs split.**
- **Observation:** Phase 7 packages and Phase 8 CLI deep cuts were split into two PRs per the original "packages first" decision.
- **Disposition:** Phase 8 is one PR of 6 commits — homogeneous CLI files on one shared harness, smaller than Phase 7. No further split needed.

**5. The empty-baseline end state.**
- **Observation:** An empty `files: {}` is the program's terminal state.
- **Disposition:** Intended. Acceptance 5 asserts it; Acceptance 9 is the only escape hatch (a raised watermark if CI Linux disagrees on one file), and the implementer must document why if it triggers. The goal is empty.
