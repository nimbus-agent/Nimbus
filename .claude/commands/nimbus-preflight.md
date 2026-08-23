---
name: nimbus-preflight
description: >
  How to run the local CI-parity pre-flight before pushing a Nimbus PR, why
  `test:ci` is not enough, and the workflow guardrails. Use this skill when the
  user asks "what should I run before pushing", "why did my PR fail CI", "how do
  I avoid CI failures", "pre-flight" / "preflight", "which gates does CI run",
  when wiring a new CI gate (it must be added to the manifest or the drift test
  fails), or when touching cross-platform path code / git hooks / SonarQube CI.
---

# Nimbus Pre-flight & Workflow Guardrails

## Run this before pushing

- `bun run preflight` — **full** local CI parity: every gate CI runs (typecheck, Biome, markdownlint, all `audit:*`, duplication, cross-platform, build, `test:ci`, coverage floor). Fail-fast; `--no-bail` runs them all; `--list` prints the gate list.
- `bun run preflight:fast` — the cheap static gates only (~2-3 min). Catches the majority of PR failures without the full test run.

**`bun run test:ci` runs only the test suite — it is NOT the full gate set.** `preflight` is. The historical habit of running just `test:ci` is the #1 cause of PRs that fail on gates the author never ran locally.

## Merging — the gate only protects `main` if you wait for it

**One check gates the merge:** `PR quality — required gates`, an `if: always()` aggregator that
`needs:` every other PR job. Adding, renaming or matrix-ing a gate therefore never needs a ruleset
edit — but it also means a single green tick is the *only* thing standing between a red leg and
`main`.

**The bypass is silent.** The _General_ ruleset (14784377) lists that check as required with
`strict_required_status_checks_policy: true`, and its sole bypass actor is `OrganizationAdmin` with
`bypass_mode: "always"`. For a repo admin the merge button stays enabled while checks are pending,
and using it produces **no bypass annotation anywhere on the PR**. Nothing in the UI distinguishes
"merged green" from "merged before the gate reported".

- Wait for `PR quality — required gates` to report, or delegate the waiting:
  `gh pr merge <n> --squash --auto`.
- `bun run verify:pr` exists for exactly this and refuses to call a still-pending PR green.
- **Triage rule:** when `main` goes red, compare the merge timestamp to the required check's
  `started_at` *before* reaching for a flake explanation:

  ```bash
  gh pr view <n> --json mergedAt,mergedBy
  gh api repos/nimbus-agent/Nimbus/commits/<sha>/check-runs \
    --jq '.check_runs[]|select(.name=="PR quality — required gates")|{status,conclusion,started_at,completed_at}'
  ```

  A merge-before-green is indistinguishable from a post-merge regression until you look at the
  clock. Precedent: #1298 merged at 17:47:15Z; its required gate started at 17:57:44Z and failed.

## When your local green still doesn't match CI

- `bun run verify:docker` — runs the manifest's **fast**-tier gates inside `oven/bun:1.3` (the CI bun) at `/src`, a normal path. Reach for it when a gate is green locally for a reason that isn't correctness: a path exclusion (a worktree under `.claude/` excluded itself from Biome) or an OS difference. `--full` adds build + `test:ci` + coverage floor; `--rebuild` refreshes the cached image after a `BASE_IMAGE`/apt change.
- `bun run verify:docker --changed` — runs **only the tests your branch touched** in the CI Linux image: the changed `.test.ts` files, plus the colocated `.test.ts` sibling of every changed source file. This is the answer to the largest *real* PR-failure category — "Unit tests (with coverage) — Linux" was 6 of the 15 identified step failures in the 2026-08-21 sample, and it does not reproduce on a Windows or macOS box at all, so the only way to see one was to push and wait ~12 minutes. Typically seconds once the image is cached. **It is not a substitute for `--full`:** `mock.module` contamination is a CROSS-FILE effect that appears only in the combined `bun test packages/cli/src` run, so a narrow run cannot reproduce it — a green `--changed` is evidence about your files, never about the suite. With no changed test file and no colocated sibling it exits 0 and says so rather than degrading into a whole-suite run.
- `bun run verify:pr` — reads the PR's real check state via `gh` and refuses to call a **conflicted or still-pending** PR green. A merge-conflicting PR runs no `pull_request` workflows at all and looks passing. It also fails when the merge-gating check is **absent** from the list entirely — the #1298 shape, where reported checks were green because the aggregator had not been created yet.
- `bun run typecheck:tests` — typechecks `packages/{gateway,ui}/test/**`, which no package's tsconfig `include` covers, so plain `typecheck` is blind to them (#1038). Ratchets against `docs/structure-audit/typecheck-tests-baseline.json`: only NEW errors fail. Part of `preflight:fast`; also runs in the ubuntu PR gate.
- `bun run audit:platform-test-gaps` — **advisory, runs inside `preflight:fast`.** Names the tests in your diff that will not execute on your OS. `it.skipIf(process.platform === "win32")` never runs on a Windows dev box: `bun test` and `preflight` both report green having skipped it, so CI is its first execution and a red macOS leg is your first feedback. Measured on this repo: `platform/sandbox/win32.test.ts` has **4 tests that cannot run on Windows** — including the one that reached `main` red on 2026-08-21. It exits 0 always (platform-gated tests are correct; not knowing about them is the defect), and under-reports by design — it decides only literal `process.platform` / `platform()` comparisons and stays silent on composite conditions, so "nothing reported" is never proof of full coverage. When it names POSIX-only sites, `bun run verify:docker` executes them; macOS-only sites have no local equivalent.
- `bun run typecheck:tests:update-baseline` — rewrite that baseline. Run it when you legitimately add debt, and when you **pay debt down** (the ratchet fails on an improvement so the slack gets banked rather than left as future allowance). Review the diff; it must never grow silently.

