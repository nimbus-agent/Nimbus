# CI critical path — where the 31 minutes actually go

**Status:** design, 2026-08-21. Measured against run
[`32452626344`](https://github.com/nimbus-agent/Nimbus/actions/runs/32452626344) (PR #1285,
`dev/asafgolombek/clip-source-metadata-impl`), which took **31m11s** end to end.

**Branching:** this spec lands with the S1→S2 docs sweep on
`dev/asafgolombek/docs-ci-sweep`. Every workflow change it proposes belongs on a **separate
branch**, so a red CI experiment never blocks a docs merge.

**Scope note:** this is a measurement document with proposals attached, not an implementation
plan.

---

> ## ⚠ Re-measured 2026-08-21 (later the same day): §1's headline is now INVERTED
>
> **P1 and P2 shipped in #1291 and worked.** Re-measured on run
> [`32509283449`](https://github.com/nimbus-agent/Nimbus/actions/runs/32509283449), a green PR run:
>
> | Job | Was (run 32452626344) | Now | Δ |
> |---|---:|---:|---|
> | Cross-platform (gateway, **windows-2025**) | 30m35s | **8m42s** | −22m |
> | TS/Bun → **Unit + Coverage** (ubuntu) | 12m21s | **11m42s** | −39s |
>
> **Windows is no longer the critical path — `Unit + Coverage` is.** §1's "the obvious suspect is
> the wrong one" was true when written and is now false. Do not start from it.
>
> Whole-run distribution over the last 152 PR runs of `ci.yml`: **p50 14.1 min, p90 18.4 min**
> (n=66 successful).
>
> **This re-ranks the remaining proposals.** P4, P5 and P6 all target `Unit + Coverage` — they
> were ranked 3rd, 4th and 6th *because* Windows dominated. They are now the whole game, and P3
> (the Windows `node_modules` cache probe, ~3m20s of a job that is no longer the critical path)
> drops to last. Current internal breakdown of the 11m42s:
>
> ```text
> Unit tests (with coverage) — Linux    7.4m   ← P6 lives inside this
> SonarQube Cloud analysis              1.9m   ← P4: 13 jobs `needs:` this job and wait it out
> UI unit coverage                      1.0m
> setup + libsecret/D-Bus + upload      1.4m
> ```
>
> **P5's premise re-verified independently on Bun 1.3.14:** `bun test <file> --coverage
> --coverage-threshold-lines=99.9` exits **0**, and `bunfig.toml` still sets `[test] coverage =
> false`. The 13 `Coverage — <scope>` jobs enforce nothing. Note the cost P5 did not price:
> `scripts/structure-audit/check-coverage-gate-pal.ts` has **six rules** asserting the structure
> of `coverage-gates-pal` / `coverage-gates-linux` and 24 matrix entries carrying `pal:` fields,
> so deleting those jobs means rewriting that audit in the same PR. P5 is a refactor, not a trim.
>
> **Separately — the reliability half, which this document does not address at all.** Over the
> same 152 runs: 18 failures, 66 successes, **68 cancelled** (45% of runs are superseded by a
> newer push). Failing-step frequency across those 18 failures:
>
> | Failing step | n | Locally catchable? |
> |---|---:|---|
> | Unit tests (with coverage) — Linux | 6 | only via `verify:docker` |
> | Coverage floor — per-file 85/80 | 3 | via `audit:coverage-floor` (Docker) |
> | Audit root overrides drift | 3 | **yes — `preflight:fast`** |
> | Setup Bun and install dependencies (lockfile) | 2 | **yes — `preflight:fast`** |
> | Audit release-please manifest drift | 1 | **yes — `preflight:fast`** |
>
> **6 of 15 identified step failures (40%) are gates `preflight:fast` runs locally in 2–3 min.**
> The repo ships a pre-push hook that runs exactly that (`.githooks/pre-push`) and it was **not
> installed** on the maintainer's machine (`core.hooksPath` unset) — installed 2026-08-21.
>
> **And the check count itself:** PR #1301 reports **56 checks**, 35 from `ci.yml`. Exactly one
> (`PR quality — required gates`) plus the 6 Security, 2 CodeQL and `cla` contexts are required.
> ~46 of 56 are non-gating, and 13 of those are the verified no-ops above.

---

## 1. The headline: `Unit + Coverage` is not the critical path

The obvious suspect — `PR quality — TS/Bun (ubuntu-24.04) / Unit + Coverage` at 12m21s — is the
*second*-longest job. The run is set by Windows.

| Job | Wall | Note |
|---|---|---|
| **Cross-platform (gateway, windows-2025)** | **30m35s** | sets the run duration |
| TS/Bun → Unit + Coverage (ubuntu-24.04) | 12m21s | 13 jobs wait on it |
| Cross-platform (gateway, macos-15) | 3m35s | |
| Structure audit / Duplication scan / Release safety | ≤ 1m | |
| TS/Bun → Static, Integration, E2E CLI, E2E Gateway, Packaging | ≤ 1m45s each | run in parallel |
| 13 × `Coverage — <scope>` | ~50s each | queued behind Unit + Coverage; start at 12m40s |

Anything done to the Ubuntu side is invisible to PR authors until Windows stops setting the
duration. That ordering drives the priorities below.

---

## 2. Windows, in detail

```text
Setup Bun and install dependencies   06:00:31 → 06:04:22   3m51s
Typecheck                            06:04:22 → 06:04:59     37s
gateway unit tests (retry once)      06:04:59 → 06:30:34  25m35s
```

### 2.1 The suite ran twice, and the retry hid a failure

```text
Ran 11806 tests across 831 files. [882.41s]
Attempt 1 failed (exit 1), retrying in 5 s...
Ran 11806 tests across 831 files. [646.58s]     ← passed
```

One test failed on attempt 1:

```text
packages\gateway\src\briefs\brief-e2e.test.ts
(fail) leak check: the bearer token, the fed source body, and its URL
       never appear in any response or audit row [60006.53ms]
  ^ this test timed out after 60000ms.
```

**The retry wrapper is working exactly as designed and that is the problem.** It exists to absorb
cold-runner outliers, and its exit-code propagation is correct (attempt 2's code is the job's
code, so two genuine failures still fail). But a single flaky test costs the **full suite runtime
again** — here, ~11 extra minutes — and the job still reports green, so nobody investigates.

**This is not event-loop starvation.** The overshoot is 6.53 ms: the harness timer fired on
schedule, which means the loop stayed responsive and the test was simply not finished. A blocked
loop fires its own timer late.

The test's budget is bounded and runner-speed-dependent:

```ts
for (let i = 0; i < 200; i++) {
  const body = await captureJson<GetOk>(await fetch(`${base}/v1/briefs/${created.id}`, …), 200);
  if (body.status === "done" || body.status === "failed") { done = body; break; }
  await new Promise((r) => setTimeout(r, 5));
}
```

200 iterations × (5 ms + one loopback HTTP round trip). At ~300 ms per round trip on a loaded
`windows-2025` runner, the loop alone reaches 60 s **before** exhausting its 200 iterations — so
it dies on the harness timeout rather than on its own `must(done, …)` message, which is why the
failure reads as a mystery instead of "the run never went terminal".

Corroborating numbers from the same run: `brief-e2e.test.ts` took **116.8 s** on attempt 1 and
**42.0 s** on attempt 2 — same commit, same runner, 2.8× apart. Locally the entire file passes in
**1.95 s**.

**Proposal (P1).** Two changes, both cheap:

1. Replace the iteration budget with a **wall-clock deadline** in `pollUntilTerminal` and in the
   leak-check test's inline copy, and raise the sleep from 5 ms to ~25 ms. A slow runner then
   spends its budget on fewer, cheaper polls, and a genuine stall fails with a descriptive error
   well inside the 60 s harness timeout instead of hitting it.
2. Make the retry **visible**: when attempt 1 fails, emit a `::warning::` naming the failing test
   and append it to the job summary. A retry that costs 11 minutes should not be silent.

Explicitly **not** proposed: removing the retry. It absorbs real cold-runner variance, and
deleting it would convert this flake into a red PR rather than a slow one.

### 2.2 Six files out of 831 are three-quarters of the Windows suite

Summing both attempts' group spans (1534.2 s total):

| Test file | Attempt 1 | Attempt 2 | Sum |
|---|---:|---:|---:|
| `ipc/diagnostics-rpc.test.ts` | 237.2 s | 210.5 s | **447.7 s** |
| `platform/assemble.test.ts` | 138.0 s | 93.9 s | 231.9 s |
| `briefs/brief-e2e.test.ts` | 116.8 s | 42.0 s | 158.8 s |
| `agent-runs/agent-http-e2e.test.ts` | 83.7 s | 55.0 s | 138.7 s |
| `briefs/brief-http.test.ts` | 73.0 s | 22.2 s | 95.2 s |
| `embedding/lazy-scheduler.test.ts` | 33.4 s | 23.4 s | 56.8 s |
| **Top 6 of 831 files** | | | **1129.1 s — 74%** |

Inside the worst file, the cost is concentrated and **new**: the 22 `index.queryItems` tests added
by W6-B.1 (#1277, merged 2026-08-20 — the day before this run) total **154.3 s**, mean **7.02 s**
each, with individual tests at 8–13 s:

```text
(pass) index.queryItems > a present-but-unusable negation param is rejected; null still reads as absent [12727.71ms]
(pass) index.queryItems > a padded notTouching glob is trimmed before use, never matched verbatim [11508.68ms]
(pass) index.queryItems > a whitespace-only notTouching is rejected the same way [11436.62ms]
```

**These tests are not badly written.** The same 22 run locally in **8.66 s** — an **18× runner
gap**. Each builds a fresh `mkdtempSync` directory and calls `LocalIndex.ensureSchema`, which
replays all 55 migrations; `ensureSchema` alone measures **207 ms** on a dev machine. The pattern
is idiomatic for this repo and matches `premortem/cohort.test-helpers.ts`. What is expensive is
doing it thousands of times on a runner that is very slow at temp-directory SQLite churn.

**Proposal (P2).** Build the migrated schema **once per file**, then copy the file per test:
run `ensureSchema` into a template `.db` in a `beforeAll`, and have `makeCtxWithIndex` `copyFileSync`
that template instead of re-migrating. This keeps every test's fresh-database isolation — the
property the current pattern is buying — while paying the migration cost once. Applied to the six
files above it targets the bulk of the 74%.

The alternative, sharing one `Database` across tests with per-test truncation, is **rejected**:
it trades a real isolation guarantee for speed, and this suite's whole value is that a test cannot
see another test's rows.

### 2.3 `bun install` costs 3m51s on Windows and 34s on Linux

`.github/actions/setup-nimbus-ci/action.yml` skips the `node_modules` cache on Windows, with a
well-documented reason: Bun's monorepo layout relies on NT junctions that the cache action's
tar pack/restore does not preserve, and a restored tree yields `EPERM` reads plus stripped-down
ambient `@types/bun` declarations that fail `bun run typecheck`. `bun install --frozen-lockfile`
will not repair a tree it considers installed.

**Proposal (P3), lowest confidence of the six.** Probe whether `actions/cache` with an explicit
`enableCrossOsArchive: false` and a tar that follows junctions (`--dereference`) restores a usable
tree, on a throwaway branch, gated on `bun run typecheck` passing afterwards. If it does not, close
the row and record the negative result in the action's comment so the next person does not
re-litigate it. **Do not** ship a Windows `node_modules` cache without a green typecheck on the
restored tree — that is precisely the failure the current comment describes.

---

## 3. Ubuntu: `Unit + Coverage`, 12m21s

| Segment | Time |
|---|---:|
| Set up job → install deps | 49 s |
| Diagnostic + libsecret/D-Bus | 41 s |
| `packages/gateway` tests | **3m46s** (225.20 s; 14540 tests / 1067 files) |
| `packages/cli` tests | 27 s (26.10 s; 2459 tests / 140 files) |
| 95 × connector / github-actions package loops | **2m31s** (97.5 s of tests) |
| `merge-coverage.ts` + `bun test scripts` | 56 s |
| UI vitest coverage | 1m01s |
| Coverage floor + scopes + exclusion parity | < 1 s |
| Upload artifact + Codecov | 7 s |
| **SonarQube Cloud analysis** | **1m59s** |
| JUnit report + teardown | 3 s |

### 3.1 SonarCloud sits inside the job 13 other jobs wait on

Sonar runs at 06:10:32 → 06:12:31, *after* the coverage artifact is already uploaded at 06:10:27.
It needs `coverage/lcov.info` and the checkout; it does not need to be in this job. Because
`coverage-gates-linux` and `coverage-gates-pal` both declare `needs: unit-coverage`, all 13 of them
wait out those two minutes before they start.

**Proposal (P4).** Split SonarCloud into its own job consuming the uploaded
`coverage/lcov.info` artifact, with `needs: unit-coverage`. The quality gate stays blocking — it
just stops being in series with everything downstream. Saves ~2 minutes on the Ubuntu branch of
the DAG and returns a job slot to the pool.

### 3.2 The 13 `Coverage — <scope>` jobs enforce nothing

Every one of them runs `bun run test:coverage:<scope>`, which is
`bun test <paths> --coverage --coverage-threshold-lines=N`.

**Verified on Bun 1.3.14, this repo, this checkout:**

```text
$ bun test packages/gateway/src/agents/_lib/markdown-sections.test.ts \
    --coverage --coverage-threshold-lines=99.9
 25 pass
 0 fail
EXIT=0
```

An impossible threshold exits 0 and emits no coverage at all. Two independent causes, both already
documented in `CLAUDE.md` and the `nimbus-commands` skill: `--coverage-threshold-lines` is not a
Bun flag and unknown flags are ignored silently, and `bunfig.toml` sets `[test] coverage = false`,
which suppresses collection outright. The floors are really enforced by `audit:coverage-scopes`
over the merged lcov — step 16 of `unit-coverage`, which completes in under a second.

So the 13 jobs re-run subsets of a suite that already ran, assert nothing, and upload a Codecov
flag for coverage that was never collected (`continue-on-error: true`, so the upload's failure is
invisible too).

**One caveat blocks a blanket deletion**, and it is why this proposal is narrower than the finding:
`coverage-gates-pal`'s **Sandbox** leg additionally builds the sandbox helper and runs
`cppcheck --error-exitcode=1` over its C source — work nothing else in CI does. Its **Vault** leg
installs libsecret + D-Bus, which `unit-coverage` also does, so that one is genuinely redundant.

**Proposal (P5).** Delete the three `coverage-gates-linux` batches and the `coverage-gates-pal`
legs whose only content is a no-op coverage script. **Keep** the Sandbox leg, renamed to what it
actually is (`Sandbox helper + cppcheck`) with the dead `test:coverage:sandbox` invocation removed.
Fix the `test:coverage:*` scripts themselves in the same change — drop the inert
`--coverage-threshold-lines=N` argument so the next reader is not told a threshold is checked.

Expected effect: ~12 fewer concurrent jobs per PR, roughly 16 minutes of aggregate runner time
returned to the account-wide pool, and ~1m10s off the tail of the Ubuntu branch.

The existing batching comment in `_test-suite.yml` argues that queueing, not execution, is the
dominant term for these jobs, and that batching was the right call while that held. Deleting them
outright is the same argument taken to its conclusion once you know the gates were never gating.

### 3.3 The connector loop starts Bun more than it tests

The per-package loop runs 95 separate `bun test` invocations: `packages/gateway` (3m46s),
`packages/cli` (27 s), then 93 connector and github-actions packages between 06:05:57 and
~06:08:28 — **2m31s of wall time for 97.5 s of reported test execution**. The remainder, ~54 s, is
per-process startup plus the two Istanbul preloads, paid 95 times for packages averaging under a
second of work.

The loop exists for a real reason, recorded in the step: `bun test` must run from inside each
package so Bun resolves the right `package.json`.

**Proposal (P6), lowest value of the six.** Batch the connectors into a handful of grouped
invocations rather than one per package, or verify whether a single
`bun test packages/mcp-connectors` from the repo root resolves correctly now. Worth ~45 s. Listed
last on purpose: it is the smallest win here and it touches a loop with a documented rationale.

---

## 4. "Maybe take something to a new repo?" — the numbers say no

The idea is worth testing against measurement, and the measurement does not support it.

| | Packages | Source LOC | Test files | Test time |
|---|---:|---:|---:|---:|
| `packages/mcp-connectors/*` | 95 | 19,000 | 201 | 97.5 s (Linux) |
| `packages/gateway` | 1 | 62,568 | 1,067 | 225 s Linux · 647–882 s Windows |

Extracting all 95 connectors removes ~2.5 minutes from the Ubuntu job — which is not the critical
path — and nothing at all from Windows, since `pr-quality-cross-platform` runs `packages/gateway`
only. Against that it costs a second release pipeline, a versioning story, and cross-repo
integration testing to keep the connector contract honest. The precedent worth noting is that the
extractions which *have* worked here (`@nimbus-dev/sdk`, `@nimbus-dev/client`, `@nimbus-dev/mcp`)
were each justified by **publishing and consumption boundaries**, not by CI time.

If connectors ever move out, the argument should be ownership and contribution flow — a
community-maintained connector roster that does not need a core-repo PR — and the CI saving should
be treated as incidental. **Recommendation: decline on CI-time grounds; revisit only on ownership
grounds.**

---

## 5. Ranked proposals

| # | Proposal | Target | Est. saving | Risk |
|---|---|---|---:|---|
| **P1** | Deadline-based poll budget + visible retry warning | `brief-e2e.test.ts`, `brief-http.test.ts` | ~11 min on any run the flake fires | Low |
| **P2** | Migrate-once schema template per test file | top 6 Windows files | large share of 1129 s | Low |
| **P5** | Delete the no-op coverage jobs; keep Sandbox/cppcheck | `_test-suite.yml`, `package.json` | ~1m10s tail, ~16 min runner time | Medium — touches the gate set |
| **P4** | Split SonarCloud into its own job | `_test-suite.yml` | ~2 min on the Ubuntu branch | Low |
| **P3** | Probe a Windows `node_modules` cache | `setup-nimbus-ci` | up to 3m20s per Windows job | High — a bad restore breaks typecheck |
| **P6** | Batch the connector test loop | `_test-suite.yml` | ~45 s | Low |

**Suggested order:** P1 and P2 first — they attack the critical path and are pure test-side
changes with no gate implications. P4 and P5 next as one workflow PR. P3 as a throwaway-branch
spike whose acceptable outcome is a recorded negative. P6 only if someone is already in that file.

**Verification for each:** compare `gh run view <id> --json jobs` job spans before and after on
the same PR, and for P2 compare the per-file group spans using the same log-parsing approach that
produced § 2.2. Do not accept "feels faster" for any of them.

## 6. What this spec deliberately does not claim

- **P2's saving is not quantified.** The 18× runner gap is measured; how much of it a schema
  template recovers is not, because the migration cost is only one component of the 7 s mean.
  It should be measured on a branch before the change is called a win.
- **The `brief-e2e` timeout has a supported hypothesis, not a proven cause.** What is proven: the
  timer fired on time (not starvation), the test passed on retry, and the poll budget is capable of
  reaching 60 s at ~300 ms per round trip. What is not proven: that this is what happened on
  attempt 1. P1 is worth doing regardless, because it converts the failure mode into a legible one.
- **One run is one sample.** Every number here comes from run `32452626344`. The job-level shape
  is consistent with the 15 most recent `ci.yml` runs (PRs 13–18 min, pushes ~20 min), but the
  per-file spans are not.
