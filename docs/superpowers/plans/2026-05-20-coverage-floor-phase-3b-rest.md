# Coverage Floor Phase 3B-rest — Remaining IPC RPC Dispatchers

**Goal:** Raise the 4 remaining baseline-RPC files above the 80% per-file
line-coverage floor, building on the `rpc-harness.ts` introduced in
[Phase 3A](./2026-05-20-coverage-floor-phase-3a.md) (PR #369).

**Spec:** [`docs/superpowers/specs/2026-05-17-coverage-floor-design.md`](../specs/2026-05-17-coverage-floor-design.md)
§"Phasing — Phase 3".

**Branch:** `dev/asafgolombek/coverage-floor-phase-3b-rest-2026-05-20`
(branched from `main` at `f31711db`, the Phase 3A merge).

**Worktree:** `.worktrees/coverage-floor-phase-3b-rest-2026-05-20/`

---

## Scope

Phase 3A shipped the harness + 4 RPC files (people-rpc, connector-rpc-
handlers/{status,config,lifecycle}). This PR covers the remaining
RPC files in the baseline:

| File | Baseline | After (local lcov) | Delta |
|---|---|---|---|
| `ipc/connector-rpc.ts` | 68.29% | **100%** (83/83) | +31.71 |
| `ipc/server/vault-dispatch.ts` | 65.17% | **98.84%** (85/86) | +33.67 |
| `ipc/server/dispatchers.ts` | 78.23% | **81.51%** (498/611) | +3.28 |
| `ipc/server/inline-handlers.ts` | 51.5% | **95.67%** (243/254) | +44.17 |

**Pinned per the Phase 2B precedent (not touched in this PR):**

- `ipc/server/server.ts` (73.86%) — Bun.listen socket-listener; pre-existing
  local-vs-CI drift on Windows (the user's recap listed it explicitly in
  the "3 pre-existing local-vs-CI regressions" set alongside platform/
  index.ts and vault/factory.ts).
- `ipc/server/socket-listeners.ts` (45.21%) — Phase 2B spec'd pin.
- `ipc/http-server.ts` (65.12%) — Bun.serve startup with platform side
  effects.

After this PR, the baseline still contains these three IPC entries; they
are explicitly out of scope.

---

## Per-commit summary

The PR lands in 5 commits in order:

1. `test(vault-dispatch): apply RPC harness (Phase 3B-rest)`
   — 19 cases: every dispatch method + invalid-param + key-format
   branches; rpcVaultOrMethodNotFound with both with/without LocalIndex.
   65.17% → 91.86%.

2. `test(connector-rpc): cover routing + HITL gates (Phase 3B-rest)`
   — 13 cases: connector.addMcp/remove gate paths (missing toolExecutor,
   rejected gate, proceed); simple routings (listStatus, pause, resume,
   setInterval, status, healthHistory, sync); the connector.startAuth
   deprecation alias once-flag + reset. 68.29% → 98.80%.

3. `test(dispatchers): cover body lines past the skip sentinels`
   — 8 cases pushing dispatchers.ts just over the 80% floor. The
   existing dispatchers.test.ts is comprehensive for "skipped" early
   returns but never exercises the try/catch body; this commit adds
   tests for assertDiagnosticsRpcAccess fall-through, tryDispatchVoiceRpc
   body, tryDispatchAgentsRpc body, tryDispatchAuditRpc happy path.
   78.23% → 81.51%.

4. `test(inline-handlers): cover RPC handlers + dispatchers`
   — 26 cases (biggest commit): rpcGatewayPing + rpcAuditList +
   rpcConsentRespond + rpcIndexSearchRanked with full param-parsing
   coverage; dispatchAgentInvoke handler-absent + handler-present +
   sendChunk streaming behaviour + sessionId/agent normalization;
   dispatchWorkflowRunRpc all 4 early-throws + happy path + paramsOverride
   parsing; dispatchEngineAskStream handler-absent + present. 51.5% →
   95.67%.

5. `chore(coverage-floor): drop 4 raised entries + Phase 3B-rest plan`
   (this final commit) — coverage-baseline.json drops, this plan file,
   CLAUDE/GEMINI status row.

---

## Carry-forwards from Phase 3A

- `bun:sqlite` / `bun:test` IDE false positives — ignore; gateway
  typecheck from project root is authoritative.
- `db.run` / `db.exec` in test files is fine — static auditor skips
  `*.test.ts` (`iterateSourceFiles` in `scripts/structure-audit/lib.ts`).
- `exactOptionalPropertyTypes: true` — pass no property instead of
  `prop: undefined`.
- Local Windows lcov diverges from CI Linux on the 5 Phase 2B-pinned
  files + 4 pre-existing regressions. CI Linux is authoritative.
- Run `bun run lint:fix` before every commit.

---

## Acceptance

- `bun test packages/gateway/src/ipc/{connector-rpc-routing,server/{vault-dispatch,dispatchers-happy-paths,inline-handlers}}.test.ts`
  — all green (66 new tests).
- `bun run audit:coverage-floor` (CI Linux) — green on `main` after merge;
  no must-remove violations against the 4 dropped entries.
- The 3 deferred IPC pinned files (server.ts, socket-listeners.ts,
  http-server.ts) stay in the baseline at their current watermarks; no
  must-raise violations on CI Linux.

---

## Total Phase 3 delivered (3A + 3B-rest)

| Layer | Phase 3A (PR #369) | Phase 3B-rest (this PR) | Cumulative |
|---|---|---|---|
| Baseline entries dropped | 7 (3 type-only + 4 raised) | 4 raised | 11 |
| RPC files at ≥80% line cov | 4 | 4 | 8 of the 11 RPC baseline entries |
| New tests | 71 | 66 | 137 |
| Test files added | 4 + 1 harness | 4 | 8 + 1 harness |

The 3 remaining IPC baseline files (server.ts, socket-listeners.ts,
http-server.ts) are all Bun.listen/Bun.serve socket-bound and treated
as Phase 2B-pinned. They are not scoped to Phase 3; future work would
need a different test strategy (E2E with a real socket pair).