## The gate manifest (single source of truth)

`scripts/lib/preflight-gates.ts` — `PREFLIGHT_GATES` (each `{ name, cmd, tier }`) + `CI_ONLY_GATES` (gates CI runs that preflight intentionally skips: publish, packaging, external services, perf benches).

**Adding a new CI gate?** Add its `bun run`/`bunx` invocation to `PREFLIGHT_GATES` (right tier) — or, if it's genuinely CI-only, to `CI_ONLY_GATES`. The drift test `scripts/preflight.test.ts` parses every workflow's `run:` blocks and **fails** if a `bun run`/`bunx` gate is in neither list. This is what keeps local == CI.

## Cross-platform discipline

Develop on one OS, but CI runs all three — and **PRs now gate on macOS + Windows too**, not just
Ubuntu: `pr-quality-cross-platform` runs one leg on `macos-15` and one on `windows-2025`, each
executing the SAME whole-repo command as the push matrix
(`bun test packages/gateway packages/cli packages/mcp-connectors scripts`, one process). Treat "it
passes on Ubuntu" as covering roughly half the gate. Note what that equality buys and what it does
not: the legs now load the same FILES in the same PROCESS as the push run, which is what makes a
green PR leg predictive at all — but they still run on runners ~13–18× slower than a dev machine,
so a wall-clock assumption that holds locally can still fail there. Build paths with `path.join()` / `os.tmpdir()` / `PlatformServices`, never hardcoded separators. `bun run audit:cross-platform` flags hardcoded **Windows-separator** path literals (backslash, drive-letter `C:\`, UNC `\\server`) in `*.test.ts(x)` assertions — the "passes on my Windows machine, fails on the Ubuntu PR gate" footgun. POSIX forward-slash absolutes (`/tmp/...`, `/home/...`) are intentionally **not** flagged: in this codebase they are overwhelmingly legitimate data values (socket-path fixtures, env-var pass-throughs, HTTP/API routes) that a regex cannot distinguish from a constructed path — an empirical pass produced 52 false positives and 0 real bugs, so reliable POSIX-absolute detection is deferred to the AST v2 rewrite (see the script header). Genuinely platform-specific literal? End the line with `// cross-platform-ok`.

## Git guardrails (opt-in)

`bun run hooks:install` points `core.hooksPath` at `.githooks/` (warns + needs `--force` if you already use another hooks path):

- **pre-commit** refuses commits on `main`/`develop` — branch first. Override: `NIMBUS_ALLOW_DEFAULT_BRANCH_COMMIT=1`.
- **pre-push** runs `preflight:fast`. Override (emergency/trivial): `NIMBUS_SKIP_PREPUSH=1`.

## SonarQube — the quality gate IS blocking

Two distinct steps in `_test-suite.yml`, do not conflate them:

- **"SonarQube Cloud analysis"** (the `sonar-scanner` upload) is `continue-on-error: true` — a transient scanner failure (e.g. exit 3) does not fail the build.
- **"SonarQube quality gate (enforced)"** polls the `project_status` API and **`exit 1`s when the gate verdict is `ERROR`** — this **blocks the PR / push check**. New-code coverage, new smells/bugs/vulns, and unreviewed security hotspots can all flip the gate to ERROR.

There is no local equivalent packaged (it needs `SONAR_TOKEN` + server-side analysis). If a PR's SonarCloud check is red, use the **`nimbus-sonar-gate`** agent — it queries the gate + issues + hotspots via the API and applies fix-not-exclude fixes.

## Gates you CANNOT reproduce on one dev box

These only run in CI (other OS, external tooling, or network) — when one reds, don't guess, drive it down with the named agent:

- **Coverage floor** is **Linux-authoritative**: local lcov on Windows/macOS diverges from CI by tens of percent on OS-specific files. Reproduce with `scripts/coverage-floor/reseed-docker.sh` (builds the lcov in `oven/bun:latest` == CI bun). Red gate → **`nimbus-coverage-floor`** agent.
- **SonarCloud quality gate** (above) → **`nimbus-sonar-gate`** agent.
- **Cross-platform Windows/macOS** unit legs, **client node-compat** (real Node 20 ESM), **CodeQL / Trivy / cargo-audit / cargo-deny**, **install-smoke (3-OS)** — accept as push-time; a red here → **`nimbus-ci-doctor`** agent.

## Two static gates worth knowing

- **`audit:status-drift`** — keeps the doc "status surfaces" (CLAUDE.md, GEMINI.md, architecture.md, SECURITY-INVARIANTS.md) in sync with the canonical highest invariant (`I<N>`) and schema version (`V<N>`) read from code. Bumping an invariant/migration without updating the status lines fails this gate.
- **`audit:action-sha-pins`** — asserts every third-party `uses:` in `.github/workflows` is pinned to a full 40-hex SHA (the org **requires** SHA-pinning; an unpinned tag ref is rejected at run time). Local `./` and reusable-workflow refs are exempt.
- **`audit:workflow-run-triggers`** — asserts every `workflow_run` consumer names only upstream workflows that an outside contributor cannot fire (allowlist: `push`, `workflow_dispatch`, `schedule`). `publish-package-managers.yml` / `publish-linux-repo.yml` check out `workflow_run.head_sha` with release secrets in scope; that is safe **only** because their sole upstream ("Release") runs on tag push. Adding `pull_request` to an upstream turns them into a live pwn-request — this gate reds instead.
