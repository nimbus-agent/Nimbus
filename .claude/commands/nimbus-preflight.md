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

## When your local green still doesn't match CI

- `bun run verify:docker` — runs the manifest's **fast**-tier gates inside `oven/bun:1.3` (the CI bun) at `/src`, a normal path. Reach for it when a gate is green locally for a reason that isn't correctness: a path exclusion (a worktree under `.claude/` excluded itself from Biome) or an OS difference. `--full` adds build + `test:ci` + coverage floor; `--rebuild` refreshes the cached image after a `BASE_IMAGE`/apt change.
- `bun run verify:pr` — reads the PR's real check state via `gh` and refuses to call a **conflicted or still-pending** PR green. A merge-conflicting PR runs no `pull_request` workflows at all and looks passing.
- `bun run typecheck:tests` — typechecks `packages/{gateway,ui}/test/**`, which no package's tsconfig `include` covers, so plain `typecheck` is blind to them (#1038). Ratchets against `docs/structure-audit/typecheck-tests-baseline.json`: only NEW errors fail. Part of `preflight:fast`; also runs in the ubuntu PR gate.
- `bun run typecheck:tests:update-baseline` — rewrite that baseline. Run it when you legitimately add debt, and when you **pay debt down** (the ratchet fails on an improvement so the slack gets banked rather than left as future allowance). Review the diff; it must never grow silently.

## The gate manifest (single source of truth)

`scripts/lib/preflight-gates.ts` — `PREFLIGHT_GATES` (each `{ name, cmd, tier }`) + `CI_ONLY_GATES` (gates CI runs that preflight intentionally skips: publish, packaging, external services, perf benches).

**Adding a new CI gate?** Add its `bun run`/`bunx` invocation to `PREFLIGHT_GATES` (right tier) — or, if it's genuinely CI-only, to `CI_ONLY_GATES`. The drift test `scripts/preflight.test.ts` parses every workflow's `run:` blocks and **fails** if a `bun run`/`bunx` gate is in neither list. This is what keeps local == CI.

## Cross-platform discipline

Develop on one OS, but CI runs all three (and PRs gate on Ubuntu). Build paths with `path.join()` / `os.tmpdir()` / `PlatformServices`, never hardcoded separators. `bun run audit:cross-platform` flags hardcoded **Windows-separator** path literals (backslash, drive-letter `C:\`, UNC `\\server`) in `*.test.ts(x)` assertions — the "passes on my Windows machine, fails on the Ubuntu PR gate" footgun. POSIX forward-slash absolutes (`/tmp/...`, `/home/...`) are intentionally **not** flagged: in this codebase they are overwhelmingly legitimate data values (socket-path fixtures, env-var pass-throughs, HTTP/API routes) that a regex cannot distinguish from a constructed path — an empirical pass produced 52 false positives and 0 real bugs, so reliable POSIX-absolute detection is deferred to the AST v2 rewrite (see the script header). Genuinely platform-specific literal? End the line with `// cross-platform-ok`.

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
