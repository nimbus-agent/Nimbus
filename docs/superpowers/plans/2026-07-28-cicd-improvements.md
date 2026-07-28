# Nimbus CI/CD Improvement Plan (measurement-first)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the CI/CD gaps that measurement — not intuition — says are actually costing
this org: an invisible red `main`, four ungated prose-drift surfaces, three red-capable checks
nothing requires, and a standing critical-alert backlog whose premise nobody has written down.

**Architecture:** Four gates and one instrument, all extending machinery that already exists.
`scripts/ci-latency/` gains a health collector (it currently cannot see a failure at all);
`scripts/structure-audit/` gains two drift checks in the shape of `audit:status-drift`; the
checked-in `.github/` config gains a declared required-check surface; and the Scorecard
backlog is closed with a written premise plus a gate that fails when that premise stops
holding. No workflow is restructured and **no job is added to the runner pool.**

**Tech Stack:** Bun 1.2+, TypeScript 6.x strict, GitHub Actions, Biome, markdownlint-cli2,
`gh` CLI.

**Binding precedent:** [`docs/infrastructure-roadmap.md`](../../infrastructure-roadmap.md)
§ P4b. Measurement overruled the design of record there: the proposed cache tuning and matrix
sharding would have made things worse by adding jobs to a pool granting 12–17 concurrent
slots. Every proposal below is labelled **measured** or **hypothesis**, and no proposal adds
jobs.

---

## Global Constraints

- **No `any`.** Use `unknown` for external data; TypeScript strict mode is non-negotiable.
- **Never commit on `main`.** This plan's own work lands on
  `dev/asafgolombek/cicd-improvement-plan`.
- **No new jobs in the runner pool.** P4b's finding is that the pool is the constraint. Any
  task that would add a job must instead extend an existing one, or be rejected.
- **A gate must never report a permanent mismatch as a fixable failure**
  (`infrastructure-roadmap.md`, 2026-07-27 rule). Distinguish transient unknowns (strict-red
  allowed) from permanent ones (warn / skip / measure against what the code actually tracks).
- **A gate is done when it is green in CI and would go red on regression** — not when its code
  merges.
- **`docs/superpowers/**` is markdownlint-gated.** Validate with
  `bunx markdownlint-cli2 <files>` before committing.
- **Biome false-fails in worktrees.** `bun run lint` reports "0 files processed" and exits 1
  inside `.claude/worktrees/`; validate with `bunx biome check packages scripts`.

---

## What we measured

All figures below were pulled on **2026-07-28** from the GitHub Actions API via `gh` and from
`git log` on `origin/main`. Every number is reproducible with the command shown.

### Sampling windows (state them, because two of them are tiny)

`gh run list --repo nimbus-agent/Nimbus --limit 100` covers **2.4 hours** — Nimbus produces
**276.8 runs/day**, so 100 runs is not a window, it is a snapshot. Every Nimbus figure below
therefore uses `--limit 3000` (**3000 runs / 10.8 days**, 2026-07-17 → 2026-07-28). Satellites
use `--limit 300`; `--limit 50` covered only 0.1 days on `nimbus-sdk`.

| repo | runs | window | runs/day |
| --- | --- | --- | --- |
| Nimbus | 3000 | 10.8 d | 276.8 |
| nimbus-sdk | 300 | 4.5 d | 67.4 |
| nimbus-vscode | 300 | 8.9 d | 33.7 |
| nimbus-client | 300 | 10.2 d | 29.4 |
| nimbus-web-clipper | 224 | 35.2 d | 6.4 |

### Run outcomes

| repo | completed | failure | failure rate¹ | cancelled | startup_failure | runs with attempt>1 |
| --- | --- | --- | --- | --- | --- | --- |
| Nimbus | 2999 | 73 | **3.1%** | 335 (11.2%) | **88** | 9 (0.3%) |
| nimbus-sdk | 300 | 12 | 5.3% | 19 | 0 | 2 |
| nimbus-client | 300 | 11 | 3.9% | 4 | 0 | 0 |
| nimbus-web-clipper | 224 | 7 | 3.4% | 3 | 0 | 3 |
| nimbus-vscode | 300 | 6 | 2.3% | 11 | 0 | 0 |

¹ failures ÷ (successes + failures); `skipped` and `cancelled` excluded.

**Retries are essentially not used: 9 of 3000 Nimbus runs (0.3%) reached attempt 2, and none
reached attempt 3.** The practice here is push-a-fix, not re-run. That is a real finding with a
consequence — *a "flaky, just re-run it" remediation has no precedent in this repo and should
not be proposed as one.*

### Per-workflow duration and failure rate (Nimbus, n=3000)

| workflow | runs | ok | fail | fail rate | cancel | startup_fail | median | p90 | max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Performance Benchmarks | 491 | 458 | 0 | 0.0% | 33 | 0 | 4.3 m | 42.6 m | 87.4 m |
| CI | 481 | 230 | 18 | 7.3% | **233** | 0 | 12.8 m | 53.1 m | 124.5 m |
| CodeQL | 327 | 297 | 2 | 0.7% | 28 | 0 | 3.6 m | 9.9 m | 33.6 m |
| CLA Assistant | 307 | 98 | 0 | 0.0% | 2 | **24** | 0.1 m | 5.0 m | 30.3 m |
| Lint PR Title | 276 | 218 | 3 | 1.4% | 0 | **55** | 0.3 m | 10.8 m | 25.8 m |
| Security | 269 | 244 | 19 | 7.2% | 6 | 0 | 2.4 m | 18.0 m | 42.9 m |
| Docs Quality | 225 | 194 | 12 | 5.8% | 19 | 0 | 1.4 m | 10.4 m | 29.0 m |
| Labeller | 219 | 219 | 0 | 0.0% | 0 | 0 | 0.5 m | 9.7 m | 24.6 m |
| release-please | 121 | 119 | 2 | 1.7% | 0 | 0 | 2.5 m | 4.8 m | 18.8 m |
| Scorecard | 111 | 111 | 0 | 0.0% | 0 | 0 | 0.9 m | 2.1 m | 21.8 m |
| Publish Linux repo | 21 | 16 | 3 | 15.8% | 0 | 0 | 1.9 m | 3.6 m | 4.4 m |
| Release | 19 | 19 | 0 | 0.0% | 0 | 0 | 28.5 m | 38.8 m | 56.9 m |
| Dependabot Updates | 14 | 9 | 5 | 35.7% | 0 | 0 | 2.7 m | 9.9 m | 10.4 m |
| Secret health | 14 | 9 | 5 | 35.7% | 0 | 0 | 1.0 m | 2.3 m | 4.2 m |
| Org drift sweep | 10 | 6 | 4 | 40.0% | 0 | 0 | 1.8 m | 3.2 m | 5.0 m |
| **Performance Reference Run (M1 Air)** | **11** | **0** | **0** | — | **10** | 0 | **1462.9 m** | 1466.7 m | 1482.8 m |

