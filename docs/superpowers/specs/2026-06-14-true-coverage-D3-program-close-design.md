# True Coverage — Sub-project D3: Program close (Design)

**Date:** 2026-06-14
**Branch:** `dev/asafgolombek/true-coverage-D3` (worktree `.claude/worktrees/tc-D3`, off `origin/main` 209fc966)
**Status:** Design — awaiting review
**Owner:** AsafGolombek
**Umbrella spec:** [`2026-06-13-true-coverage-D-shrink-exclusions-design.md`](./2026-06-13-true-coverage-D-shrink-exclusions-design.md) §3 (categorization), §4 (D3 slice), §6 (worker handling / §5.3 probe)

## 1. Goal

D3 is the **final** slice of the True Coverage program. On merge, the program
(A · B · ★ Flagship · C · D1 · D2 · **D3**) is **COMPLETE** — every non-flagship source file
either clears the ≥80% line+branch floor or carries a category-justified exclusion, and the
deferred §5.3 Worker-instrumentation probe is resolved.

D3 is low-risk close-out: relocation, documentation, and one real refactor (`EmbeddingWorkerCore`).
It is shipped as a **single finale PR** (decided 2026-06-14).

## 2. Grounding facts (verified 2026-06-14 against `origin/main` 209fc966)

- **All 4 test-helpers are live** — relocate, none dead:
  - `cli/src/tui/test-helpers/context.ts` → 2 importers (`tui/App.test.tsx`, `tui/ipc-context.test.tsx`, both `import … from "./test-helpers/context.ts"`).
  - `cli/src/commands/cli-test-helpers.ts` → **2 importers** (`commands/scim.test.ts`, `commands/identity.test.ts`). **This resolves the umbrella spec's open "~0 importers — possibly dead config?" question: NOT dead → relocate.**
  - `gateway/src/identity/identity-test-helpers.ts` → 5 importers (teams-bot-jwt, identity-runtime, verifier, identity-boot, identity-vault — all `.test.ts`).
  - `gateway/src/updater/updater-test-fixtures.ts` → 3 importers (updater, ipc/updater-rpc, test/integration/updater/air-gap — all `.test.ts`).
