# CI: why PR checks fail so often, and where the 14 minutes go

**Status:** analysis, 2026-08-21. **Nothing in §4 has been applied** — pipeline changes were
explicitly deferred. §3 (local loop) HAS been applied and is described as shipped.

Companion to [`2026-08-21-ci-critical-path-design.md`](./2026-08-21-ci-critical-path-design.md),
which measured *duration* on a single run. This one measures **reliability** across 152 runs and
re-measures duration after #1291 landed.

**Sample:** the last 152 `ci.yml` runs with `event == pull_request`, plus the last 10 on
`main` pushes. Read on 2026-08-21.

---

## 1. The headline numbers

| | |
|---|---|
| PR runs sampled | **152** |
| — succeeded | 66 |
| — failed | 18 |
| — **cancelled (superseded by a newer push)** | **68 — 45%** |
| Failure rate over *concluded* runs | **21.4%** (18 / 84) |
| `main` push runs failing | **5 of 10** |
| PR wall time, successful runs | **p50 14.1 min · p90 18.4 min** |
| Checks reported on one PR (#1301) | **56** — of which **10** are required contexts |

Three separate problems live in that table, and they have different fixes:

1. **21% of concluded PR runs fail** — §2.
2. **45% of runs are thrown away** by a newer push. That is the push-and-see loop; it is a
   symptom of (1), not an independent problem.
3. **56 checks, 10 required.** The noise is real but it is mostly *not* the thing failing — §4.3.

---

## 2. What actually fails

Failing **jobs** across the 18 failed runs (`PR quality — required gates` appears 18/18 because
it is the aggregator — it carries no information):

| Job | n |
|---|---:|
| TS/Bun → **Unit + Coverage** (ubuntu) | **10** |
| Structure audit | 5 |
| Cross-platform (gateway, windows-2025) | 5 |
| Cross-platform (gateway, macos-15) | 5 |
| Release safety | 4 |
| everything else | ≤ 2 each |

Failing **steps** — the actionable cut:

| Failing step | n | Catchable before push? |
|---|---:|---|
| Unit tests (with coverage) — Linux | 6 | only in a Linux container |
| Coverage floor — per-file 85 / 80 | 3 | `audit:coverage-floor` (Docker) |
| Audit root overrides drift | 3 | **yes — `preflight:fast`, ~2 min** |
| Setup Bun and install dependencies (lockfile drift) | 2 | **yes — `preflight:fast`** |
| Audit release-please manifest drift | 1 | **yes — `preflight:fast`** |

### 2.1 The finding that matters most

**6 of the 15 identified step failures — 40% — are gates that already run locally in 2–3
minutes.** They are not hard problems, subtle races, or platform quirks. They are static audits
that nobody ran.

The repo ships the fix and has since before this sample: `.githooks/pre-push` runs
`preflight:fast` and aborts the push on failure. **It was not installed** —
`git config core.hooksPath` was unset on the maintainer's machine, so `.git/hooks/` held nothing
but GitHub's samples. `bun run hooks:install` was run on 2026-08-21.

That single config line makes the override-drift, lockfile and release-please failures
**impossible to push**, which retires 6 of 15.

### 2.2 The remaining real category

"Unit tests (with coverage) — Linux" (6) is the largest genuine category and the hardest: these
failures **do not reproduce on Windows or macOS at all**. Before this session the only way to see
one was to push and wait ~12 minutes — which is precisely the loop that produces the 45%
cancellation rate. Addressed in §3.

### 2.3 A separate cause, not visible in this table

A large share of red `main` is not a gate escape at all: **PRs merged while the required gate was
still pending.** #1298 merged at 17:47:15Z; its `PR quality — required gates` check was created at
17:57:44Z and failed. The ruleset's only bypass actor is `OrganizationAdmin` with
`bypass_mode: "always"`, and using it leaves no annotation, so this is indistinguishable from a
post-merge regression without comparing timestamps. See `CLAUDE.md` § Development Workflow.

---

## 3. The local loop — shipped this session

| Change | Effect |
|---|---|
| `bun run hooks:install` (config only) | pre-push `preflight:fast`; retires 6 of 15 step failures |
| **`bun run verify:docker --changed`** (new) | runs the branch's changed test files + colocated siblings in the CI Linux image, in seconds once cached. Targets §2.2 — the category that previously required a push |
| `audit:platform-test-gaps` (new, `soft`, in `preflight:fast`) | names tests in the diff that cannot run on your OS. `win32.test.ts` has 4 such tests on a Windows box |
| `verify:pr` now fails on an **absent** required gate | the #1298 shape previously read as green |

**Stated bound, enforced in the tool's own output:** `--changed` cannot reproduce `mock.module`
contamination, which is a cross-file effect visible only in the combined `bun test
packages/cli/src` run. A green `--changed` is evidence about those files, never about the suite.
`--full` remains the authority.

---

## 4. Duration — where the 14 minutes go now

### 4.1 The critical path flipped

PR #1291 (P1 + P2 of the companion spec) worked, and inverted its central finding:

| Job | run 32452626344 | run 32509283449 | Δ |
|---|---:|---:|---|
| Cross-platform (gateway, windows-2025) | 30m35s | **8m42s** | −22m |
| TS/Bun → **Unit + Coverage** (ubuntu) | 12m21s | **11m42s** | −39s |

**`Unit + Coverage` is now the longest job, and 13 jobs `needs:` it.** Its internals:

```text
Unit tests (with coverage) — Linux    7.4m
SonarQube Cloud analysis              1.9m   ← in series with 13 downstream jobs
UI unit coverage                      1.0m
setup + libsecret/D-Bus + upload      1.4m
```

### 4.2 Re-ranked proposals (none applied)

| # | Proposal | Saving | Risk |
|---|---|---:|---|
| **P4** | Split SonarQube into its own job consuming the uploaded lcov artifact. Gate stays blocking, stops being in series. | ~1.9 min off the critical path; 13 jobs start ~2 min earlier | Low |
| **P5** | Delete the 13 no-op `Coverage — <scope>` jobs (§4.3); keep the Sandbox leg for cppcheck | 56 → ~43 checks; ~16 min runner time | **Medium — see the hidden cost** |
| **P6** | Batch the 95-invocation connector loop (2m31s wall for 97.5s of tests; the rest is Bun startup × 95) | ~45 s | Low |
| **P3** | Windows `node_modules` cache probe | ~3m20s on a job that is **no longer the critical path** | High — demoted |

**P5's hidden cost, not priced in the companion spec:**
`scripts/structure-audit/check-coverage-gate-pal.ts` has **six rules** asserting the structure of
`coverage-gates-pal` / `coverage-gates-linux`, over 24 matrix entries each carrying an explicit
`pal:` field. Deleting those jobs means rewriting that audit in the same PR. P5 is a refactor,
not a trim. Its rules 5 and 6 exist because an earlier revision validated the `pal:` fields
without reading the `if:` lines that consume them — so this is a file that has already shipped
one silent-no-op bug and deserves care.

### 4.3 The 13 coverage jobs enforce nothing — re-verified

Independently re-confirmed on Bun 1.3.14, this checkout:

```text
$ bun test packages/gateway/src/agents/_lib/markdown-sections.test.ts \
    --coverage --coverage-threshold-lines=99.9
EXIT=0
```

An impossible threshold exits 0. Two causes, both already documented in `CLAUDE.md`:
`--coverage-threshold-lines` is not a Bun flag and unknown flags are ignored silently, and
`bunfig.toml` sets `[test] coverage = false`, which suppresses collection outright. The floors are
really enforced by `audit:coverage-scopes` over the merged lcov — a sub-second step inside
`unit-coverage`.

So those 13 jobs re-run subsets of a suite that already ran, assert nothing, and upload a Codecov
flag for coverage that was never collected. **Caveat that blocks a blanket deletion:** the
`coverage-gates-pal` **Sandbox** leg also builds the sandbox helper and runs `cppcheck
--error-exitcode=1`, which nothing else in CI does.

---

## 5. Recommended order

1. **Done.** Install the hook; ship `--changed`. Retires 40% of failures and collapses the
   reproduction loop for most of the rest. Cheapest, largest, zero pipeline risk.
2. **P4** — one workflow file, low risk, hits the new critical path.
3. **P6** — small, safe, only if someone is already in that file.
4. **P5** — schedule as a real refactor with the `check-coverage-gate-pal.ts` rewrite in scope.
   Do not attempt it as a quick cleanup.
5. **P3** — reconsider only if Windows becomes the critical path again.

Re-measure after each. `gh run view <id> --json jobs` job spans, same method as §4.1.

## 6. What this document does not claim

- **The failure taxonomy is 15 of 18 runs**, not all 18: three runs' failing steps did not
  resolve to a named step (setup-level or cancelled-child failures). The proportions are stable
  enough to act on; the absolute counts are a floor.
- **"Locally catchable" means the gate exists and passes locally**, not that it would have caught
  that specific diff. It is a strong inference from the gate's determinism, not a replay.
- **One measurement per duration figure.** §4.1 is two runs, not a distribution. The whole-run
  p50/p90 in §1 *is* a distribution (n=66); the per-job and per-step numbers are not.
- **The 45% cancellation rate is not decomposed.** Some of it is healthy (rapid iteration on a
  draft PR); some is push-and-see. This document does not separate them.
