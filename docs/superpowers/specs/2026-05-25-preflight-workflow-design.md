# Pre-flight Workflow Overhaul — Design Spec

**Date:** 2026-05-25
**Branch:** `dev/asafgolombek/preflight-workflow`
**Goal:** Cut repeated PR/CI failures by making the full CI gate set runnable locally in one fail-fast command, keeping local==CI from drifting, catching the cross-platform class statically, de-flaking external checks, and adding lightweight git guardrails.

---

## Problem (evidence-based)

From real CI history (representative: PR #422):

1. **Gate-coverage gap.** CI gates are spread across 5 workflows; the documented local pre-flight (`bun run test:ci` = `scripts/run-tests.ts` → `runCiTestSuite`) runs only the `_test-suite.yml` *test* steps. These CI gates are **not** in the local pre-flight and ambush PRs: `audit:boundaries`, `audit:invariants`, `audit:release-please` (`_structure.yml`); `lint:markdown`, `audit:svg-assets`, `audit:readme-cli`, `audit:package-readmes` (`docs-quality.yml`); `audit:js-licenses` (`security.yml`); the `jscpd` duplication scan (`ci.yml`).
2. **Cross-platform misses.** Author develops on Windows; tests can pass locally + on the Ubuntu PR gate but fail on macOS/Windows matrix steps (e.g. path-separator assertions — cf. the `createWindowsPaths`/`join()` memory note, and #422's Windows/macOS `Expected: 1`).
3. **Infra/external flakes.** SonarQube Cloud analysis failed `exit code 3` and turned the main build red despite healthy code. (PRs skip Sonar — token-gated — so this is a main-branch concern.)
4. **Slow feedback + process discipline.** Failing jobs run 9–46 min, so failures surface late; and branch-hygiene gaps (a recent incident: 8 commits landed on a stale local `main` before being caught).

Gates already wired in `_test-suite.yml` / the existing local pre-flight: `typecheck`, `lint` (Biome), `audit:doc-refs`, `audit:openapi-drift`, `audit:coverage-floor`, `audit:exclusion-parity`, build, unit+coverage gates, integration, e2e. The manifest (Component 1) **includes** these by invoking their existing scripts — "don't duplicate" means reuse the existing script/command, never re-implement its logic. The point of `preflight` is to be the single complete superset, so nothing CI runs is omitted.

Note: `audit:dead-code` (knip) is **not** a CI gate today — excluded from the required pre-flight (YAGNI); may be a manual/optional command.

---

## Approach

Approach **B** (chosen): unified local pre-flight + guardrails. No matrix-on-every-PR (rejected approach C — fights the repo's deliberate Ubuntu-PR design and adds cost). Six components.

---

## Component 1 — Canonical gate manifest + `preflight` command

**Files:** `scripts/lib/preflight-gates.ts` (manifest), `scripts/preflight.ts` (runner), `package.json` (scripts), `scripts/preflight.test.ts` (drift test).

**Manifest** — one exported array, the single source of truth:

```ts
export type GateTier = "fast" | "full";
export interface Gate {
  name: string;        // human label
  cmd: string[];       // argv, run via Bun.spawn
  tier: GateTier;      // "fast" = cheap static; "full" = also in the heavy run
  soft?: boolean;      // true = report failure but don't fail the run (none by default locally)
}
export const PREFLIGHT_GATES: readonly Gate[] = [ /* … */ ];
```

**Fast tier** (cheap, static, ~2–3 min — the set that catches the gate-gap failures), in fail-fast cheap-first order:
`typecheck` → `lint` (biome) → `lint:markdown` → `audit:doc-refs` → `audit:openapi-drift` → `audit:boundaries` → `audit:invariants` → `audit:any` (`count-any-usage --check`) → `audit:release-please` → `audit:js-licenses` → `audit:svg-assets` → `audit:readme-cli` → `audit:package-readmes` → `audit:cross-platform` (Component 2) → `audit:duplication` (jscpd, same flags as `ci.yml`) → `audit:exclusion-parity`.

**Full tier** = fast tier **then** the heavy run: build all packages → `runCiTestSuite()` (unit+coverage gates + integration + e2e) → `audit:coverage-floor`.

**Runner** `scripts/preflight.ts`: `bun run preflight` (full) and `bun run preflight:fast` (fast tier only). Prints a per-gate ✓/✗ summary + total time; exits non-zero on the first hard failure (fail-fast) unless `--no-bail` is passed to see all failures. `--list` prints the manifest.

**Drift test** `scripts/preflight.test.ts`: parses `.github/workflows/*.yml`, extracts **every** `bun run <script>` and `bunx <tool>` invocation from `run:` blocks (not just `audit:*`/`lint:markdown`/`jscpd` — so a future gate named e.g. `bun run check:types` is caught regardless of naming), and asserts each is either in `PREFLIGHT_GATES` or in an explicit `CI_ONLY_GATES` allowlist for genuinely CI-only steps (Codecov upload, SonarQube, packaging, Trivy, CodeQL, perf benches, release-please publish). The allowlist is the deliberate record of "CI runs this but preflight intentionally doesn't"; adding a workflow gate without updating one of the two lists fails the test. This is what prevents local↔CI drift recurring. Runs as part of `bun test scripts`. (Review Q1.)

`package.json`: add `"preflight"`, `"preflight:fast"`, `"audit:cross-platform"`, `"hooks:install"`.

---

## Component 2 — Cross-platform static audit

**File:** `scripts/audit/check-cross-platform.ts` (script: `audit:cross-platform`).

Narrow, high-signal heuristic over `packages/**/*.test.ts(x)` (v1 scope = test files, where the proven failures live):

- Path-separator literals inside path **assertions**/expectations: a forward `"/"` or backslash `"\\"` in an `expect(...).toBe("…/…")` / `.toEqual` / `.toContain` where the value looks like a path, or string-built paths that should use `join()`.
- Hardcoded OS-absolute roots in tests: `/tmp`, `/home/`, `/Users/`, `C:\\`, `\\\\.\\pipe\\` outside a `PlatformServices`/`os.tmpdir()`/`process.platform` guard.
- (v1 keeps the rule list short and tuned to observed failures; broaden later only with evidence.)

Escape hatch: a trailing `// cross-platform-ok` comment on a flagged line suppresses it (tracked, greppable). Exit non-zero with `file:line` + reason on any unsuppressed hit.

Wired into: Component 1 fast tier, and a new step in `_test-suite.yml` (or `_structure.yml`) so CI enforces it too. Ships as a **hard** gate but deliberately narrow to avoid false-positive fatigue; if v1 proves noisy, the escape hatch + a follow-up tightening absorb it.

**v2 escalation (deferred — review S1):** regex parsing of TS is brittle (false positives inside template literals / nested objects). If v1 proves noisy in practice, reimplement the check as an **AST-based** rule via the TypeScript compiler API or a Biome plugin, which understands assertion context. This is *not* v1 — start regex-narrow + escape hatch, and move to AST only if evidence shows it is needed.

---

## Component 3 — Sonar / external soft-fail

**File:** `.github/workflows/_test-suite.yml` (the SonarQube Cloud analysis step).

Add `continue-on-error: true` to the SonarQube step so an external `exit 3` no longer fails the job. Confirm (and document) that SonarQube is **not** in the branch-protection required-checks set, so it can't block merges. Rationale: Sonar is advisory code-quality telemetry, not a correctness gate. No retry logic added (YAGNI) — soft-fail is sufficient. Scope: do not touch any code-correctness step.

**Note on visibility (review S3):** `continue-on-error` keeps the step *running* — it still uploads to the SonarCloud dashboard, so quality data is not lost, only un-blocked from the GitHub check. Guarding against soft-fail becoming silent neglect (e.g. a periodic team review or digest of SonarCloud metrics) is worthwhile but a separate **team-process** item, **out of scope** for this tooling change.

---

## Component 4 — Git guardrails (`.githooks/`)

**Files:** `.githooks/pre-commit`, `.githooks/pre-push`, `scripts/install-hooks.ts` (script: `hooks:install`).

- **`pre-commit`** (bash; Git for Windows ships bash): refuse a commit when the current branch is `main` or `develop` (`exit 1` with a message to branch first). Override: `NIMBUS_ALLOW_DEFAULT_BRANCH_COMMIT=1` for the rare intentional case. This directly prevents the stale-main incident class. Optionally also run Biome on staged files (fast).
- **`pre-push`** (bash): prints the `NIMBUS_SKIP_PREPUSH=1` override hint **up front** (discoverability — addresses the 2–3 min friction concern, review Q2), then runs `bun run preflight:fast` and aborts the push on failure. The hook is opt-in (only active after `hooks:install`), so the friction is self-chosen; the override covers emergency/trivial pushes.
- **`hooks:install`**: sets `git config core.hooksPath .githooks` (+ confirmation line). **Before writing**, it reads the current `core.hooksPath`; if already set to a non-`.githooks` value it **warns** that installing supersedes both that path and any manual `.git/hooks/` scripts, and requires `--force` to proceed (review S2). **Opt-in** (documented), not auto-run on `bun install` (less surprising; explicit). Cross-platform: hooks are POSIX-sh — works on macOS/Linux and Git-for-Windows bash.

---

## Component 5 — Docs (CLAUDE.md + GEMINI.md)

`CLAUDE.md` "Development Workflow" section:
- Replace "Pre-flight before pushing a PR: `bun run test:ci`" with **`bun run preflight`** (full CI parity) and **`bun run preflight:fast`** (cheap gates, ~2–3 min). State explicitly: *`test:ci` runs only the test suite — it is NOT the full gate set; `preflight` is.*
- Add a **Branch hygiene** rule: never commit on `main`/`develop`; verify `git branch` before committing; `bun run hooks:install` enforces it. (Applies to humans and AI sessions alike.)
- Add a one-line **cross-platform footgun** note (use `join()` / `os.tmpdir()`; `audit:cross-platform` enforces it) pointing at the new skill.

Mirror the command/workflow changes into `GEMINI.md` (the doc's own rule: keep both in sync for command changes).

---

## Component 6 — `nimbus-preflight` skill

**File:** `.claude/commands/nimbus-preflight.md` (+ add to the `CLAUDE.md` skill-reference list and the `GEMINI.md` mirror).

Documents: the gate manifest + two tiers; when to run `:fast` vs full; the cross-platform rules + `// cross-platform-ok` escape hatch; the drift test; the hook install + the branch-guard override env vars; the explicit reminder that `test:ci` ≠ `preflight`. Frontmatter `description` tuned so it triggers on "why did my PR fail", "what should I run before pushing", "pre-flight", "preflight", "CI gate".

---

## Out of scope (YAGNI)

- Matrix-on-every-PR / CI job restructuring (approach C).
- `audit:dead-code` (knip) as a required gate (not CI-gated today).
- Auto-installing hooks on `bun install`.
- Sonar retry logic (soft-fail is enough).
- Broad cross-platform linting beyond test-file path assertions in v1.

## Definition of done

1. `bun run preflight:fast` and `bun run preflight` run the manifests and exit non-zero on failure; `--list` works.
2. `scripts/preflight.test.ts` passes and **fails** if any workflow `bun run <script>` / `bunx <tool>` gate is missing from **both** the manifest and the `CI_ONLY_GATES` allowlist.
3. `audit:cross-platform` flags a seeded path-separator assertion and is silenced by `// cross-platform-ok`.
4. SonarQube step is `continue-on-error: true`; documented as non-required.
5. `hooks:install` sets `core.hooksPath`; `pre-commit` blocks a commit on `main`; `pre-push` runs `preflight:fast` and prints the skip-override hint; `hooks:install` warns + requires `--force` when `core.hooksPath` is already set to a non-`.githooks` value.
6. CLAUDE.md + GEMINI.md updated (preflight command, branch hygiene, cross-platform note, skill ref); new `nimbus-preflight` skill present.
7. The whole change passes `bun run preflight` itself (dogfood).
