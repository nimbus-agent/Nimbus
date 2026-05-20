# Coverage Floor Phase 3A + partial 3B — IPC RPC Harness + Apply

**Goal:** Build `rpc-harness.ts` and apply it end-to-end to four IPC dispatcher
files (`people-rpc.ts`, `connector-rpc-handlers/{status,config,lifecycle}.ts`),
raising each above the 80% per-file line-coverage floor. Drop 7 entries from
`docs/structure-audit/coverage-baseline.json` (3 type-only exclusions + 4
raised-above-floor files).

**Spec:** [`docs/superpowers/specs/2026-05-17-coverage-floor-design.md`](../specs/2026-05-17-coverage-floor-design.md)
§"Phasing — Phase 3".

**Branch:** `dev/asafgolombek/coverage-floor-phase-3-2026-05-20`
(branched from `main` at `ab3e2673`).

**Worktree:** `.worktrees/coverage-floor-phase-3-2026-05-20/`

---

## Scope deltas from the spec

The spec was written when `diagnostics-rpc.ts` and `automation-rpc.ts` still
sat in the coverage baseline. Both gained colocated tests before this PR
and are now ≥80% (not in baseline). The "first end-to-end consumer" for
Phase 3A is therefore **`people-rpc.ts`** (179 lines, 57.04% baseline,
no existing test) — same shape as the spec's diagnostics-rpc choice but
with a meaningful uncovered surface to prove the harness against.

Phase 3B coverage in this PR is **partial**: 3 of the 5 spec'd RPC files
that remain in the baseline are raised above the floor. The remaining 5
(`ipc/server/inline-handlers.ts`, `ipc/server/vault-dispatch.ts`,
`connector-rpc.ts`, `ipc/server/dispatchers.ts`, `ipc/server/server.ts`)
require a richer `ServerCtx` mock (`ToolExecutor`, `ConnectorDispatcher`,
`ClientSession`) and are deferred to a follow-up PR (`coverage-floor
phase 3b-rest`). `socket-listeners.ts` and `http-server.ts` remain pinned
per the Phase 2B precedent (`socket-listeners` is in the spec but the
Phase 2B chore precedent kept it).

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `scripts/coverage-floor/exclusions.ts` | Modify | Add 3 type-only IPC context files to the existing "Type-only files" block. |
| `sonar-project.properties` | Modify | Mirror the 3 new exclusions in `sonar.coverage.exclusions`. |
| `packages/gateway/test/helpers/rpc-harness.ts` | Create | Shared fixture: in-memory SQLite + LocalIndex + MockVault + MockNotificationLog + bound `notify` + temp `dataDir`/`configDir` + best-effort cleanup. |
| `packages/gateway/src/ipc/people-rpc.test.ts` | Create | 33 cases: 6 RPC methods + 4 error helpers + dispatcher miss. |
| `packages/gateway/src/ipc/connector-rpc-handlers/status.test.ts` | Create | 20 cases: list/single status + health history; default+clamped limits + invalid id paths. |
| `packages/gateway/src/ipc/connector-rpc-handlers/config.test.ts` | Create | 13 cases: `handleConnectorAddMcp` (8) + `handleConnectorSetInterval` (5). The existing `connector-rpc-handlers-setconfig.test.ts` already covered `SetConfig` + Pause/Resume. |
| `packages/gateway/src/ipc/connector-rpc-handlers/lifecycle.test.ts` | Create | 5 cases: `handleConnectorSync` (the function the existing setconfig test didn't reach). |
| `docs/structure-audit/coverage-baseline.json` | Modify | Drop 7 entries: 3 type-only + 4 raised above floor. |
| `CLAUDE.md` | Modify (1 line) | Append `Coverage floor Phase 3A ✅ (2026-05-20)` to the Phase 5 status row. |
| `GEMINI.md` | Modify (1 line) | Mirror CLAUDE.md change. |
| `docs/superpowers/plans/2026-05-20-coverage-floor-phase-3a.md` | This file — committed in the FINAL commit. | Matches the 2A precedent (PR #338) of holding the plan for the last commit so the PR diff tells the story chronologically. |

---

## Carry-forwards from Phase 2A/B/C (load-bearing)

- **TS strict + `exactOptionalPropertyTypes: true`** — pass no property instead
  of `prop: undefined`. `seedPerson(_, { id: "p1", metadata: undefined })`
  fails; `seedPerson(_, { id: "p1" })` succeeds.
- **`bun:sqlite` / `bun:test` IDE false positives** — ignore; `bun run
  typecheck` from project root is authoritative.
- **CI Linux lcov is authoritative for the gate.** Local Windows lcov
  matches within a few % but `process.platform`-branched files can shift.
  Spot-checked all 4 raised files at ≥93% locally; CI will produce the
  binding numbers.
- **`db.run` / `db.exec` in tests is fine** — `iterateSourceFiles` in
  `scripts/structure-audit/lib.ts` skips `*.test.ts`, so I14 enforcement
  doesn't gate test seeding paths.
- **Run `bun run lint:fix` before every commit** — Biome formatting
  failures under `set -eo pipefail` make `coverage/lcov.info` silently
  empty.

---

## Per-commit summary

The PR lands in 8 commits in order:

1. `test(coverage-floor): exempt 3 type-only IPC context files (Phase 3 setup)`
   — `agent-invoke.ts`, `workflow-invoke.ts`, `connector-rpc-handlers/context.ts`.

2. `test(coverage-floor): scaffold RPC harness (Phase 3 backbone)`
   — `packages/gateway/test/helpers/rpc-harness.ts`.

3. `test(people-rpc): apply RPC harness end-to-end (Phase 3A proof)`
   — 33 cases, 100% line coverage (135/135).

4. `test(connector-rpc-status): apply RPC harness (Phase 3B)`
   — 20 cases, 96.2% line coverage (51/53).

5. `test(connector-rpc-config): cover handleConnectorAddMcp + SetInterval`
   — 13 cases, 97% line coverage (98/101).

6. `test(connector-rpc-lifecycle): cover handleConnectorSync`
   — 5 cases, 93.8% line coverage (61/65).

7. `chore(coverage-floor): drop 4 baseline entries + Phase 3A plan` (this
   final commit) — coverage-baseline.json drops, plan file, CLAUDE/GEMINI
   status row.

---

## Acceptance

- `bun test packages/gateway/src/ipc/{people-rpc,connector-rpc-handlers/{status,config,lifecycle}}.test.ts` — all green.
- `bun run audit:exclusion-parity` — 18 sonar patterns all covered.
- `bun run audit:coverage-floor` (CI Linux) — green on `main` after merge;
  no must-remove violations against the 4 dropped entries.
- The 5 deferred 3B files stay in the baseline at their current
  watermarks; no must-raise violations.

---

## Follow-up: Phase 3B-rest

A separate PR will cover the remaining 5 files using the harness this PR
ships. Scoping:

- `ipc/server/inline-handlers.ts` (313 lines, 51.5%) — needs full
  `ServerCtx` + `ClientSession` + `dispatchAgentInvoke` mocks.
- `ipc/server/vault-dispatch.ts` (121 lines, 65.17%) — needs
  `ToolExecutor` stub + `bindConsentChannel`.
- `ipc/connector-rpc.ts` (130 lines, 68.29%).
- `ipc/server/dispatchers.ts` (730 lines, 78.23%) — small nudge.
- `ipc/server/server.ts` (259 lines, 73.86%) — evaluate; may need to pin
  alongside `socket-listeners.ts` and `http-server.ts` if socket side
  effects dominate the uncovered surface.

The harness from this PR is the dependency; nothing else blocks Phase
3B-rest.
