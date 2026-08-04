# Closing the local-vs-CI feedback gap

- **Date:** 2026-08-04
- **Branch:** `dev/asaf/ci-feedback-loop`
- **Status:** design approved, plan pending
- **Touches:** `biome.json`, `scripts/ci/`, `scripts/lib/preflight-gates.ts`, `packages/*/tsconfig.tests.json`, `docs/structure-audit/`, `package.json`

---

## 1. Problem

PR #1038 took five CI round-trips. None were flakiness; each had a specific, nameable cause, and
four of the five share one shape:

> **A local gate that cannot see what CI sees, while appearing to have run.**

| # | What reached CI | Why the local gate missed it |
|---|---|---|
| 1 | 5 `ToolExecutor` call sites passing 3 args to a 5-arg constructor | No tsconfig covers `packages/*/test/**`. `bun run typecheck` exits 0 with the directory entirely unread. |
| 2 | Reflowed `biome-ignore` comments + a stale `biome.json` `$schema` | `bun run lint` reports **"0 files processed"** and exits 1 inside `.claude/worktrees/**`. Being unrunnable, it got routed around — and the substitute invocation omitted `--error-on-warnings`. |
| 3 | `audit:any` regression | The gate is `bun run audit:any --check`. Retyped from memory without `--check`, which **always exits 0**. |
| 4 | A "green" check set that was the *absence* of CI | The PR was `CONFLICTING`; a conflicting PR runs no `pull_request` workflows at all. 4 checks ran, all passed, nothing was verified. |
| 5 | Sonar `new_reliability_rating` 4 (two bare `.sort()`) | Cloud-only gate; no local equivalent exists. |

### 1.1 What is already good — and is not the problem

Worth stating, because the obvious reflex is "add a gate list" and that would be redundant:

- `scripts/lib/preflight-gates.ts` holds **28 gates** with `fast`/`full` tiers and `cmd` as an argv array.
- `CI_ONLY_GATES` is an explicit exclusion list where **every entry carries a written reason**
  (network-dependent, packaging-only, needs `gh` org auth, and so on).
- `scripts/preflight.test.ts` contains a real drift guard: *"every workflow `bun run`/`bunx` gate is
  in the manifest or `CI_ONLY_GATES"`*, scanning `.github/workflows/*.yml`.

The manifest is trustworthy and enforced. **Every failure above came from not using it, or from a
tool that ran and reported nothing.** The fixes therefore target runnability and honesty, not coverage.

### 1.2 Measurements taken while designing (not estimates)

- `biome.json` `files.includes` contains `"!**/.claude"`. That pattern matches a `.claude` segment at
  **any depth**, so a worktree at `.claude/worktrees/<branch>/` excludes itself. Changing it to
  `"!.claude"` makes biome check **3162 files with zero warnings**, up from **0 files / exit 1**.
  The intermediate form `"!.claude/**"` also works but trips biome's own
  `lint/suspicious/useBiomeIgnoreFolder`; `"!.claude"` is the form biome prefers.
- **Three** packages have a `test/` directory outside `src`: `gateway` (246 `.ts` files), `ui` (30),
  `cli` (22). `mcp-connectors` has none (94 per-connector tsconfigs, no package-level `test/`).
  All three package tsconfigs are `include: ["src/**/*"]`, so every one of those directories is
  currently unchecked.
- Typechecking each `test/**` at that package's existing `src` strictness:

  | Package | Errors | Files | Notes |
  |---|---|---|---|
  | `gateway` | **404** | 100 | `TS4111` ×183, `TS2532` ×57, `TS2739` ×41, `TS2314` ×37, `TS2741` ×31, … |
  | `ui` | **68** | 14 | |
  | `cli` | **0** | 0 | **already clean — needs no baseline at all** |

  Total debt: 472 errors across 114 files, all of it in two packages.
- For `gateway`, relaxing `noPropertyAccessFromIndexSignature`, `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes` drops it to **157 errors across 65 files** — still far too many to
  gate on directly, which is why the relaxed-strictness option was rejected in §2.

---

## 2. Decisions

| Question | Decision | Rationale |
|---|---|---|
| Fix the environment, or add a Docker runner? | **Both** | The env fix removes the reason people abandon `preflight`; Docker adds Linux parity the env fix cannot. |
| How to make test-dir typecheck real given 404 errors? | **Baseline + ratchet at full `src` strictness** | Zero upfront cleanup, new errors fail immediately, debt is visible and shrinks. Two strictness regimes were rejected: tests would get weaker guarantees than the code they exercise. |
| Cover cloud-side failures (conflict suppression, pending, Sonar)? | **Yes — a `verify:pr` post-push check** | The conflict trap is invisible locally and is already documented in team memory; documentation lost to habit and it still cost a cycle. |

