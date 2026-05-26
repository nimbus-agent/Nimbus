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

## The gate manifest (single source of truth)

`scripts/lib/preflight-gates.ts` — `PREFLIGHT_GATES` (each `{ name, cmd, tier }`) + `CI_ONLY_GATES` (gates CI runs that preflight intentionally skips: publish, packaging, external services, perf benches).

**Adding a new CI gate?** Add its `bun run`/`bunx` invocation to `PREFLIGHT_GATES` (right tier) — or, if it's genuinely CI-only, to `CI_ONLY_GATES`. The drift test `scripts/preflight.test.ts` parses every workflow's `run:` blocks and **fails** if a `bun run`/`bunx` gate is in neither list. This is what keeps local == CI.

## Cross-platform discipline

Develop on one OS, but CI runs all three (and PRs gate on Ubuntu). Build paths with `path.join()` / `os.tmpdir()` / `PlatformServices`, never hardcoded separators. `bun run audit:cross-platform` flags hardcoded **Windows-separator** path literals (backslash, drive-letter `C:\`, UNC `\\server`) in `*.test.ts(x)` assertions — the "passes on my Windows machine, fails on the Ubuntu PR gate" footgun. POSIX forward-slash absolutes (`/tmp/...`, `/home/...`) are intentionally **not** flagged: in this codebase they are overwhelmingly legitimate data values (socket-path fixtures, env-var pass-throughs, HTTP/API routes) that a regex cannot distinguish from a constructed path — an empirical pass produced 52 false positives and 0 real bugs, so reliable POSIX-absolute detection is deferred to the AST v2 rewrite (see the script header). Genuinely platform-specific literal? End the line with `// cross-platform-ok`.

## Git guardrails (opt-in)

`bun run hooks:install` points `core.hooksPath` at `.githooks/` (warns + needs `--force` if you already use another hooks path):

- **pre-commit** refuses commits on `main`/`develop` — branch first. Override: `NIMBUS_ALLOW_DEFAULT_BRANCH_COMMIT=1`.
- **pre-push** runs `preflight:fast`. Override (emergency/trivial): `NIMBUS_SKIP_PREPUSH=1`.

## SonarQube

The SonarQube Cloud analysis step is `continue-on-error: true` — an external `sonar-scanner` failure (e.g. exit 3) does not fail the build, and is not a branch-protection required check. Analysis still uploads to the SonarCloud dashboard; review it there.