Satellite CI is an order of magnitude cheaper than Nimbus CI: median **1.3 m** (nimbus-client,
nimbus-vscode), **0.5 m** (web-clipper), **2.4 m** (nimbus-sdk) against Nimbus's **12.8 m**.

### Finding A — a scheduled workflow has never once succeeded

`Performance Reference Run (M1 Air)` fired **11 times** in the window and produced **0
successes**. Ten of the eleven sat queued for **~24 hours** (median 1462.9 min) and were then
cancelled by GitHub's queue ceiling; the eleventh is still open. Its self-hosted runner is not
answering.

It is invisible to every existing control: it is not a `startup_failure`, so
`audit:actions-allowlist` (which reports a workflow whose latest run ended in
`startup_failure`) does not see it; and `audit:ci-latency` samples only
`event=push&status=success`, so a workflow with zero successes contributes zero observations
and is reported as nothing at all.

### Finding B — `main` was red for ~4.75 hours and nothing said so

Six **consecutive** `CI` runs on `push`/`main` failed on 2026-07-28 between 05:59Z and 10:44Z
(runs `30333319359`, `30334421390`, `30346780102`, `30347270231`, `30348767354`,
`30350824311`), five of them on the identical job and step:

```text
CI — TS/Bun (macos-15) / Unit + Coverage — macos-15
  failed step: "Unit tests (with coverage) — macOS/Windows (retry once)"
  (fail) cast-driver e2e (incident-response committed snapshot) > --check passes
```

`audit:ci-latency` **structurally cannot see this**. `scripts/ci-latency/collect.ts` queries
`actions/runs?...&event=push&status=success` and then keeps only jobs with
`j["conclusion"] !== "success" → continue`. A job that is failing 100% of the time contributes
zero observations, so the latency gate reads "no data" and the health of `main` is measured by
nobody.

### Finding C — CI wall clock is now dominated by cross-run contention, not intra-run fan-out

P4b's after-measurement recorded 20 min wall clock at **n=1**. Re-running the promoted probes
today with a larger sample says the picture is bimodal, and the split is explained by how many
other runs are in flight.

`bun scripts/ci-latency/probe-dag.ts --runs 6` (post-change, n=6 runs / 18 legs):

```text
WHICH upstream job gated E2E: 6x CI — Rust/Tauri (ubuntu/windows/macos)
DAG wait per E2E leg: median 4.4 min, max 11.7, n=6
```

That is the like-for-like follow-up the roadmap asked for: **60.5 min → 4.4 min median**, and
the binding upstream job is `ci-rust` on all 6 runs — the change itself, holding at n=6.

`bun scripts/ci-latency/probe-concurrency.ts --runs 6` says every post-change run is **77 jobs
(ubuntu 35 / windows 18 / macos 18)** but wall clock splits 23 min vs 53–58 min. Correlating
each successful `CI` push-on-`main` run's wall clock against the number of *other* runs
overlapping it:

| CI push-on-main run | created | wall | overlapping runs |
| --- | --- | --- | --- |
| 30353595114 | 11:08Z | 19.8 m | 24 |
| 30356178888 | 11:47Z | 19.6 m | 24 |
| 30362765445 | 13:17:05Z | 44.1 m | 57 |
| 30362793344 | 13:17:28Z | 56.2 m | 57 |
| 30362811257 | 13:17:42Z | 53.5 m | 57 |
| 30362830157 | 13:17:57Z | 55.5 m | 55 |
| 30362844924 | 13:18:08Z | 57.5 m | 53 |
| 30371830053 | 15:07Z | 22.4 m | 19 |
| 30374166301 | 15:36Z | 19.1 m | 10 |

**Five merges landed on `main` within 63 seconds** (#906, #901, #905, #904, #903 — three of
them Dependabot). Isolated post-change runs finish in 19–22 min; the five-deep burst took
44–57 min each.

And the per-push demand is larger than P4b's number, because P4b counted only the `CI`
workflow. A single push to `main` fires **seven** workflows:

| workflow | jobs (push `0aafb31e`) | jobs (push `c1cc5055`) |
| --- | --- | --- |
| CI | 77 | 77 |
| Docs Quality | 8 | 8 |
| Security | 7 | 7 |
| Performance Benchmarks | 4 | 5 |
| CodeQL | 3 | 2 |
| Scorecard | 1 | 1 |
| release-please | 1 | 1 |
| **total** | **101** | **101** |

So the burst demanded **≈505 job slots against a pool granting 8–15 concurrent** (peak
concurrent measured 8 / 8 / 9 / 12 / 15 across the five runs `probe-concurrency` returned
job-level data for). P4b's tuning was correct
and is holding; the residual is a *different* variable — batch size at the merge point.

### Finding D — 42 of the 77 CI jobs do under 4 minutes of work each

Job-level durations for a clean 77-job run (`30374166301`):

| group | legs | per-leg execution |
| --- | --- | --- |
| Coverage gates — ubuntu | 24 | 0.63 – 1.02 min |
| Coverage gates — macOS | 9 | 1.27 – 1.77 min |
| Coverage gates — windows | 9 | 2.10 – 3.78 min |
| Unit + Coverage | 3 | 5.13 / 12.22 / 13.43 min |
| Static | 3 | 4.65 / 5.42 / 7.72 min |
| everything else | 29 | ≤ 3 min |