- **`chatops/chatops-tool-runner-e2e-sink.ts` is production-imported** by `platform/assemble.ts:16` (`} from "../chatops/chatops-tool-runner-e2e-sink.ts";`) — the current exclusions.ts comment ("TEST-ONLY … never exercised in a normal gateway boot") is **false**.
- **`db/query-guard-worker.ts` (26L) is genuinely thin** — the security check is in the `platform/worker-security.ts` sibling; `onmessage` opens a readonly DB, runs the SQL, posts back. Nothing meaningful to extract.
- **`embedding/embedding-worker.ts` (132L) carries real inline orchestration** — `setupDb` (migrations + sqlite-vec load + pragmas), the init IIFE (embedder + `SqliteEmbeddingPipeline` + backfill), the `embed_texts`/`embed_item` handlers, and a serialized `embedChain` promise queue. This is the §6 extraction target.
- **Type-only / zero-SF entries number 11** (umbrella §3(b)'s 10 + `ipc/server/options.ts`, reclassified type-only in D2): `index/ranked-item.ts`, `embedding/embedding-runtime.ts`, `vault/nimbus-vault.ts`, `ipc/agent-invoke.ts`, `ipc/workflow-invoke.ts`, `connectors/mapped-row.ts`, `ipc/connector-rpc-handlers/context.ts`, `connectors/lazy-mesh/slot.ts`, `client/src/stream-events.ts`, `chatops/transport/transport.ts`, `ipc/server/options.ts`.

## 3. Work units

### A. Test-helper relocations (`git mv` → `testing/` dir, self-enforcing)

`discoverSourceFiles` (check.ts:160) auto-skips any `/testing/` path. Relocating a pure test-helper
under a `testing/` dir makes its exemption self-enforcing — the file no longer needs an explicit
exclusion entry.

| From | To | Importer updates |
|---|---|---|
| `cli/src/tui/test-helpers/context.ts` | `cli/src/tui/testing/context.ts` | 2 (`./test-helpers/context.ts` → `./testing/context.ts`) |
| `cli/src/commands/cli-test-helpers.ts` | `cli/src/commands/testing/cli-test-helpers.ts` | 2 (`./cli-test-helpers.ts` → `./testing/cli-test-helpers.ts`) |
| `gateway/src/identity/identity-test-helpers.ts` | `gateway/src/identity/testing/identity-test-helpers.ts` | 5 |
| `gateway/src/updater/updater-test-fixtures.ts` | `gateway/src/updater/testing/updater-test-fixtures.ts` | 3 |

Each relocation: `git mv` (preserve history + clean diff), update every importer in the same commit,
delete the corresponding exact exclusion entry (4 entries removed). `tsc` + a scoped test run per
package confirms importers resolve.

### B. Delete the redundant `sandbox-probe.ts` entry

`sdk/src/testing/sandbox-probe.ts` is **already** under a `testing/` dir → already auto-skipped by
check.ts:160 → its exact exclusion entry (line 32) is dead config. Delete the entry; no file move.

### C. Correct the `chatops-tool-runner-e2e-sink.ts` comment

It is statically imported by production boot (`assemble.ts:16`, runs when `NIMBUS_CHATOPS_E2E_SINK_DIR`
is set). **Keep it excluded** (relocating it would point a production import into the coverage-skipped
tree) but rewrite the comment from the false "TEST-ONLY … never exercised in a normal gateway boot"
to: env-gated (`NIMBUS_CHATOPS_E2E_SINK_DIR`), inert in a normal boot — the file-backed mock ChatOps
transport that stands in for the bot-credentialed connector subprocess in the e2e. Move the entry
into the genuinely-untestable (d) block.

**Production-bundle safety (verified 2026-06-14, review point 1):** because the file is statically
imported by a production orchestrator, it must not pull test-only/dev npm packages into the production
bundle. Verified clean — it imports only `node:fs` (`appendFileSync`/`readFileSync`), `node:path`, and
two `import type` internal types (`ConnectorDispatcher`/`PlannedAction`, `RunChatopsTool` — erased at
compile). No mock framework, no `devDependencies` runtime import. The static import is safe; no
dynamic-import / `try`-catch guard in `assemble.ts` is warranted (and an `assemble.ts` boot-wiring
change is out of D3 scope — D3 corrects the comment only).

### D. Group the 11 type-only / zero-SF entries

Consolidate all 11 (§2) into a single clearly-labeled block:

```text
// Type-only / zero-executable-line modules. These emit NO `SF:` lcov record (no executable
// statements), so the gate reads them as 0% and they can NEVER rejoin the floor — same class as
// the `types.ts` / `-types.ts` basenameRegex. There is nothing to test. No rename (avoids import
// churn across every consumer for marginal gain).
```

No rename. The existing `types.ts`/`-types.ts` basenameRegex stays separate (it is a regex, not an
exact-path list). The `chatops/transport/transport.ts` and `ipc/server/options.ts` entries (currently
commented individually) fold into this block.

**Per-file guardian header (review point 5.1, adopted):** add a 2-line header comment to each of the
11 type-only files — e.g. `// Type-only module: NO executable runtime logic (it is exact-path-excluded`
`// from the coverage floor in scripts/coverage-floor/exclusions.ts — added logic would silently`
`// bypass the gate). Put runtime logic in a separate covered module.` The warning lands at the point
of edit (the file itself), which is more effective at prevention than the central exclusions.ts block
comment alone; it is pure prose (zero `SF:` impact, so the files stay zero-SF). **Pre-grouping check:**
before grouping, confirm each of the 11 genuinely emits no `SF:` lcov record (don't trust the label) —
any that has executable lines is mis-categorized and must be handled as an I/O shell instead.

**Deferred (review point 5.2 — own scope, NOT in D3):** a static `check.ts` enhancement that parses
each "type-only"-categorized exclusion and fails if it contains executable AST nodes would be a
stronger, self-enforcing guarantee than the header comment. It is a genuinely good idea but a **new
gate mechanism** that needs its own tests + coverage; adding it to the program-*close* PR risks
gold-plating the finale. Recorded as a documented follow-up (memory), not D3 work.

### E. Worker handling — extract `EmbeddingWorkerCore` + run the §5.3 probe

**`query-guard-worker.ts`:** stays a documented thin onmessage shell. Add/keep a clear category
comment (genuinely-thin worker realm; security check lives in `worker-security.ts`).

**`embedding-worker.ts` — extract `EmbeddingWorkerCore`:**

- New file `packages/gateway/src/embedding/embedding-worker-core.ts` exporting an injectable
  `EmbeddingWorkerCore` that owns the worker's stateful orchestration. Constructor/factory takes
  injected seams: `sendToMain(data: unknown) => void`, a db opener/factory (so tests use real
  in-memory `bun:sqlite`, no file path), and an embedder/pipeline factory (so tests inject a fake
  pipeline — no model download). It exposes the message-handling logic: `init`, `embed_texts`,
  `embed_item`, and the serialized `embedChain` queue.
- The residual `embedding-worker.ts` becomes a thin wiring shell: the `onmessage` handler validates
  origin (`isAcceptableWorkerOrigin`), constructs the real `EmbeddingWorkerCore` with the real
  `sendToMain`/`Database`/`createLocalEmbedder`+`SqliteEmbeddingPipeline`, and routes messages to it.
- New `embedding-worker-core.test.ts` drives the core ≥80% line+branch. Per Antigravity review 2.3,
  it MUST cover: (a) **malformed / unknown message payloads** (no throw, ignored), (b) a **failed task
  inside the `embedChain` queue** — asserting **no unhandled rejection** and **the queue keeps draining**
  (a later task still runs; the chain is not wedged), and (c) the init-error path (`init_error` posted),
  the not-ready guard, and the `embed_texts` ok/error + `embed_item` row-found / row-missing branches.

- **`embedChain` liveness — characterize, don't change (review point 2):** the existing production
  pattern `embedChain = embedChain.then(task).catch(swallow)` **already** guarantees the queue cannot
  wedge — the tail `.catch` makes `embedChain` always *resolve*, so the next enqueue's `.then` always
  runs, and the empty catch body cannot itself throw. The extraction preserves this verbatim. Critically,
  `embed_item` failures are **intentionally silent best-effort** today (fire-and-forget; there is no
  result `id` to correlate a failure back to a caller, unlike `embed_texts` which posts
  `{ok:false,error}` keyed by `id`). The test therefore asserts *liveness* (no unhandled rejection;
  the next queued task still runs) **without** introducing new error-posting for `embed_item` — adding
  `sendToMain` on the embed_item failure path would be a behavior change, forbidden in a
  zero-behavior-change refactor. (This declines the review's `.then(nextTask, nextTask)` rewrite, which
  would alter the swallow semantics; the current `.then(task).catch()` is equivalent for queue liveness.)

- **Origin gating is the realm boundary, not the core's job (review point 3):** verified
  `isAcceptableWorkerOrigin(ev)` is a pure function over the `MessageEvent` + `globalThis.origin` (no
  `self.location` or other mutable worker-global state) → it stays fully functional in the residual
  shell. The `EmbeddingWorkerCore` methods accept **already-parsed** message payloads and are
  production-reachable **only** through the residual `onmessage` that runs `isAcceptableWorkerOrigin`
  first. Unit tests instantiate the core directly (origin gating is not the core's responsibility — the
  realm boundary is); the extraction must not relocate or weaken the origin check in the residual shell.

**Coverage discipline (D2 lesson):** the new core file is NEW source counted by **both** the local
whole-file floor (≥80%) **and** the Sonar `new_coverage` diff gate (≥80% of CHANGED lines). Because
the core is designed fully-testable (all I/O behind injected seams), both should land high. The
residual `embedding-worker.ts` onmessage wiring is the only irreducible part (real `Database` /
`createLocalEmbedder` construction + `postMessage` binding) — it stays excluded (documented thin
shell). If the residual's *diff lines* would drag Sonar `new_coverage` below 80%, the wiring must be
minimized so its changed-line count is small relative to the well-covered core (same shape as the D2
`runTeamWithIo` split).

**§5.3 realm-instrumentation probe (time-boxed, user-requested):** after extraction, run the deferred
probe on the residual onmessage — a worker-side preload that re-registers the istanbul instrumenter
and flushes `globalThis.__coverage__` back to the main realm (Bun Workers run in a separate realm the
`[test].preload` plugin cannot reach; this is parity with Bun's native `--coverage`, which also misses
workers). **Decision rule:** if the probe is cheap and produces a valid BRDA flush for the worker
file, instrument it and **drop** the `embedding-worker.ts` (and possibly `query-guard-worker.ts`)
exclusion; otherwise the documented thin-shell exclusion **stands as the accepted fallback** (the
extraction already captured the meaningful logic, so the probe is upside, not a blocker). The probe is
**not on the critical path** — it is strictly time-boxed and the documented exclusion guarantees
termination either way.

### F. Per-category documentation pass (genuinely-untestable bucket)

Ensure every remaining exclusion carries a category comment (umbrella §3(d)):

- **FFI (Vault):** `vault/{win32,darwin,linux,ffi-ptr}.ts`.
- **Platform-gated:** `platform/{win32,darwin,linux,browser}.ts`, `platform/sandbox/{linux,darwin,win32,orphan-reap,sandbox-runner}.ts`.
- **Boot orchestrators / index barrels / factories / process entry points:** `gateway/src/index.ts`, `cli/src/index.ts`, `platform/assemble.ts`, `platform/assemble-sync-registrations.ts`, `platform/index.ts`, `platform/sandbox/index.ts`, `platform/sandbox/sandbox-wrapper.ts`, `connectors/index.ts`, `vault/factory.ts`, `sdk/src/ipc/index.ts`, `client/src/index.ts`.
- **`mock.module`-shadowed (real logic tested via a documented twin):** `cli/src/lib/gateway-process.ts`.
- **Workers:** `db/query-guard-worker.ts` (thin), `embedding/embedding-worker.ts` (residual wiring after extraction) — unless the §5.3 probe drops them.
- **Generated SQL:** `index/*-v\d+-sql.ts` (pathRegex).
- **Connect-shell regexes:** `mcp-connectors/*/src/{server,tools}.ts`, `github-actions/*/src/main.ts`.
- **Benchmarks / native:** `perf/` (dirPrefix), `src-native/` (dirPrefix).
- **UI / React-Ink entry:** `cli/src/commands/tui.tsx`.
- **CLI IPC shells (post-D1/D2):** `commands/{start,policy,admin,chatops,repl,doctor}.ts` (cores covered; residual `runX` = `IPCClient` + `process.exit` shell).
- **Env-gated production-imported mock:** `chatops/chatops-tool-runner-e2e-sink.ts` (comment corrected, (C)).
- **Real-subprocess shell the seam doesn't reach:** `embedding/load-feature-extraction-pipeline.ts`.

### G. Verify the 2 debt files (no-op)

Confirm `gmail/history.ts` and `gmail-sync.ts` are absent from both `coverage-baseline.json` `files`
and `exclusions.ts` (already cleared by B6 #575). Verify-only.

### H. Program close-out

- Final `exclusions.ts`: every entry in exactly one categorized, commented block.
- CHANGELOG entry (`docs/CHANGELOG.md`): "True Coverage D3 — program close".
- Memory update: program status A · B · ★ · C · D (D1·D2·D3) all ✅ — **COMPLETE**.

## 4. Coverage mechanics & traps (carry forward from D1/D2)

D3 touches the instrumented file set (relocations remove files from the scanned set;
`EmbeddingWorkerCore` adds one) → **CI-Linux-authoritative for coverage-floor**. Flow:

1. Docker dry-run (`reseed-docker.sh`, oven/bun:latest) to confirm tests pass + `EmbeddingWorkerCore`
   crosses 80% line+branch on Linux istanbul.
2. Open the PR; let the merge-commit CI run.
3. Reseed the committed baseline from the **PR's OWN merge-commit lcov** (`gh run download <run-id>
   -n coverage-lcov-merged` → `coverage/lcov.info` → `audit:coverage-floor:update-baseline`). NOT from
   local Docker or main.
4. Confirm `files` stays **`{}`** — relocations add nothing (auto-skipped); `EmbeddingWorkerCore`
   lands ≥80 with headroom = no baseline entry. The flagship `targets` overlay (executor/envelope
   @100) round-trips verbatim — verify it survives the reseed.

**★ Sonar `new_coverage` is a SEPARATE diff-scoped gate (≥80% of CHANGED lines)** from the whole-file
floor (D2 lesson). The `EmbeddingWorkerCore` extraction is the one coverage-touching unit; its new
lines must be ≥80% covered in the diff, and the residual `embedding-worker.ts` wiring must be small
enough that its uncovered changed lines don't sink the diff %. Measure locally before push by
intersecting `git diff <merge-base> HEAD` new-side line numbers with the istanbul DA records (D2 recipe).

Watch the three drift classes on untouched files (B7/B9): environment drift (revert to main),
incidental-coverage (accept; CI reproduces), stale-main-watermark (keep the higher value; the merge
lcov agrees). Since `files` is `{}`, a clean D3 keeps it `{}`.

## 5. Invariants, testing, and code-quality bars

- **DI seams** = injected-dep / visibility-export, **zero behavior change** (B-series precedent).
  **No `mock.module`** (process-global; leaks in the combined cli run) — DI only.
- **No `any`** (use `unknown`), **no `biome-ignore`**, **no `istanbul-ignore`**.
- The `EmbeddingWorkerCore` extraction is a **pure refactor of an internal worker module** — it
  changes no production behavior, no public IPC, and no security invariant (the worker is spawned
  from the embedding runtime; the core's seams are construction-only). Both `security-invariants.test.ts`
  and `audit:invariants` stay green in the same PR.
- The `isAcceptableWorkerOrigin` origin check stays in the residual `onmessage` (it guards the realm
  boundary; the core operates post-validation) — the extraction must not relocate or weaken it.
- **Tests** follow the gateway exemplars: real in-memory `bun:sqlite` (no DB mocks), injected fakes
  for the embedder/pipeline (no model download), deterministic (no reliance on global `process.std*`
  / env defaults per the B10/B13 cross-file-leak lessons), fakes restored in `afterEach`.
- **Resource cleanup (review point 4):** the test owns the injected in-memory `bun:sqlite` handle and
  **closes it in `afterEach`** (`db.close()`) — the B13 graph-populator lesson (untracked in-memory DBs
  leak handles across the combined run). Verified the worker carries **no timers** (no
  `setTimeout`/`setInterval`; backfill and `embedChain` are promise-based) → no timer disposal is
  needed, and the timerless core needs **no `dispose()` method** — the test, which created the injected
  DB, closes it. (Declines the review's `dispose()`-method suggestion as YAGNI for a timerless core; if
  the core is later given a timer/owned resource, revisit.)

## 6. CI gates & doc traps (carry forward)

- Authoritative gate = **"PR quality — TS/Bun (ubuntu-24.04) / Unit + Coverage"** + the standalone
  **SonarCloud** check (`new_coverage`); the windows-2025 cross-platform red is the chronic flake (rerun).
- **markdownlint** is a CI gate on docs: run `bun run lint:markdown` from **inside the worktree** and
  **read the output** (never suppress it). No wrapped prose line may begin with a plus-then-space
  (MD004) — use comma prose. `markdownlint-cli2 --fix` can corrupt prose — re-verify after `--fix`.
- **No absolute `file:///C:/...` links in docs** — lychee fails them (recurring D-series trap, cf
  #530/#611). Use relative links.
- **biome** `bun run lint` false-fails in a `.claude/worktree` (`!**/.claude` exclude) → validate via
  `bunx biome check packages scripts`.
- Fresh worktree: `cd packages/client && bun run build` before `tsc` (else `@nimbus-dev/client`
  false-fails).
- Fix + resolve every CodeRabbit + Sonar thread (branch protection BLOCKS merge on any unresolved
  conversation). Run the full local CI-parity preflight before the first push (per the
  ship-readiness-before-first-push convention).

## 7. Success criteria (DoD — program close)

- Test-helpers relocated under `testing/` (self-enforcing); 4 exclusion entries dropped; all importers
  updated; `tsc` + scoped tests green.
- Redundant `sandbox-probe.ts` entry deleted; `chatops-tool-runner-e2e-sink.ts` comment corrected
  (kept excluded).
- 11 type-only entries grouped + documented; genuinely-untestable bucket fully category-commented.
- `EmbeddingWorkerCore` extracted, tested ≥80% line+branch **and** ≥80% Sonar `new_coverage`, confirmed
  NOT in baseline `files`; §5.3 probe resolved (instrumented-and-dropped OR documented fallback);
  `query-guard-worker.ts` documented thin.
- 2 debt files verified absent (no-op).
- PR merged green on the authoritative gate; CHANGELOG + memory updated; **PROGRAM COMPLETE
  (A · B · ★ · C · D all ✅)**.

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| `EmbeddingWorkerCore` extraction changes worker behavior | Pure internal refactor; characterize existing behavior with tests; origin check stays in residual onmessage; invariants + static audit green in same PR |
| New core file sinks Sonar `new_coverage` | Designed fully-testable (all I/O seamed); minimize residual wiring changed-line count; measure diff coverage locally (D2 recipe) before push |
| §5.3 worker-realm probe rabbit-holes | Strictly time-boxed; documented thin-shell exclusion is the guaranteed fallback; extraction already captured the meaningful logic |
| Test-helper relocation breaks importers / CI | Update all importers in the same commit; `tsc` + scoped test run before push; `/testing/` auto-skip verified at check.ts:160 |
| Reseed picks up drift on untouched files | Reseed from the PR's own merge lcov; disambiguate the three drift classes per §4 |
| markdownlint `+`-bullet / lychee absolute-link / suppressed-output regression | Run `lint:markdown` + `lychee` from in-worktree, read output, comma prose, relative links |

## 9. Review dispositions (external review, 2026-06-14)

Each point verified against the code before disposition (receiving-code-review discipline).

| # | Review point | Disposition | Reason |
|---|---|---|---|
| 1 | e2e-sink may pull dev-only deps into the production bundle | **Resolve (no change)** | Verified: imports only `node:fs`/`node:path` + 2 `import type` (erased). Zero dev/test npm runtime imports → risk absent. Static import safe; `assemble.ts` dynamic-import is out of D3 scope. Recorded in §3.C. |
| 2 | `embedChain` must stay unblocked on task failure | **Fix as clarification; decline rewrite** | Existing `.then(task).catch(swallow)` already guarantees liveness (chain always resolves; empty catch can't throw). The `.then(nextTask,nextTask)` rewrite would surface `embed_item` errors = behavior change (they're intentionally silent fire-and-forget, no `id`). §3.E now mandates characterizing existing behavior + testing liveness only. |
| 3 | Verify origin gating survives extraction / core doesn't trust unvalidated payloads | **Fix (make explicit)** | Verified `isAcceptableWorkerOrigin(ev)` is pure over the event + `globalThis.origin` (no `self.location` state) → fully functional in the residual shell. §3.E now states the core takes pre-parsed payloads, is reachable in prod only via the validated `onmessage`, and the origin check stays in the residual shell. |
| 4 | Close DBs / clear timers in test teardown | **Fix (DB close); decline `dispose()`** | §5 now requires `db.close()` in `afterEach` (B13 lesson). Verified the worker has no timers → no timer disposal; timerless core needs no `dispose()` (test owns + closes the injected DB) → declining that as YAGNI. |
| 5 | Guard type-only files from silently gaining executable logic | **Adopt 5.1; defer 5.2** | 5.1 (per-file guardian header, zero-SF, effective at point of edit) adopted in §3.D, plus a pre-grouping zero-SF verification. 5.2 (check.ts AST-node static check) is a strong but new self-enforcing gate needing its own tests/coverage — gold-plating the finale → documented follow-up. |
