# Coverage Floor Phase 4 — Long Tail (Gateway + Non-Gateway Near-Floor)

**Date:** 2026-05-20
**Spec parent:** [`2026-05-17-coverage-floor-design.md`](./2026-05-17-coverage-floor-design.md) §"Phasing — Phase 4"
**Branch:** `dev/asafgolombek/coverage-floor-phase-4-2026-05-21`
**Worktree:** `.worktrees/coverage-floor-phase-4-2026-05-21/`
**Branched from:** `main` at `6461015e` (Phase 3B-rest merge, PR #370)

---

## Goal

Raise the gateway long-tail baseline entries above the 80% per-file line-coverage
floor, plus honestly classify the 0% Tier D files as either "test it" or
"structurally exclude". Fold in 3 non-gateway near-floor nudges that are
one-test-each wins.

The PR is shaped one-bundled-PR per the precedent of PR #365 (Phase 2C),
PR #369 (Phase 3A), and PR #370 (Phase 3B-rest).

**Expected outcome:** ~40 baseline entries removed (33 raised to ≥80% + 7 moved
to structural exclusions). Baseline drops from 140 → ~100 entries. Voice files
(commit 13) may land partial improvement instead of full raise — in that case,
their entries remain at raised watermarks rather than being dropped.

---

## Scope

### Tier A — near-floor nudges (≥73%, 1–3 tests each)

| File | Baseline | Notes |
|---|---|---|
| `packages/gateway/src/agents/impact.ts` | 77.81% | |
| `packages/gateway/src/connectors/user-mcp-store.ts` | 77.97% | |
| `packages/gateway/src/platform/assemble.ts` | 77.75% | |
| `packages/gateway/src/auth/oauth-vault-tokens.ts` | 76.6% | |
| `packages/gateway/src/config/telemetry-toml.ts` | 76.64% | |
| `packages/gateway/src/ipc/http-write-routes.ts` | 79.38% | One extra branch |
| `packages/gateway/src/index/item-list-query.ts` | 75% | |
| `packages/gateway/src/connectors/sync-iso-helpers.ts` | 75% | |
| `packages/gateway/src/people/parse-from-header.ts` | 74.39% | |
| `packages/gateway/src/connectors/lazy-mesh/tool-map.ts` | 73.91% | |
| `packages/gateway/src/connectors/filesystem-v2-sync.ts` | 73.58% | Uses connector-sync-harness |
| `packages/gateway/src/platform/register-user-mcp-sync.ts` | 75% | |
| `packages/cli/src/lib/interactive-ipc-handlers.ts` | 79.34% | Non-gateway nudge |
| `packages/cli/src/tui/test-helpers/stub-client.ts` | 79.49% | Non-gateway nudge |
| `packages/sdk/src/contract-tests.ts` | 78.43% | Non-gateway nudge |

### Tier B — mid-range (60–69%)

| File | Baseline | Notes |
|---|---|---|
| `packages/gateway/src/db/verify.ts` | 70.06% | |
| `packages/gateway/src/config.ts` | 69.89% | |
| `packages/gateway/src/connectors/connector-vault.ts` | 67.74% | |
| `packages/gateway/src/connectors/connector-catalog.ts` | 64.71% | |
| `packages/gateway/src/auth/notion-access-token.ts` | 62.07% | |
| `packages/gateway/src/connectors/lazy-mesh/mesh.ts` | 60.83% | Largest gateway file; may need MockMcpClient |

### Tier C — real investment (30–59%)

| File | Baseline | Notes |
|---|---|---|
| `packages/gateway/src/connectors/user-mcp-sync.ts` | 52.63% | Uses connector-sync-harness |
| `packages/gateway/src/embedding/worker-bridge.ts` | 46.49% | Mocked Worker ctor |
| `packages/gateway/src/db/backups-list.ts` | 40.91% | Tmp-dir fs ops |
| `packages/gateway/src/connectors/sync-watermark-cursor-v1.ts` | 34.62% | |
| `packages/gateway/src/telemetry/flush-scheduler.ts` | 33.6% | Fake timers |
| `packages/gateway/src/auth/slack-access-token.ts` | 30.77% | |

### Tier C — voice (likely partial)

Subprocess-bound; may not reach 80% in this PR. Land partial improvement +
raised watermark per spec rule 3.

| File | Baseline |
|---|---|
| `packages/gateway/src/voice/wake-word.ts` | 51.18% |
| `packages/gateway/src/voice/tts.ts` | 41.76% |

### Tier D — testable

| File | Baseline | Test approach |
|---|---|---|
| `packages/gateway/src/config/session-toml.ts` | 20.75% | Pure TOML parser, very testable |
| `packages/gateway/src/embedding/create-embedding-runtime.ts` | 19.35% | Mocked vault + env |
| `packages/gateway/src/embedding/model.ts` | 13.51% | `tensorToRowVectors` pure helper tested in isolation; attempt full coverage of `createLocalEmbedder` via `mock.module("@xenova/transformers", ...)` to intercept the dynamic import. Fall back to partial + raised watermark if dynamic-import mocking proves fragile under Bun. |
| `packages/gateway/src/llm/registry.ts` | 0% | Mocked LlmRouter providers + tmp DB |
| `packages/gateway/src/platform/worker-security.ts` | 0% | Fresh MessageEvent-like objects |
| `packages/gateway/src/platform/gateway-state-file.ts` | 0% | Tmp dirs |

### Tier D — structural exclusions added in this PR

Each entry below is justified by zero-executable-code or worker-entry rationale,
matching precedent for `connectors/lazy-mesh/slot.ts`, `ipc/server/options.ts`,
`ipc/agent-invoke.ts`, `ipc/workflow-invoke.ts`,
`connector-rpc-handlers/context.ts` already in `exclusions.ts`.

**Worker-entry caveat:** Excluding `query-guard-worker.ts` and
`embedding-worker.ts` means Bun's V8 coverage stops measuring their interior
lines, but the *observable contract* (message shapes and side-effects) is still
exercised through their consumers — `worker-bridge.ts` (commit 9) for the
embedding worker, and the latency-ring-buffer / query-guard call sites for the
SELECT worker. A future phase could add a lightweight worker-contract harness
that spawns the actual `Worker`, posts canned messages, and asserts on the
reply shape — that would let us *remove* these exclusions later without
regressing the floor.

| File | Baseline | Justification |
|---|---|---|
| `packages/gateway/src/connectors/index.ts` | 0% | Pure re-export module (no executable JS after TS erasure) |
| `packages/gateway/src/embedding/embedding-runtime.ts` | 0% | Pure type-only file (24 lines, all `type` declarations) |
| `packages/gateway/src/embedding/embedding-worker.ts` | 0% | Worker entry, top-level `onmessage` handler; untestable in-process. The observable contract (init / embed_texts / embed_item message shapes) is exercised via `worker-bridge.ts` (commit 9) which is the consumer. |
| `packages/gateway/src/db/query-guard-worker.ts` | 0% | Worker entry; pure SELECT dispatch in separate process. The observable contract (postMessage payload shape) is exercised via the consumer call site, not via Bun's V8 coverage of this file. |
| `packages/gateway/src/index/ranked-item.ts` | 0% | Pure type alias (17 lines, all types) |
| `packages/gateway/src/vault/nimbus-vault.ts` | 0% | Interface-only file |
| `packages/gateway/src/vault/ffi-ptr.ts` | 0% | Tiny Windows-only FFI helper, only imported by `vault/win32.ts` — same per-OS shape as existing vault PAL exclusions |

### Out of scope (pinned, untouched)

These remain in baseline at their current watermarks:

| File | Baseline | Reason |
|---|---|---|
| `packages/gateway/src/ipc/http-server.ts` | 65.12% | Bun.serve socket-bound (Phase 2B-pinned) |
| `packages/gateway/src/ipc/server/server.ts` | 73.86% | Bun.listen socket-bound (Phase 2B-pinned + Windows-only regression) |
| `packages/gateway/src/ipc/server/socket-listeners.ts` | 45.21% | Bun.listen socket-bound (Phase 2B-pinned) |
| `packages/gateway/src/platform/paths.ts` | 39.62% | Phase 2B-pinned |
| `packages/gateway/src/platform/errors.ts` | 60% | Phase 2B-pinned |
| `packages/gateway/src/platform/index.ts` | 45.45% | Windows-only regression |
| `packages/gateway/src/vault/factory.ts` | 66.67% | Windows-only regression |
| `packages/cli/src/tui/App.tsx` | 57.6% | Phase 2B-pinned |

---

## Commit Structure

Single PR, 16 commits ordered low-risk → high-risk:

| # | Commit subject | Files | New tests |
|---|---|---|---|
| 1 | `chore(coverage-floor): add 7 structural exclusions for type-only / worker-entry files` | `exclusions.ts` + `sonar-project.properties` | 0 (existing parity test covers) |
| 2 | `test(near-floor): nudge 12 gateway files above 80% (Tier A)` | 12 gateway files | ~24 |
| 3 | `test(near-floor): nudge cli + sdk near-floor files above 80%` | 3 non-gateway | ~3 |
| 4 | `test(db,config): raise db/verify.ts + config.ts above 80% (Tier B)` | 2 files | ~8 |
| 5 | `test(connectors): raise connector-vault + connector-catalog above 80% (Tier B)` | 2 files | ~10 |
| 6 | `test(auth): raise notion-access-token above 80% (Tier B)` | 1 file | ~4 |
| 7 | `test(lazy-mesh): raise mesh.ts above 80% (Tier B, isolated)` | 1 file | ~8 — split out per review for surgical revertability |
| 8 | `test(connectors): cover user-mcp-sync via connector-sync-harness (Tier C)` | 1 file | ~6 |
| 9 | `test(embedding): cover worker-bridge happy + degraded paths (Tier C)` | 1 file | ~4 |
| 10 | `test(db): cover backups-list listing + filtering (Tier C)` | 1 file | ~4 |
| 11 | `test(connectors): cover sync-watermark-cursor-v1 (Tier C)` | 1 file | ~3 |
| 12 | `test(telemetry): cover flush-scheduler with fake timers (Tier C)` | 1 file | ~5 |
| 13 | `test(auth): cover slack-access-token (Tier C)` | 1 file | ~4 |
| 14 | `test(voice): partial coverage for tts + wake-word (Tier C-partial)` | 2 files | ~6 — best-effort, raise watermarks if <80% |
| 15 | `test(tier-d): cover llm/registry, session-toml, worker-security, gateway-state-file, create-embedding-runtime, embedding/model` | 6 files | ~18 |
| 16 | `chore(coverage-floor): drop raised entries + Phase 4 plan` | `coverage-baseline.json`, plan file, CLAUDE/GEMINI status row | 0 |

**Totals:** ~107 new tests across ~26 test files + 7 exclusion entries +
baseline drops.

**Ordering rationale:**
- Commit 1 ships first because exclusions are pure-config (zero reversibility risk).
- Tier A → B → C ordering keeps the high-confidence work in front.
- Tier D testable (commit 14) is last among test commits so any worker-thread
  surprise discoveries do not gate progress on easier work.
- Final commit drops baseline entries and adds the plan file in lockstep
  with the test work.

---

## Test Infrastructure

**No new shared harness needed.** Phase 4 is a long tail of mostly-independent
files. Reuse existing infrastructure:

| Pattern | Used by |
|---|---|
| `connector-sync-harness.ts` (Phase 2) | `connectors/user-mcp-sync.ts`, possibly `connectors/filesystem-v2-sync.ts` extension |
| Tmp-dir + fresh SQLite | `db/verify.ts`, `db/backups-list.ts`, `llm/registry.ts` |
| `MockVault` from `@nimbus-dev/sdk/testing` | `auth/{notion,slack,oauth-vault-tokens}.ts`, `connectors/connector-vault.ts`, `embedding/create-embedding-runtime.ts` |
| Bun's `mock.module()` for ONNX/transformers | `embedding/model.ts` (`tensorToRowVectors` pure helper without the `await import()`) |
| `Bun.spawn` mocking via stub | `voice/tts.ts`, `voice/wake-word.ts` (accept partial coverage if too messy) |
| Fake timers (`Bun.setTime` or manual clock) | `telemetry/flush-scheduler.ts` |
| Fresh `MessageEvent`-like objects | `platform/worker-security.ts` |

**Test file locations:** colocated per Phase 3 precedent (`*.test.ts` next to
source file).

---

## Carry-forwards from Phase 3A / 3B-rest

- `bun:sqlite` / `bun:test` IDE false positives — ignore; gateway typecheck
  from project root is authoritative.
- `db.run` / `db.exec` in test files is fine — static auditor skips
  `*.test.ts`.
- `exactOptionalPropertyTypes: true` — pass no property instead of
  `prop: undefined`.
- Local Windows lcov diverges from CI Linux on the 5 Phase 2B-pinned files +
  4 pre-existing Windows-only regressions. CI Linux is authoritative.
- Run `bun run lint:fix` before every commit.

---

## Acceptance

1. `bun run audit:coverage-floor:build-lcov && bun run audit:coverage-floor`
   exits 0 locally (CI Linux is authoritative for the merge gate).
2. `bun run audit:exclusion-parity` exits 0 — `sonar-project.properties` and
   `exclusions.ts` agree on the 7 new entries.
3. `bun run audit:invariants` exits 0 — D10 / D12 / vault-key allow-list
   unchanged.
4. `bun run lint` + `bun run typecheck` exit 0.
5. Baseline file's `min_coverage_pct` either rises to the new measured value
   (partial wins like voice/) or the entry is dropped entirely (raised to
   ≥80%).
6. ~40 baseline entries are removed (33 raised + 7 moved to exclusions); none
   added. Voice files may stay in baseline at raised watermarks if subprocess
   mocking does not reach 80%.
7. No file currently above 80% drops below 80% — checked by the floor gate.
8. The 3 Phase 2B-pinned IPC files + 4 Windows-regression files + 1 Phase
   2B-pinned TUI file remain untouched in baseline.

---

## Risks

| Risk | Mitigation |
|---|---|
| `voice/tts.ts` / `voice/wake-word.ts` subprocess mocking turns out to be deep — they may not reach 80% | Commit 13 lands a partial improvement with raised watermark. Spec rule 3 ("update upward in same PR") locks improvement in; follow-up can finish later. |
| `embedding/worker-bridge.ts` requires real worker-thread spawn to cover all paths | Cover happy + degraded-init + fall-through paths via mocked `Worker` ctor. If 80% isn't reachable, partial + raised watermark; document the residual in commit message. |
| `lazy-mesh/mesh.ts` (largest Tier B file) is 60.83% — getting it to 80% may need substantial mock surface | Already split into its own commit (commit 7) for surgical revertability per design review. Use existing `MockMcpClient` from `connector-sync-harness.ts` (mock surface API matches). |
| Adding 7 structural exclusions could regress the parity check if `sonar-project.properties` isn't updated in lockstep | Commit 1 updates both files together; `bun run audit:exclusion-parity` is the gate. |
| `embedding/embedding-runtime.ts` / `vault/nimbus-vault.ts` / `index/ranked-item.ts` are pure type files but don't match `**/*types*.ts` glob | Add as `kind: "exact"` entries with rationale comment (same pattern as `connectors/lazy-mesh/slot.ts`, `ipc/server/options.ts` already in `exclusions.ts`). |
| Bun's V8 coverage shows the 0% Tier D files as un-imported — they may not appear in lcov at all | The floor gate's source-walker treats missing-from-lcov as 0%; structural exclusion removes that requirement entirely (correct behavior for type-only files). |

---

## Out-of-band cleanup

Before starting the Phase 4 worktree, `rm -rf` the stale
`.worktrees/coverage-floor-phase-3b-rest-2026-05-20/` directory left over
from PR #370 (Windows "Filename too long" prevented `git worktree remove`;
the branch is already gone).

---

## Phase 4 → Phase 5 transition

After this PR merges, the baseline should be ~100 entries:

- ~51 cli entries (53 minus `interactive-ipc-handlers.ts` and
  `tui/test-helpers/stub-client.ts` raised in this PR)
- ~5 client entries (Phase 5A)
- ~4 sdk entries (5 minus `contract-tests.ts` raised in this PR)
- ~30 mcp-connectors entries (Phase 5 — `**/server.ts` files, all 0%)
- ~9 remaining gateway entries (the 3 Phase 2B-pinned IPC files + 4
  Windows-regression files + up to 2 voice files if subprocess mocking
  does not reach 80%)

Phase 5 then attacks the non-gateway packages (CLI + UI + vscode-extension)
per the spec's §"Phase 5".