The 42 coverage-gate legs consume **55% of the run's job slots** to perform ~58 job-minutes of
aggregate work — i.e. they are dominated by fixed per-job overhead (checkout, `bun install`,
cache restore), not by the threshold computation. None of the 42 is an individually required
status check on Nimbus (see Finding F).

### Finding E — two prose-drift surfaces, both red-proved retroactively against real history

The audit's two named cheap fixes were replayed over `origin/main`'s real history.

**Release-version string.** Comparing `CLAUDE.md`'s ``Latest release `vX.Y.Z` `` against
`.release-please-manifest.json` at every first-parent commit since 2026-06-20:

```text
commits inspected: 158; stale: 152 (96.2%)
  2026-06-21 -> 2026-07-18: 52 commits, doc said v0.11.2, manifest reached 0.22.0
  2026-07-19 -> 2026-07-22: 27 commits, doc said v0.22.0, manifest reached 0.24.0
  2026-07-22 -> 2026-07-26: 36 commits, doc said v0.24.0, manifest reached 1.0.0
  2026-07-26 -> 2026-07-28: 37 commits, doc said v1.0.0,  manifest reached 1.5.0
```

The worst window ran **27 days and eleven minor versions** behind. The same string is repeated
verbatim in `GEMINI.md` and again in `docs/roadmap.md`.

**`COMMAND_NAMES` ⊆ `COMMAND_HANDLERS` ∪ {bench, help}.** Replayed over every first-parent
commit since 2026-04-01 that carries both files:

```text
commits inspected 469, drifted 468 (99.8%)
  2026-05-12 -> 2026-07-28: 468 commits, orphaned=[sync,voice]
  HEAD state: clean
```

`sync` and `voice` sat in the registry with **no handler for 77 days and 468 consecutive
commits**, cleared only today by #908. This matters beyond tidiness:
`scripts/audit/readme-cli-commands.ts` reads `COMMAND_NAMES` as the authority for "this
`nimbus <cmd>` exists", so for 77 days a doc could have documented `nimbus sync` and
`audit:readme-cli` would have passed it.

### Finding F — three red-capable checks that nothing requires

Live required-status-check contexts per repo (`gh api repos/.../rulesets/<id>`):

| repo | required contexts |
| --- | --- |
| Nimbus (10) | PR quality — required gates · Dependency audit · Trivy vulnerability scan · Gitleaks secret scan · Gateway audit JSON + connector.remove vault restore · Cargo audit (Tauri) · Cargo deny · Analyze (javascript-typescript) · Analyze (rust) · cla |
| nimbus-client (6) | build-test (ubuntu-24.04) · build-test (macos-latest) · build-test (windows-latest) · Analyze (javascript-typescript) · SonarQube Cloud analysis · cla |
| nimbus-vscode (5) | build-test · Analyze (javascript-typescript) · SonarQube Cloud analysis · **CodeRabbit** · cla |
| nimbus-web-clipper (4) | build-test · Analyze (javascript-typescript) · SonarQube Cloud analysis · cla |
| nimbus-sdk (3) | ci-complete · Analyze (javascript-typescript) · cla |

Measured gaps:

1. **`Validate PR title` is required on neither Nimbus nor nimbus-vscode**, yet it goes red for
   real: 3 failures in the Nimbus window, one of them today on the type `docs+deps:`, which is
   not a Conventional Commit type. **35 of 327 (10.7%)** first-parent `main` commits since
   2026-06-01 are unparseable by the gate's own regex, so those changes shipped with no
   changelog entry and no release trigger. Since the gate was repaired on 2026-07-21 the rate
   is 0 — the gate works when it runs; it is simply not load-bearing.
2. **`nimbus-sdk` runs `SonarQube Cloud` (61 runs, 4 failures = 7.3%) and does not require it**,
   while the other three satellites do.
