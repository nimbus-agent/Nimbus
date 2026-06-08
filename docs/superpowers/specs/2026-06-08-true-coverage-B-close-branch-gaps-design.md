# True Coverage — Sub-project B: Close Branch Gaps — Design

**Date:** 2026-06-08
**Branch (program):** `dev/asafgolombek/true-coverage-program` (Sub-project A, shipped as PR #530)
**Status:** Design — approved 2026-06-08
**Owner:** AsafGolombek
**Umbrella spec:** [`2026-06-07-true-coverage-program-design.md`](./2026-06-07-true-coverage-program-design.md) (§6 = B sketch)

## 1. Goal

Drive the day-1 branch-coverage baseline (`docs/structure-audit/coverage-baseline.json`,
v2 schema, **189 files / 184 below the 80% branch floor**) toward zero, subsystem by
subsystem, by **writing tests for uncovered branches** — never by rule-excluding real
production logic. Each PR is self-contained and shrinks the baseline.

This is a grind, **not a new mechanism**: the dual line+branch floor gate, the
dimension-agnostic ratchet (`computeBaselineDiff` / `computeUpdatedBaseline`), the Istanbul
preload, the merge step, and the CI wiring all shipped in Sub-project A. B only adds tests +
reseeds the baseline.

## 2. Policy decisions (chosen 2026-06-08)

1. **Sequencing = value-first (security-adjacent).** Order by trust/risk, not by bucket size:
   `engine` → `identity` → `ipc` → `db` → `extensions`, **then** the 59 connector mappers,
   then `cli` / `tui` / `search` / `embedding` / `index` / `platform` / remainder. Highest-trust
   code gets covered first; early PRs stay small.
2. **Test-support files = exclude now.** A handful of baseline entries are test-only helpers/
   fixtures (only imported by tests, not shipped logic): `cli/src/tui/test-helpers/context.ts`
   (branch 0), `cli/src/commands/cli-test-helpers.ts`, `cli/src/tui/ipc-context.ts`,
   `gateway/src/identity/identity-test-helpers.ts`, `gateway/src/updater/updater-test-fixtures.ts`.
   Add them to `exclusions.ts` with a justification comment (arguably Sub-project D scope, but
   cheap and removes noise from B's grind). **Verify each is genuinely test-only at PR time**
   (grep for non-test importers) before excluding.
3. **Reseed loop = Docker-local.** The baseline is **Linux-authoritative** (per-OS branch skew).
   Generate the reseed lcov by running the full instrumented suite in `oven/bun:latest`
   (bun 1.3.14 = CI, validated in Sub-project A) locally, reseed, and gate green **before**
   opening the PR — so the PR passes CI in one round (no CI-artifact round-trip).

## 3. The per-PR execution loop (fixed)

```text
1. git switch -c dev/asafgolombek/true-coverage-B<n>-<subsystem>   (from fresh main)
2. git merge origin/main           # file set == the PR-merge commit CI sees (A lesson)
3. Re-read the CURRENT baseline; pick the lowest-branch / highest-value files in the subsystem
4. TDD per file: failing test first → cover the UNHIT branches
      map: coverage/lcov.info BRDA:<line>,<block>,<branch>,<taken>
           taken '-' or '0' ⇒ uncovered → locate <line> in source → write a test that takes it
5. Docker full instrumented suite → coverage/lcov.info   (oven/bun:latest, --timeout 60000)
6. bun run audit:coverage-floor:update-baseline          # reseed from the Linux lcov
7. bun run audit:coverage-floor                          # MUST print `ok`, exit 0
8. commit (tests + reseeded baseline + any exclusions in ONE commit), open PR → main
9. CI confirms green in one round
```

**Invariants of the loop:**
- The reseed lcov is **always a full-suite run** (all bun-tested packages). A partial run omits
  files → `discoverSourceFiles()` flags them `missing_from_lcov`. (A lesson.)
- `git merge origin/main` **before** reseeding, every PR — CI runs the PR merged with main, so
  the baseline must be generated against that same file set. (A lesson — cost a debug cycle.)
- **Never reseed from a Windows/macOS run.** Docker (Linux) or the CI `coverage-lcov-merged`
  artifact only.
- Instrumented runs use `--timeout 60000` (Istanbul ~2-3× slower); the fast dev-loop stays 5000ms.
- After any fresh/restored worktree: `bun install` + `cd packages/client && bun run build`
  (merge-coverage.ts needs `istanbul-lib-*`; preflight typecheck needs `@nimbus-dev/client` dist).

## 4. PR slicing (value-first)

Counts are the day-1 snapshot; **re-pull the actual lowest-branch files per subsystem from the
then-current lcov at PR time** (main moves; watermarks shift).

| PR | Subsystem | ~Files | Notes |
|---|---|---|---|
| **B0** | Exclude test-support files | — (4–5 exclusions) | Lands first; removes baseline noise. Verify test-only before excluding. |
| **B1** | `gateway/engine` | 7 | delegated-approval-broker (50%), delegation-store, delegated-request-remote, quorum, etc. **Avoid the ★ flagship files** (executor HITL slice I2–I4, tool-output-envelope I11 — reserved for the 100% flagship). |
| **B2** | `gateway/identity` | ~5 (−1 helper) | I18 SSO/SCIM: deprovision (50%), identity-boot (62.5%), verifier paths. |
| **B3a** | `gateway/ipc` (part 1) | ~11 | session.ts (33%), updater-rpc (38%), lan-client (51%), rpc-error (50%), dispatchers. |
| **B3b** | `gateway/ipc` (part 2) | ~11 | remaining rpc handlers, server internals. |
| **B4** | `gateway/db` | 9 | write path; I9/I14 bound-param SQL guards. |
| **B5** | `gateway/extensions` | 8 | I16 install/verify, auto-update. |
| **B6–B9** | `gateway/connectors` | 59 (by family) | google-sync / microsoft-outlook-teams / atlassian-jira / linear-notion / `_lib` mappers — independent pure mappers, ~15/PR. |
| **B10+** | `cli/commands`, `cli/tui`, `search`, `embedding`, `index`, `platform`, `people`, `agents`, `updater`, `metrics`, `sync`, `mcp-connectors/*`, `client`, `sdk`, remainder | ~50 | Smaller subsystem PRs; ratchet to zero. |

Stop condition for B: the baseline reaches zero **branch**-below-floor entries (the `★` flagship
then takes the security core from 80→100; D handles exclusions + the 2 line-debt files).

## 5. Testing approach & guardrails

- **TDD per file** (superpowers:test-driven-development): failing test first, targeting specific
  uncovered branches — error paths, guard clauses, short-circuit `&&`/`||`, ternaries, exhaustive
  `switch`/never-default arms, optional-chaining fallbacks. Assert behavior, not just execution.
- **No `any`** in test code — `unknown` for external data; same strict bar as prod (repo
  non-negotiable #7). Tests pass Biome + `tsc --noEmit`.
- **No Phase-N+1 features** — coverage only; do not add behavior to reach a branch (if a branch is
  genuinely unreachable dead code, note it for D, don't fabricate a path).
- **Execution model:** superpowers:subagent-driven-development — one fresh foreground subagent per
  PR-sized task, followed by a review pass (requesting-code-review). Background subagents lack a
  shell (memory [[background-subagents-no-shell]]) — run foreground.
- **Worktree** under `.claude/worktrees/`; if it empties mid-session recover via
  `git worktree prune` + `git worktree add -f` (commits survive in shared `.git`,
  [[worktree-wiped-midsession-recovery]]).
- **`bun test` ≠ `tsc --noEmit`** — run both; a passing test suite can hide a type error
  ([[phase6-slice3-identity]]).
- **Validate the gate locally on Windows** (pure Bun, no node_modules) for `audit:coverage-floor`;
  but the **lcov generation** (`build-lcov` / `merge-coverage`) needs node_modules + Docker-Linux.

## 6. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Reseed from wrong file set (branch behind main) | `git merge origin/main` before every reseed (§3). |
| Partial-suite reseed drops files → false `missing_from_lcov` | Always full-suite Docker run. |
| Per-OS branch skew reseeds bad watermarks | Linux-only (Docker/CI) reseed; never Windows. |
| Excluding a file that *is* production logic | Grep for non-test importers before excluding (B0). |
| Touching ★ flagship files in B1 (engine) | Explicitly scope B1 away from executor HITL slice / tool-output-envelope; those go to 100% under the flagship. |
| Heavy integration tests flake over 5000ms under Istanbul | `--timeout 60000` on all instrumented runs (A lesson). |
| `must_raise` after reseed (idempotency) | Fixed in A (commit e341f5fc); reseed onto the existing v2 baseline, gate must print `ok`. |

## 7. Out of scope for B

- Mutation / property-based depth (Sub-project C) — except that B should not regress the one
  fast-check finding already logged for C.
- Exclusion-shrink via DI refactor (Sub-project D), beyond the B0 test-helper exclusions.
- Security core → 100% line+branch (Flagship ★) — B only lifts those files to the 80 floor if they
  are below it; the 80→100 push is the flagship's targets-overlay mechanism.
- UI / vscode-extension (Vitest, separate `branches=75` gate — not in this baseline's scope).