### 2.1 Non-goals

- A local Sonar equivalent. It stays a post-push discovery.
- Making `audit:advisories` deterministic. It is time-dependent by nature (new advisories land against
  unchanged dependencies) and is correctly in `CI_ONLY_GATES`.
- Fixing the 404 pre-existing test-dir type errors. They are grandfathered, not resolved.
- Replacing `preflight.ts` or the drift guard. Both work; they are reused.

---

## 3. Design

### 3.1 `biome.json` — one line

```diff
-      "!**/.claude",
+      "!.claude",
```

This is the highest-value change in the whole spec and costs one line. `bun run lint` — and therefore
`bun run preflight:fast`, and therefore `bun run test:ci`, which invokes `lint` before the suite —
becomes runnable from inside a worktree.

**Why the false-fail was worse than a false pass:** a gate that fails for an environmental reason
trains everyone to skip the aggregate command that contains it. The loss is not one gate, it is all
the gates after it, because `preflight` fail-fasts. In #1038 that cost `lint` entirely.

### 3.2 `scripts/ci/verify-in-docker.sh`

Modelled on `scripts/coverage-floor/reseed-docker.sh`, which already solves every environmental
problem here and documents why:

- `MSYS_NO_PATHCONV=1` / `MSYS2_ARG_CONV_EXCL='*'` — Git Bash rewrites container paths otherwise.
- **Stream the tree in (tar), never bind-mount.** `reseed-docker.sh` records that `-v repo:/w`
  produced garbage results; the same applies here.
- `oven/bun:1.3` — the version CI pins.
- A named cache volume for `bun install`, so the cost is paid once.

Behaviour:

- Imports `PREFLIGHT_GATES` and runs each gate's `cmd` **array verbatim**. Nothing is retyped —
  that is what lost `--check` on `audit:any`.
- Takes a tier (`fast` | `full`).
- Skips gates named in `CI_ONLY_GATES` and **prints them as skipped**, so the summary never implies
  coverage it does not have.
- Exits non-zero if any gate fails; prints a per-gate pass/fail table.

The checkout lives at `/src`, a normal path, so no path-exclusion bug of the §3.1 class can recur —
including ones not yet discovered in other tools.

### 3.3 `typecheck:tests` — new gate with a baseline ratchet

**Scope.** Only the three packages with a `test/` directory: `gateway`, `ui`, `cli`.

**`cli` needs no baseline.** Its `test/**` typechecks clean today (0 errors), so it gets the
directory added to its existing `tsconfig.json` `include` and is gated outright — no grandfathered
debt, no ratchet. Do this first: it is a pure win and proves the gate mechanism against a clean
package before the baseline machinery is involved.

**Config for `gateway` and `ui`.** `packages/<pkg>/tsconfig.tests.json` extends the package's
existing tsconfig and sets `include: ["src/**/*", "test/**/*"]`. Same strictness as `src` — no second
regime.

**Baseline.** `docs/structure-audit/typecheck-tests-baseline.json`, keyed:

```text
(file, TS error code) -> count
```

**Line numbers are deliberately not part of the key.** They shift on every edit, and a line-keyed
baseline would emit phantom regressions on unrelated changes, which is how a ratchet loses trust and
gets regenerated blindly.

**Rules** (mirroring `coverage-floor`):

| Situation | Result |
|---|---|
| Count for a known `(file, code)` increases | **fail** — regression |
| A file not in the baseline has any error | **fail** — new debt |
| Count decreases | ratchet down; baseline updated on `--update-baseline` |
| Count unchanged | pass |

**Stated limitation:** fixing one `TS2554` while introducing another in the same file nets zero and
passes. This is the same per-file granularity trade-off `coverage-floor` already makes, accepted for
the same reason — a finer key is not stable enough to gate on.

**Would it have caught #1038?** Yes, by either rule. The five broken sites were `TS2554` in
`packages/gateway/test/e2e/` and `test/integration/`. A file already in the baseline gains a new
`(file, TS2554)` key → fail on the new-key rule; a file not in the baseline gains its first error →
fail on the new-file rule. There is no path where a fresh arity error passes.

### 3.4 `verify:pr` — post-push honesty check

`bun run verify:pr [<pr-number>]`. Reads `gh pr view --json mergeable,mergeStateStatus` and
`gh pr checks`. Reports NOT GREEN, in priority order:

1. **`mergeable === "CONFLICTING"`** — states explicitly that `pull_request` workflows are
   *suppressed* and that any passing checks are not real coverage. This is the trap that produced a
   false-confident green in #1038.