3. **`nimbus-vscode` requires the `CodeRabbit` context** and it does report (verified on PR
   #59). No other repo does. A third-party review bot outage blocks merges on exactly one repo
   — the CLA failure mode, inverted.

A gate asserting *sameness* across these five lists would be permanently red: the repos are
genuinely different, and permanent red is the anti-pattern the roadmap names. The checkable
property is **coverage**, not parity.

### Finding G — `Secret health` is now red every Monday, by construction

Nimbus `Secret health` had exactly two **scheduled** runs in the window: 2026-07-20 success,
2026-07-27 **failure**. The failing row:

```text
| nimbus-vscode/VSCE_PAT | inventory | deadline | hard deadline 2026-09-20 in 54d — ...
```

`deadline` is in the `hard` set in `scripts/release/check-secret-health.ts` (line 140), so it
exits 1. The deadline entered the 90-day lead window when #841 corrected the date on
2026-07-26. Every weekly run from now until the PAT is rotated is red — **eight more Mondays**.
The consequence is not the red itself (rotation is a real action) but that **a newly dead
credential would be indistinguishable from the standing red.**

### Failure MODES (not individual failures)

All 73 Nimbus failures were classified by the *names of the jobs and steps that failed*, not by
log text — categorical rather than anecdotal.

| mode | runs | share | signature |
| --- | --- | --- | --- |
| Ambient dependency advisory | 19 | 26% | `Dependency audit` / `Trivy vulnerability scan` / `JS license compliance` / `Cargo deny` |
| Docs quality | 13 | 18% | `lychee link check` / `markdownlint-cli2` |
| Platform-specific test | 10 | 14% | `Unit + Coverage — macos-15` ×6, `E2E Gateway — windows-2025` ×2, `Coverage — Perf/DB layer` ×2 |
| PR-quality aggregate | 7 | 10% | `PR quality — … / Unit + Coverage` + `PR quality — required gates` |
| Credential / deadline | 5 | 7% | `Check release credential health` |
| Dependabot infra | 5 | 7% | `Dependabot` job on the `dynamic` event |
| Org-sweep gate | 4 | 5% | `release-staleness` / `cla-coverage` / `ruleset-drift` ×2 |
| Publish channel | 3 | 4% | `Build + publish apt/yum repo` |
| PR title | 3 | 4% | `Validate PR title` |
| release-please App token | 2 | 3% | `release-please` (the `403 workflows:write` root cause) |
| CodeQL on Dependabot bumps | 2 | 3% | `Analyze (rust)` / `Analyze (javascript-typescript)` |

The head of the distribution is **ambient**, not per-change. The 19 advisory failures cluster:
six runs across **three different branches** inside 31 minutes on 2026-07-26 (12:43–13:14Z),
plus three separate `schedule` runs on 07-21, 07-25 and 07-26. One new advisory reds `main`'s
nightly *and every open PR at once*, and no PR author can fix it. Second place — docs quality —
is per-change and locally reproducible.

`startup_failure` deserves its own line because it is not a failure in any API sense and is
excluded from every rate above: **88 runs**, spread across `Lint PR Title` (55, 2026-07-18 →
2026-07-21), `CLA Assistant` (24, 2026-07-24 → 2026-07-26) and `Lock Threads` (9). Two of the
three are already recorded in the infrastructure roadmap; the point here is the **size**: 88
runs of a required-or-should-be-required gate never executed, and the class recurs.

### What we could NOT measure

State plainly, so nothing below is read as grounded when it is not.

- **Runner-pool ceiling.** No API exposes the concurrency limit. Peak *observed* concurrency
  (8–15) is a lower bound, not the limit. P4b's "12–17" and today's "8–15" may reflect
  different demand, not a different ceiling.
- **Whether contention is self-inflicted or org-wide.** Overlap counts here are Nimbus-only.
  The four satellites draw on the same account pool and were not included in the overlap
  arithmetic.
- **Cost.** No billing data was read. Nothing here is justified on minutes or dollars.
- **Whether collapsing the 42 coverage gates would reduce wall clock.** Finding D establishes
  the slot cost; it does not establish that the trade is net-positive, because the collapsed
  job's serial execution (~19 min on ubuntu) would exceed today's longest TS job (13.4 min).
  Task 5 is written as a *probe*, not a change.
- **`Performance Reference Run`'s runner.** Self-hosted runner state is not visible through the
  public API; that the runner is not answering is inferred from 10 consecutive 24-hour queue
  timeouts, which is strong but indirect.
- **Whether GitHub merge queue is available on this plan.** Merge queue would directly address
  Finding C; plan eligibility was not verified and it is an owner-only setting. Flagged, not
  proposed.

---

## Candidate assessment

Each candidate the brief named, with a verdict held to the P4b standard: *grounded in measured
data, or labelled a hypothesis.*

### 1. Credential liveness gate — **ACCEPT, narrowed**

`nimbus-web-clipper#26` is **merged**; `.github/workflows/store-credential-check.yml` is live
on that repo and has run 3 times, all green. Its evidence is unusually strong: the v0.2.0
release failed at both store-upload steps on credentials marked "configured" since 2026-07-19,
and one probe run located three independent defects (a 7-day Testing-mode OAuth expiry, a
half-rotated client-secret pair, and a trailing whitespace character) that four rounds of
hypothesis had missed. Measured corroboration in the run data: `Publish Web Clipper` has fired
twice ever — `v0.1.0` succeeded on 2026-07-19, and `v0.2.0` on 2026-07-28 **failed at attempt
3**, the only run in any repo to reach a third attempt. The credentials died in the nine days
between, with nothing watching.

**Generalise to `VSCE_PAT` and `OVSX_PAT`: yes.** `VSCE_PAT` hard-expires 2026-09-20
(`credential-registry.ts`, the SSoT) and Open VSX has no OIDC path at all, so rotation is the
only mitigation for `OVSX_PAT`. Both are exercised only at publish time — 8 `Publish VS Code
Extension` runs in the window, the most recent 2026-07-24, with multi-day gaps. A weekly
read-only probe converts "the manifest says it expires" into "it stopped working on this date".

**Generalise to `NPM_TOKEN`: no.** `NPM_TOKEN` is `state: "forbidden"` in the registry —
revoked 2026-07-19, publishing is OIDC-only with `mfa=publish`. There is nothing to probe, and
`check-secret-health.ts` already guards its *absence* by enumerating secret names. A liveness
probe for a credential that must not exist is the permanent-mismatch anti-pattern.

**Load-bearing design constraint from Finding G: do NOT fold these probes into
`secret-health`.** That job is red every Monday on the `VSCE_PAT` deadline row and will be for
eight more weeks. Adding new signal to a channel that is already saturated is precisely how a
gate becomes one everybody ignores. The probe ships as its own workflow on `nimbus-vscode`,
mirroring the web-clipper file. Zero jobs added to Nimbus.

### 2. Doc-drift gate — **ACCEPT both, with a design correction on the first**

Both named fixes are red-proved against real history in Finding E: 96.2% of the last 158 `main`
commits carried a stale release string; `sync`/`voice` were orphaned for 468 consecutive
commits. `audit:status-drift` genuinely does not cover either — it matches only the
unambiguous `I<N>` / `V<N>` *ceiling* phrasings, by design.

**Correction the measurement forces.** A strict-equality release-string check would be red on
the release commit itself unless the doc is edited in the same commit — a gate that manufactures
a chore on every release. The fix is to remove the human from the loop first: mark the version
token in `CLAUDE.md` / `GEMINI.md` / `docs/roadmap.md` with `x-release-please-version` and add
them to `.release-please-config.json`'s `extra-files`, so release-please updates them in the
release PR. The gate then becomes a **regression detector** — green by construction, red if
someone removes a marker or hand-edits the string. If `extra-files` turns out not to reach these
files, the fallback is a grace window measured from the manifest bump commit's date, the shape
`audit:release-staleness` already uses.

The `COMMAND_NAMES` check needs no such correction: it is exact, local, deterministic and
currently clean, so it belongs in the `preflight:fast` tier next to `audit:secret-inventory`.
Like `ci-latency`, it **ships green by construction** — its red-proof is a unit test, not a
live run.

### 3. Required-check consistency across repos — **ACCEPT the property, REJECT the framing**

A gate asserting the five repos require *the same* contexts is unsatisfiable: Nimbus requires
10, nimbus-sdk 3, and both are correct for their repos. That is a permanent mismatch, and the
roadmap's 2026-07-27 rule forbids shipping one as a strict-red gate.

The checkable property is **coverage with declared exceptions**: every check context a repo's
workflows actually produce on a PR must either be *required*, or appear in checked-in config
with a reason. That formulation is satisfiable, goes red on real regression, and finds all
three measured gaps in Finding F — including the one the brief did not anticipate
(`Validate PR title` required nowhere, against a measured 10.7% unparseable-title rate).

The nimbus-client fix applied today (1 → 6 required checks) is exactly the class of drift this
catches, and it was found by hand. Note also that the existing `ruleset-drift` sweep gate
**deliberately does not diff `bypass_actors`** (the App token cannot read them), so a
required-check gate must not assume the ruleset diff already covers this ground.

### 4. Scorecard `DangerousWorkflowID` → restructure the release pipeline — **REJECT the restructure, ACCEPT a cheaper closure**

Verified from source, not from the audit's wording:

- `release.yml` triggers **only** on `push: tags: [v*.*.*, v*.*.*-*]`. There is no
  `pull_request` path in.
- `publish-package-managers.yml` and `publish-linux-repo.yml` trigger on
  `workflow_run: { workflows: ["Release"], types: [completed] }` plus `workflow_dispatch`, and
  each job additionally gates on `workflow_run.conclusion == 'success' &&
  startsWith(head_branch,'v') && !contains(head_branch,'-')`.

Scorecard's generic pwn-request premise — a `workflow_run` fed by a fork's `pull_request` — does
**not** hold here. The alerts are rule-level false positives for this trigger shape.

The restructure's cost is measured and the risk is not. Splitting each publish workflow into
unprivileged-build + privileged-publish roughly doubles their job count, adding jobs to the
pool that Finding C confirms is still the binding constraint, in exchange for hardening against
a threat model that requires repo **write** access — the same privilege needed to push the tag
in the first place.

There is, however, a real residual, and it is narrower than the alert says: the checkout at
`ref: ${{ github.event.workflow_run.head_sha }}` happens in the **same job** that later mints
the release-bot token and reads `WINGET_PAT`, and that job runs `bun install` plus repo scripts
from the checked-out tree. And the `Protected release tags` ruleset carries rules
`deletion, non_fast_forward, update` — **no `creation` rule** — so any write-holder can create
`v1.2.3` pointing at arbitrary code.

Closure that needs no new infrastructure and adds no jobs: **dismiss the three alerts with a
written premise, and gate the premise.** A dismissal whose justification lives only in a GitHub
comment decays exactly like the controls at the top of the infrastructure roadmap. A static
check that fails if `release.yml` ever gains a non-tag trigger, or if a publish workflow's
`workflow_run.workflows` stops naming only `Release`, turns the premise into something a
machine re-verifies on every PR. Adding a `creation` rule to the tag ruleset is the stronger
fix but is **owner-only and risky** — it would block the release-please reconcile step's own
tag creation unless the App is added as a bypass actor — so it is flagged, not planned.

---

## Task 1: A CI health collector — because the latency gate cannot see a failure

Finding B: `main` was red for 4.75 hours across six consecutive pushes and no control noticed.
`scripts/ci-latency/collect.ts` filters to `status=success` runs and `conclusion === "success"`
jobs, so a 100%-failing job produces zero observations and the gate reports nothing. Finding A:
a workflow with **zero** successes in 11 scheduled runs is invisible for the same reason.

**Files:**

- Create: `scripts/ci-latency/health.ts`
- Create: `scripts/ci-latency/health.test.ts`
- Modify: `scripts/ci-latency/check.ts` (report health findings alongside latency)
- Modify: `package.json` (no new script — `audit:ci-latency` already runs `check.ts`)

**Interfaces:**

- Consumes: `runGh` / `isRecord` from `scripts/structure-audit/_gh-audit.ts`; `AUDITED_REPOS`
  from `./constants.ts`.
- Produces:
  - `export type HealthFindingKind = "red-streak" | "never-succeeded" | "chronic-queue";`
  - `export interface HealthFinding { repo: string; workflow: string; kind: HealthFindingKind; detail: string; }`
  - `export function classifyWorkflowHealth(input: { repo: string; workflow: string; runs: readonly RunOutcome[] }): HealthFinding | null;`
  - `export interface RunOutcome { conclusion: string; createdAt: string; updatedAt: string; startedAt: string; event: string; branch: string; }`

`classifyWorkflowHealth` is pure — it takes already-fetched run rows so the whole rule set is
table-tested offline, mirroring how `evaluate.ts` and `summarize.ts` are structured.

**No new job.** The findings surface inside the existing `ci-latency` job in
`org-drift-sweep.yml`.

- [ ] **Step 1: Write the failing test**

Create `scripts/ci-latency/health.test.ts` covering, at minimum:

- three or more consecutive `failure` runs on the default branch for one workflow →
  `red-streak`; the detail names the count and the first/last timestamps.
- two consecutive failures → `null` (a single bad merge plus its immediate fix must not alert).
- a workflow with ≥5 runs and **zero** `success` → `never-succeeded`, and this fires even when
  every run is `cancelled` (Finding A's exact shape: 10 cancelled + 1 open, 0 successes).
- a workflow whose runs all show `updatedAt − startedAt > 12 h` → `chronic-queue`.
- a workflow whose latest run is `success` after a prior streak → `null` (since-fixed must not
  red the sweep forever, matching `audit:actions-allowlist`'s latest-run scoping).
- fewer than 5 runs → `null` (`insufficient-data`, never a finding).
- an unreadable/absent `conclusion` (a still-running run) is ignored, never counted as a
  failure — an in-flight run must not manufacture a streak.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test scripts/ci-latency/health.test.ts`
Expected: FAIL — `Cannot find module './health.ts'`.

- [ ] **Step 3: Implement `health.ts`**

Query `repos/nimbus-agent/<repo>/actions/workflows` for active workflows, then each workflow's
recent runs via `actions/workflows/<id>/runs?per_page=20&branch=<default>`. Reuse the
`classifyReadFailure` posture from `_gh-audit.ts`: a non-404 read failure is **indeterminate**,
never a finding. Cap requests the way `MAX_RUNS_PER_WORKFLOW` does so the sweep's API budget
does not grow without bound.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test scripts/ci-latency/health.test.ts`

- [ ] **Step 5: Wire into `check.ts` as findings, and decide severity deliberately**

`red-streak` and `never-succeeded` are **strict-red**: both are transient-in-principle (a fix
clears them) and both are actionable by the person reading the sweep. `chronic-queue` is a
**warning** — a self-hosted runner being offline is not something a contributor's PR can fix,
and the roadmap names reporting an unfixable condition as how a gate becomes ignored.

- [ ] **Step 6: Red-prove against real history**

Run the classifier over the six consecutive `CI` failures of 2026-07-28 and over
`Performance Reference Run (M1 Air)`'s 11 runs; confirm `red-streak` and `never-succeeded`
respectively. Capture the output in the PR description. **This is the red-proof** — like
`ci-latency`, the live gate ships green because the conditions are already resolved.

- [ ] **Step 7: Typecheck, lint, commit**

Run: `bunx tsc --noEmit -p tsconfig.json` and `bunx biome check scripts`.

---

## Task 2: Stop the release string drifting, then gate that it stays put

Finding E: 152 of 158 `main` commits (96.2%) carried a stale release version in `CLAUDE.md`,
worst case 27 days and eleven minor versions behind. Automate first; gate second.

**Files:**

- Modify: `.release-please-config.json`
- Modify: `CLAUDE.md`, `GEMINI.md`, `docs/roadmap.md` (version-token markers only)
- Create: `scripts/structure-audit/check-release-string-drift.ts`
- Create: `scripts/structure-audit/check-release-string-drift.test.ts`
- Modify: `package.json` (`audit:release-string`), `scripts/lib/preflight-gates.ts`

- [ ] **Step 1: Write the failing test**

Pure function under test:
`export function checkReleaseString(input: { manifestVersion: string; docs: readonly { path: string; text: string }[] }): { ok: boolean; errors: string[] }`.
Cases: all three docs matching → ok; one stale → one error naming the file, the claimed version
and the manifest version; a doc with **no** matchable version token → an error saying the
marker is missing (a silently unmatched regex is how a drift gate dies quietly — the same
failure shape as `audit:actions-allowlist`'s repo-wide run window).

- [ ] **Step 2: Verify it fails**

Run: `bun test scripts/structure-audit/check-release-string-drift.test.ts`

- [ ] **Step 3: Add the release-please markers**

Add `<!-- x-release-please-version -->` beside the version token in all three docs and register
them under `extra-files` in `.release-please-config.json`.

**Verify before relying on it:** run
`bunx release-please release-pr --dry-run --repo-url=nimbus-agent/Nimbus --token=$GH_TOKEN`
(or inspect the next real release PR's diff) and confirm all three files appear. If they do
not, fall back to the grace-window design in Step 3b rather than shipping a gate that reds on
every release.

- [ ] **Step 3b (fallback only): grace window**

If `extra-files` does not reach these files, compare against the **bump commit's** date and
allow a window, exactly as `check-release-staleness.ts` does for the phantom edge. Reuse that
module's helper rather than writing a second clock.

- [ ] **Step 4: Implement, verify green, and check the third surface**

`docs/roadmap.md` carries `Latest release **v1.5.0**` in different markup from CLAUDE.md's
backticked form. Make the matcher tolerant of both, and assert in the test that both spellings
parse — otherwise the gate silently covers two of three files.

- [ ] **Step 5: Register the gate**

Add to `package.json` and to `scripts/lib/preflight-gates.ts` (the manifest drift test fails if
a CI gate is missing from it). It is local and deterministic, so it belongs in the
`preflight:fast` tier, like `audit:secret-inventory`.

- [ ] **Step 6: Red-prove**

Temporarily set the manifest to a different version, run the gate, confirm exit 1 naming all
three files, then revert.

---

## Task 3: Gate `COMMAND_NAMES` against the dispatcher

Finding E: `sync` and `voice` were in `COMMAND_NAMES` with no handler for 468 consecutive
commits across 77 days, and `audit:readme-cli` treats that list as the authority for whether a
documented command exists.

**Files:**

- Modify: `scripts/audit/readme-cli-commands.ts` (extend — do not create a second script)
- Modify: `scripts/audit/readme-cli-commands.test.ts`

**Interfaces:**

- Produces:
  `export function checkRegistryBackedByHandlers(input: { names: readonly string[]; handlers: readonly string[]; specialCased: readonly string[] }): { ok: boolean; orphans: string[]; unregistered: string[] }`

Both directions are checked. An `orphan` (name with no handler) is what bit us; an
`unregistered` handler (dispatchable command absent from `COMMAND_NAMES`) is the mirror bug and
would make `audit:readme-cli` reject a correctly documented command.

- [ ] **Step 1: Write the failing test**

Include the historical case verbatim — `names` containing `sync` and `voice` with no matching
handler must produce `orphans: ["sync","voice"]` — so the regression that actually happened is
the test's own fixture. Assert `bench` and `help` in `specialCased` do not count as orphans
(they are dispatched before the `COMMAND_HANDLERS` lookup in `index.ts`).

- [ ] **Step 2: Verify it fails**, then implement, then verify it passes.

- [ ] **Step 3: Parse `index.ts` deliberately, not incidentally**

The handler set lives in a `Readonly<Record<string, CommandHandler>>` object literal between
`const COMMAND_HANDLERS` and `const HELP_ALIASES`. **Fail loudly if either delimiter is not
found** rather than returning an empty handler set — an empty set would report all 59 names as
orphans, i.e. a parse failure would present as a catastrophic (and wrong) product finding. This
is the roadmap's "an unreadable input degrades to indeterminate, never to a finding" rule.

- [ ] **Step 4: Confirm green on HEAD**

Run: `bun run audit:readme-cli`
Expected: green. Verified today — `origin/main` is currently clean on both directions
(59 names, 57 handlers, `bench` + `help` special-cased, 0 orphans, 0 unregistered).

- [ ] **Step 5: Red-prove** by adding a throwaway name to `COMMAND_NAMES`, confirming exit 1,
      and reverting.

---

## Task 4: Declare the required-check surface, and gate coverage rather than parity

Finding F: three measured gaps, one of them (`Validate PR title` required nowhere) against a
measured 10.7% unparseable-title rate on `main`.

**Files:**

- Create: `.github/required-checks.json`
- Create: `scripts/structure-audit/check-required-checks.ts`
- Create: `scripts/structure-audit/check-required-checks.test.ts`
- Modify: `.github/workflows/org-drift-sweep.yml` (extend the existing `ruleset-drift` job —
  **do not add a job**)
- Modify: `package.json`

**Interfaces:**

- `export interface RepoCheckPolicy { repo: string; required: readonly string[]; advisory: readonly { context: string; reason: string }[] }`
- `export function diffRequiredChecks(input: { policy: RepoCheckPolicy; liveRequired: readonly string[]; observedContexts: readonly string[] }): { ok: boolean; errors: string[]; warnings: string[] }`

Three rules:

1. **Declared vs live** — every context in `policy.required` is required in the live ruleset,
   and vice versa. Hard.
2. **Coverage** — every context in `observedContexts` (produced by a real recent PR) is either
   in `policy.required` or in `policy.advisory`. Hard, because this is the rule that finds
   `Validate PR title` and nimbus-sdk's Sonar.
3. **Advisory reasons are non-empty.** Hard. An advisory entry with no reason is how a gap gets
   laundered into "declared".

- [ ] **Step 1: Write the failing test**, using the five real check lists from Finding F as
      fixtures.

- [ ] **Step 2: Verify it fails**, then implement `diffRequiredChecks`, then verify it passes.

- [ ] **Step 3: Author `.github/required-checks.json` describing today's state**

Record what is true *now*, then remediate separately — the same red-before/green-after sequence
P2 used. Seed `advisory` with the three measured gaps and a reason each, so the first commit is
honest rather than green-by-omission:

- `Nimbus / Validate PR title` — advisory today; Task 6 proposes promoting it.
- `nimbus-sdk / SonarQube Cloud analysis` — advisory today; the other three satellites require
  it.
- `nimbus-vscode / CodeRabbit` — **required today, and uniquely so.** Record the asymmetry with
  its reason; changing it is an owner decision (see `needsOwner`).

- [ ] **Step 4: Source `observedContexts` from a real PR, not from workflow YAML**

Read the check rollup of each repo's most recently merged PR
(`gh pr view <n> --json statusCheckRollup`). Parsing `.github/workflows/**` cannot tell you what
context name a job actually publishes — the CLA outage turned on exactly that distinction (the
required context is `cla`, the job name, not "CLA Assistant"). If no merged PR is available,
degrade to **indeterminate**, never to a finding.

- [ ] **Step 5: Wire into the existing `ruleset-drift` job**, `--strict` in CI, fail-soft
      locally. Confirm the sweep job count does not increase.

- [ ] **Step 6: Red-prove** by removing one context from `.github/required-checks.json`,
      dispatching the sweep, and confirming red — then restore.

---

## Task 5: Close the three Scorecard alerts with a premise a machine re-checks

Rejecting the restructure is only defensible if the reasoning outlives this session.

**Files:**

- Create: `scripts/structure-audit/check-publish-trigger-shape.ts`
- Create: `scripts/structure-audit/check-publish-trigger-shape.test.ts`
- Modify: `docs/infrastructure-roadmap.md` (P5 progress log)
- Modify: `package.json`, `scripts/lib/preflight-gates.ts`

- [ ] **Step 1: Write the failing test**

`export function checkTriggerShape(input: { releaseYaml: string; publishYamls: readonly { path: string; text: string }[] }): { ok: boolean; errors: string[] }`

Assertions, each red-proved with a mutated fixture:

- `release.yml`'s `on:` contains **only** `push.tags`. A `pull_request`,
  `pull_request_target` or `workflow_call` trigger → error.
- every publish workflow's `workflow_run.workflows` lists exactly `["Release"]`.
- every publish job that checks out `workflow_run.head_sha` also gates on
  `workflow_run.conclusion == 'success'`.

- [ ] **Step 2: Verify it fails**, implement, verify it passes against the real files.

- [ ] **Step 3: Register the gate** in `package.json` and `preflight-gates.ts`
      (`preflight:fast` tier — it is a local YAML read).

- [ ] **Step 4: Record the premise in the infrastructure roadmap**

Under P5, state: what Scorecard flags, why the trigger shape makes the generic pwn-request
premise inapplicable, the residual (a write-holder can create a `v*` tag at any commit because
the `Protected release tags` ruleset has no `creation` rule), why the restructure was rejected
(adds jobs to the measured binding constraint against an unmeasured risk), and the gate that
re-checks the premise.

- [ ] **Step 5: Dismiss the three alerts — OWNER ACTION**

```bash
gh api -X PATCH repos/nimbus-agent/Nimbus/code-scanning/alerts/<n> \
  -f state=dismissed -f dismissed_reason="won't fix" \
  -f dismissed_comment="workflow_run fires only from Release, which triggers only on v* tag push; see docs/infrastructure-roadmap.md P5 and audit:publish-trigger-shape"
```

Do this **after** Step 4 merges, so the comment's link resolves. Leave the alerts open if the
gate is not yet live — an undismissed alert is better than a dismissal with no backing.

---

## Task 6: Promote `Validate PR title` to a required check — OWNER ACTION

Measured: 35 of 327 `main` commits since 2026-06-01 (10.7%) are unparseable by the gate's own
regex and therefore shipped with no changelog entry; the gate is red-capable (3 failures in the
window, one today on `docs+deps:`); and it is required on no repo. Since its 2026-07-21 repair
the unparseable rate is 0, so promoting it costs nothing today and prevents the regression from
recurring silently.

- [ ] **Step 1: Confirm the context name from a live PR**, not from the workflow file. The job
      name is `Validate PR title`; the CLA outage is the standing reminder that the required
      context is the **job** name.
- [ ] **Step 2: Add `Validate PR title` to the Nimbus and nimbus-vscode `General` rulesets.**
      The rulesets API is a **full replace** — re-send every existing required context or the
      others are silently unrequired.
- [ ] **Step 3: Update `.github/required-checks.json`** (Task 4) from `advisory` to `required`,
      and confirm the Task 4 gate goes green against live state.
- [ ] **Step 4: Prove it blocks** by opening a throwaway PR with a malformed title and
      confirming merge is blocked, then closing it.

**Why this is owner action:** it changes merge-blocking behaviour on two repos. Do not apply it
from an automated context.

---

## Task 7 (PROBE, not a change): does collapsing the coverage-gate matrix help?

**This is a hypothesis, explicitly labelled.** Finding D measures that 42 of 77 CI jobs execute
for under 4 minutes each and that none is individually required on Nimbus. It does **not**
measure that collapsing them helps — the collapsed ubuntu job's serial execution (~19 min)
would exceed today's longest TS job (13.4 min), and P4b's lesson cuts both ways: the pool is the
constraint, but so is the critical path.

Do not change the workflow in this pass. Measure first, exactly as P4b did.

- [ ] **Step 1: Establish the post-change baseline at n≥15**

Run `bun scripts/ci-latency/probe-dag.ts --runs 15` and
`bun scripts/ci-latency/probe-concurrency.ts --runs 15` once ~15 green push runs have
accumulated. Today's n=6 gives DAG wait **4.4 min median / 11.7 max** and wall clock **19–58
min**; the roadmap's n=1 recorded 2.5 min and 20 min. Record whichever the larger sample says.

- [ ] **Step 2: Separate contention from fan-out**

Recompute the overlap correlation in Finding C at n≥15. If isolated runs stay near 20 min and
only bursts exceed 45, the residual is **batch size at the merge point**, and collapsing the
matrix is the wrong lever — the right one is landing fewer simultaneous merges (see
`needsOwner`: merge queue).

- [ ] **Step 3: Regenerate the latency baseline**

The roadmap notes regeneration is due after ~12 post-change push runs, once the 30 abandoned
macOS/Windows coverage keys age out of `MAX_RUNS_PER_WORKFLOW`. Run
`bun run audit:ci-latency -- --update-baseline` then, not before — sooner is a no-op.

- [ ] **Step 4: Only if Steps 1–2 show intra-run fan-out still binding**, write a separate plan
      for the collapse, including how 24 check contexts disappearing interacts with anything
      that consumes them.

---

## Explicitly rejected (and why)

- **Matrix sharding / cache tuning.** Retired by P4b's measurement; adds jobs to the binding
  constraint.
- **A serializing `concurrency:` group on `main` pushes.** It would address Finding C's burst
  directly, but GitHub queues only **one** pending run per group: a third push cancels the
  second. This org has already been bitten (33 of 60 push-to-main runs evicted from a shared
  group), and P4a deliberately made `cancel-in-progress` conditional on `pull_request` so `main`
  merges stop cancelling each other. Rejected.
- **"Re-run the flaky job" as a remediation.** 9 of 3000 runs reached attempt 2 (0.3%). There is
  no re-run culture here to build on.
- **A liveness probe for `NPM_TOKEN`.** The credential is `forbidden`; publishing is OIDC-only.
  Nothing to probe.
- **Restructuring the publish workflows into unprivileged-build + privileged-publish.** See
  candidate 4.
- **A required-check *parity* gate.** Permanently unsatisfiable across five legitimately
  different repos.

---

## Self-review

**Every candidate in the brief has a verdict.** Credential liveness → accepted, narrowed to
VSCE/OVSX, explicitly kept out of the saturated `secret-health` channel (Task 1's Finding G is
what forces that). Doc drift → both checks accepted with a design correction, Tasks 2 and 3.
Required-check consistency → property accepted, framing rejected, Task 4 (+ Task 6 for the gap
it finds). Scorecard → restructure rejected, premise-gate accepted, Task 5.

**Grounding.** Findings A, B, D, E, F and the failure-mode taxonomy are measured with commands
shown. Finding C is measured but at n=6 with an explicit instruction to re-measure at n≥15.
Task 7 is labelled a hypothesis and changes nothing.

**No jobs added.** Task 1 extends `check.ts` inside the existing `ci-latency` job; Task 4
extends `ruleset-drift`; Tasks 2, 3 and 5 are local `preflight:fast` gates; Task 6 is a ruleset
edit; the only new workflow (candidate 1's probe) lands on `nimbus-vscode`, not on the
constrained Nimbus pool.

**Permanent-vs-transient discipline.** `chronic-queue` warns rather than fails; unreadable
inputs degrade to indeterminate in Tasks 1, 3 and 4; the parity framing was rejected precisely
because it is a permanent mismatch; and Task 2's automate-then-gate ordering exists so the gate
is not red on every release.

**Known gap, stated rather than hidden.** Nothing here reduces the head of the failure
distribution — ambient dependency advisories, 26% of all failures, which red `main`'s schedule
and every open PR simultaneously and which no PR author can fix. That is a real problem and it
is out of scope: the remedy is a policy question (advisory triage cadence, allow-list posture,
whether an advisory should block a PR at all) rather than a CI mechanism, and answering it with
a gate before answering it with a policy would produce exactly the always-red gate this
document's precedent warns about.
