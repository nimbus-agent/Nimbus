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
2. **Test-support files = exclude now.** Four baseline entries are test-only helpers/fixtures
   (imported only by `*.test.ts`, not shipped logic), verified 2026-06-08 by import grep:
   `cli/src/tui/test-helpers/context.ts` (branch 0), `cli/src/commands/cli-test-helpers.ts`,
   `gateway/src/identity/identity-test-helpers.ts`, `gateway/src/updater/updater-test-fixtures.ts`.
   Add them to `exclusions.ts` with a justification comment (arguably Sub-project D scope, but
   cheap and removes noise from B's grind). **Verification correction:** `cli/src/tui/ipc-context.ts`
   was initially considered but is **production code** (exports `IpcContext`/`useIpc()` consumed by
   `App.tsx`/`tui.tsx`/`SubTaskPane.tsx`) — it is **not** excluded; it stays in the baseline for the
   B10 tui PR. Always grep for non-test importers before excluding.
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

### 3.1 Reseed helper script (authored in B0)

To make step 5 fast and reproducible, B0 adds **`scripts/coverage-floor/reseed-docker.sh`**:
it runs the instrumented `audit:coverage-floor:build-lcov` + `coverage:merge` inside
`oven/bun:latest`, mounting a **named Docker volume** (`nimbus-bun-cache`) at the container's bun
install cache so `bun install` only pays full cost on the first run. The host repo is mounted so the
produced `coverage/lcov.info` lands back on the host; the caller then runs `:update-baseline` +
`audit:coverage-floor` on the host (pure Bun, no node_modules). A named volume — not a host-path
bind of the host's bun cache — avoids Windows-host ↔ Linux-container cache-layout mismatch. The
script is validated on first use in B1's reseed.

### 3.2 Baseline merge-conflict resolution (no special tooling)

PRs are **sequential** (one subsystem PR at a time, each branched from fresh `main` after the prior
merges), and only coverage PRs ever edit `coverage-baseline.json`, so conflicts are rare. When one
does occur, the resolution needs **no hand-merge and no extra Docker run** — the per-PR reseed *is*
the resolution: take main's baseline, then re-ratchet against the fresh lcov:

```sh
git checkout --theirs docs/structure-audit/coverage-baseline.json   # start from main's watermarks
bun run audit:coverage-floor:update-baseline                        # ratchet: max(main, my fresh lcov)
bun run audit:coverage-floor                                        # ok
```

This is safe because `computeUpdatedBaseline` re-seeds from **both** the existing (main's) baseline
keys *and* the discovered source files, taking `Math.max(existing, actual)` per axis — so main's
unrelated entries are preserved and my improved files ratchet up. An auto-merge "pick the lower
watermark" utility (review #3) is therefore unnecessary and is **not** built.

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
- **No Phase-N+1 features** — coverage only; do not add behavior to reach a branch.
- **Defensively-unreachable branches — policy (review #2).** Many uncovered branches are defensive
  guards (exhaustive `switch` `default:` arms, `never`-exhaustiveness checks, type-narrowing
  fallbacks). Apply this rule, in order:
  1. **Prefer triggering it with a type-safe cast.** Type the bad input as `unknown` and narrow/cast
     it (or `as never` for an exhaustive-default arm), then assert the guard's behavior (e.g. it
     throws / returns the fallback). `as never` and casting *through* `unknown` are allowed in tests;
     **`any` is not** (non-negotiable #7). This genuinely tests the defense and is the default.
  2. **If it is truly unreachable** (no input — even a cast — can take it; it exists only as a
     TS-narrowing artifact istanbul counts but JS can't reach): do **not** fabricate a path and do
     **not** add `/* istanbul ignore */`. Leave it; the ratchet holds the file's watermark (never
     regresses) and the file stays in the baseline. Record it as a **Sub-project D** candidate
     (DI-refactor or justified ignore). `istanbul ignore` is a D tool with explicit justification,
     **never** a B shortcut — this keeps B aligned with fix-not-exclude ([[sonar-prefer-fix-over-exclude]]).
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

## 8. Review dispositions (2026-06-08)

Addressing [the design review](./2026-06-08-true-coverage-B-close-branch-gaps-design-review.md):

1. **Docker reseed speed/scripting — FIXED.** B0 authors `scripts/coverage-floor/reseed-docker.sh`
   using a **named Docker volume** for the bun cache so `bun install` is paid once, not per run
   (§3.1). A named volume (not a host-bind of the host bun cache) sidesteps the Windows↔Linux
   cache-layout mismatch the reviewer's host-mount suggestion would hit.
2. **Defensively-unreachable branches — FIXED (policy added).** §5 now has an explicit ordered rule:
   prefer triggering the guard with a type-safe cast (`unknown`/`as never`, never `any`); only if
   truly unreachable, leave it (ratchet holds it) and record a Sub-project D candidate. `istanbul
   ignore` is a D tool with justification, **never** a B shortcut — keeps B fix-not-exclude.
3. **Baseline merge conflicts — FIXED (documented), tool DEFERRED (not built).** §3.2 documents the
   resolution: `git checkout --theirs` the baseline, then re-run `update-baseline` — the per-PR
   reseed already does the ratcheted merge (`Math.max(existing, actual)`), so there is **no extra
   Docker run** and **no hand-merge**. The reviewer's premise (parallel PRs) doesn't hold — B PRs are
   sequential and only coverage PRs touch the baseline, so conflicts are rare. An auto-merge utility
   is unnecessary; not built (YAGNI).
4. **Enforce excluded helpers stay test-only — DEFERRED (with interim mitigation).** A static
   prod-vs-test import scanner is its own mini-project (reliable import classification) — out of
   scope for B and better placed in D. Interim mitigation in B0: (a) `grep` for non-test importers
   before excluding each file; (b) a justification comment in `exclusions.ts`; (c) note that
   `discoverSourceFiles()` already auto-skips `/testing/`, `/__fixtures__/`, `/test/fixtures/`
   (check.ts:125-127), so relocating a helper under `testing/` self-excludes it without a list
   entry — recorded as the preferred D-time hardening. Risk is low: a future prod→helper import
   would surface in review and would pull test-only code into the shipped graph.
5. **Windows path normalization in `audit:coverage-floor` — VERIFIED, no change.** Confirmed in code:
   `discoverSourceFiles()` does `rawRel.replaceAll("\\", "/")` (check.ts:119), the baseline stores
   forward-slash keys, and `merge-coverage.ts` normalizes the lcov's `SF:` paths to `/`. The gate ran
   clean on the Windows dev box throughout Sub-project A. No change needed.