2. Any check with conclusion `failure`.
3. Any required check still `pending` — "not yet failed" is not "passed".

Missing `gh` auth is a hard **error**, never a silent skip: "could not check" must not render as green.

It is a reporting tool, not a manifest gate — it needs network and `gh` auth, exactly the properties
`CI_ONLY_GATES` documents as disqualifying. It is therefore **not** added to `PREFLIGHT_GATES`.

### 3.5 Cross-cutting: zero work is a failure

Any gate that reports zero units of work — 0 files linted, 0 tests run, 0 modules cruised — fails.

Three separate incidents in #1038 trace to a tool that ran, did nothing, and said so quietly:
biome's "0 files processed", `audit:any` without `--check` exiting 0 unconditionally, and a
markdownlint output that reads as a no-op ("0 issues in 0 files") but is actually a pass. That last
one caused two people — me and a subagent — to misreport a working gate as broken, which is the
mirror-image error and equally costly.

Both runners enforce this. Where a tool cannot report its unit count, the wrapper asserts a non-zero
count itself.

---

## 4. Testing

| Layer | Coverage |
|---|---|
| Unit — baseline diff | regression (count up), new-file, ratchet-down, unchanged — as pure functions over fixtures, not by invoking `tsc` |
| Unit — gate selection | `CI_ONLY_GATES` are skipped and reported; every other manifest gate runs; `cmd` arrays are passed through unmodified |
| Unit — `verify:pr` parsing | CONFLICTING, failing check, pending check, and the all-clear case, over recorded `gh` JSON fixtures |
| Red-prove — zero-work rule | a gate reporting 0 files must FAIL; watched failing before being trusted |
| Red-prove — `typecheck:tests` | reproduce #1038: remove an argument from a `ToolExecutor` call in `packages/gateway/test/**` and confirm the gate fails with `TS2554`, then restore |
| Integration — Docker runner | a full `fast`-tier run completes and reports a per-gate table; a deliberately failing gate produces a non-zero exit |

The two red-proves are the ones that matter. This repo has a history of guards that pass because they
match the wrong thing; a gate nobody has watched fail is not yet a gate.

---

## 5. Delivery

Dependency-ordered; each step is independently useful and separately shippable.

| # | Change | Why this order |
|---|---|---|
| 1 | `biome.json` one-liner | Unblocks `preflight`, `test:ci` and every later verification. Highest value per byte in this spec. |
| 2a | `cli` `test/**` added to its tsconfig `include` + manifest entry | Zero debt (measured 0 errors), so it gates outright and proves the mechanism before any baseline machinery exists. |
| 2b | `gateway` + `ui` `tsconfig.tests.json` + baseline ratchet | Highest defect-catching value (404 + 68 grandfathered); independent of the runners. |
| 3 | `scripts/ci/verify-in-docker.sh` | Builds on a manifest run that now actually works. |
| 4 | `verify:pr` | Standalone and smallest. |

Step 1 should not wait for the others.

---

## 6. What this does not fix

Named so the tooling is not mistaken for a complete loop:

1. **Sonar.** No local equivalent; remains a post-push discovery. `verify:pr` reports it after the
   fact, which is a shorter loop than waiting for a human to notice, but not prevention.
2. **`audit:advisories`.** Time-dependent by construction — a new advisory turns an untouched
   dependency tree red overnight. Correctly `CI_ONLY`.
3. **CodeRabbit findings.** A reviewer, not a gate. In #1038 it found real defects that seven task
   reviews and a whole-branch review missed; nothing here replaces that.
4. **Process documents reviewed as contract.** Committing plan/spec artifacts alongside code made
   every push generate fresh consistency findings that could not converge. The fix is not tooling —
   it is not committing delivered process artifacts. Recorded here because it cost more review
   cycles in #1038 than any code defect.

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| The baseline gets regenerated blindly, hiding real regressions | `--update-baseline` is a separate explicit command, never part of the gate; the plan requires diffing the baseline in review, as `coverage-floor` already does |
| Docker runner drifts from CI's bun version | Pin `oven/bun:1.3` to match `setup-nimbus-ci`; the existing gate-drift guard keeps the gate list aligned |
| `verify:pr` gives false comfort when `gh` is unauthenticated | Missing auth is a hard error, never a skip |
| Fixing `biome.json` surfaces previously-hidden lint errors repo-wide | Measured: **3162 files, zero warnings** on current `main`. No hidden backlog. |
| The one-line biome fix is reverted by someone "tidying" globs | The plan adds a comment in `biome.json` stating why the pattern is anchored, and the worktree case it protects |
