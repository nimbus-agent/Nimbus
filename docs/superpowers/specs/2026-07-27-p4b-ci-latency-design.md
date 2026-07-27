# P4b — CI latency: measure before tuning

**Status:** implemented and shipped 2026-07-27 (`audit:ci-latency`).
**Sub-program:** [P4b Latency](../../infrastructure-roadmap.md#sub-programs) — the
last un-started entry in the program.
**Program design of record:** `2026-07-23-org-infrastructure-program-design.md`
(archived; `git show 06c6a144:docs/superpowers/specs/...`).

## The measurement that reframed this

The program's guiding principle #3 is *"reduce latency — but only against
measurement, never against a hunch."* The design of record then offered a hunch:
*"Options: cache tuning, matrix sharding, finer path filters."*

The first real measurement says all three would have missed. Breaking down the
slowest recent `CI` run (30215198584, push, 2026-07-27):

| | |
| --- | --- |
| Total wall-clock | **73.8 min** |
| Longest single job **execution** | **12.3 min** |
| Longest **DAG wait** (blocked by `needs`) | **33.9 min** |
| Longest **runner queue** (true contention) | **31.6 min** |

**Execution is not the binding constraint.** Cache tuning and finer path filters
shorten execution, which is already only ~12 min on the critical path. Matrix
*sharding* would actively make it worse: more jobs contending for the same
runner pool.

Three caveats stated up front, because a single number must not become its own
hunch:

1. **An earlier revision of this spec claimed "~80% of wall-clock is queueing".
   That was wrong**, and the design review caught it. It measured
   `started_at − run_started_at`, which charges a job for its *dependencies'
   execution* as though it were idle waiting. Decomposed correctly, the 73.8 min
   splits into DAG wait (dependencies doing real work) and genuine runner
   contention. The conclusion holds — execution is not the constraint — but on a
   smaller margin than first stated.
2. Contention is concentrated almost entirely on **macOS** jobs, which is a
   specific and actionable signal for the eventual tuning slice.
3. That run happened during a burst with seven PRs in flight, so contention was
   atypically high. One sample cannot separate "slow" from "congested" — which
   is exactly why P4b's gate is *tracking*, not a one-off tune.

## Goal

Per the sub-program's stated gate: **per-job wall-clock tracked; regressions
visible.** This slice delivers the measurement layer and the regression gate. It
deliberately delivers **no tuning** — the design of record puts optimisation
after measurement, and the numbers above show why that ordering was right.

## What is measured

**Three** metrics per job, kept separate, because each has a different cause and
a different fix:

| Metric | Definition | Cause of a regression |
| --- | --- | --- |
| **exec** | `job.completed_at − job.started_at` | slower code, tests, or install |
| **queue** | `job.started_at − job.created_at` | more concurrent jobs, or less concurrency |
| **dagWait** | `job.created_at − run.run_started_at` | a deeper or slower dependency chain |

The third metric and the corrected `queue` definition both come from the design
review. A job's `created_at` tracks **eligibility**, not run start: root jobs are
created at `run_started_at`, while a job gated by `needs` is created only once
its dependencies finish (verified live). So `started_at − created_at` is pure
runner contention with the DAG excluded, and the DAG cost is recorded separately
rather than silently folded into "queue".

This matters because the naive definition (`started_at − run_started_at`)
charges every downstream job for its dependencies' execution, which is what
produced the incorrect "80% is queueing" headline above.

### Only `exec` is gated — `queue` is observed

This is the load-bearing decision of the design.

Queue wait is **not a property of the change under test**. It moves with how many
PRs happen to be open at that moment. A contributor cannot shorten it from their
PR, so gating it would produce reds nobody can action — the failure mode the
infrastructure roadmap now names as an operating rule (*a gate must never report
a permanent mismatch as a fixable failure*), hit four times in the previous
batch.

So `queue` is reported as an informational line and written to the trend file,
where a sustained rise is a signal to the **org owner** (raise concurrency, cut
job count) rather than a red on someone's PR. `exec` is the half that is
genuinely attributable to a change, and only it can fail the gate.

## The two hard problems

Neither is "call the API". Both were found by measuring.

### 1. Sparse sampling

Across the 30 most recent successful runs there are **145 distinct
`workflow::job` keys, of which only 21 have ≥3 samples.** Matrix jobs carry the
OS in their name, and conditional jobs appear only when their path filter fires.
A baseline built from one sweep would be mostly single-sample noise — and worse,
the *slow* jobs that actually matter (Unit + Coverage, ~12 min) are among the
sparse ones.

**Resolution.** A key is gated only when it has at least `MIN_SAMPLES` (3)
successful observations in the window. Keys below that are reported as
`insufficient-data` and **skipped, not failed** — the same permanent-vs-transient
rule as above: too few samples is not a regression, and no amount of retrying
this run creates more history.

To make samples comparable the window is restricted to a **single event class**:
`push` on the default branch. PR runs execute a different job set with different
cache states, so mixing them compares unlike things.

### 2. Runner variance

Variance is wildly uneven across jobs, so **no single global constant works.**
From the shipped, committed baseline (`docs/structure-audit/ci-latency-baseline.json`,
regenerated 2026-07-27), `push`-to-default:

| job | median | observed spread (p90 − median) |
| --- | --- | --- |
| `Static — ubuntu-24.04` | 4.6 min | **0.15 min** |
| `Unit + Coverage — ubuntu-24.04` | 12.2 min | **0.22 min** |
| `Unit + Coverage — windows-2025` | 13.2 min | **10.48 min** |

An earlier revision used a flat 50% tolerance. The review correctly flagged it as
far too loose for long jobs — a 15-minute job would need a 7.5-minute regression
to fail. But the obvious fixes fail too: a global absolute cap (~3 min) would
make `Unit + Coverage — windows-2025` fire constantly, since its *honest*
run-to-run spread is over 10 minutes.

**Resolution — a per-key noise band, measured rather than guessed.** The
collector already gathers N samples per key, so the baseline stores the job's own
spread alongside its median:

```ts
allowedIncrease = max(MIN_ABSOLUTE_DELTA, baseline.spread)   // spread = p90 − median
fail when observedMedian > baseline.median + allowedIncrease
```

Tight exactly where the data is tight (Ubuntu Unit+Coverage: spread 0.22 min,
floored to the 1-minute `MIN_ABSOLUTE_DELTA`, so a 4-minute regression now
fails — under the flat rule it needed 6.1) and lenient exactly where the job is
genuinely noisy. `MIN_ABSOLUTE_DELTA` (1 min) survives as the floor, because
both ratios and small bands are meaningless on a 0.3-minute job.

Medians, never means: a single outlier from a contended run would drag a mean
past any threshold.

**Instability is observed, not gated.** A key whose spread exceeds 50% of its
median is reported as `unstable` — `Unit + Coverage — windows-2025` qualifies
today. A job that unpredictable is a real problem, but it is a *flakiness*
problem; failing a PR for it would punish a contributor for something their
change did not cause. Same rule as `queue`.

## Shape

Mirrors `audit:coverage-floor`, which the repo already knows:

- `scripts/ci-latency/collect.ts` — impure: walks the Actions API for each repo,
  returns raw `JobObservation[]`.
- `scripts/ci-latency/summarize.ts` — **pure**: observations → per-key median
  exec/queue + sample count.
- `scripts/ci-latency/baseline.ts` — **pure**: load/serialise the committed
  baseline, and `computeUpdatedBaseline` (the ratchet).
- `scripts/ci-latency/check.ts` — the `import.meta.main` shell + `--update-baseline`.
- `docs/structure-audit/ci-latency-baseline.json` — the committed baseline,
  alongside the existing `coverage-baseline.json`.

**The ratchet runs in the improving direction.** If a job gets faster, the
baseline drops to the new median on the next `--update-baseline`, so a later
regression from the improved state is caught. It never rises automatically —
that would let latency drift upward one tolerated step at a time, which is the
failure mode a ratchet exists to prevent.

**Lowering demands more evidence than enforcing.** Ratcheting *down* requires
`MIN_SAMPLES_FOR_RATCHET` (7) samples, versus the 3 needed to gate — 7 is
affordable only because sampling is capped per WORKFLOW rather than per repo
(a flat per-repo cap left `CI` with 4 of 30 runs and made every threshold above
5 unreachable). Lowering demands more evidence than gating because the cost of
a wrongly-low bound is a permanently red gate. The recorded `spread` travels
down with the median, so a newly-lowered baseline keeps its noise band and
cannot become unachievable by construction. (A `--max-drop` guard is the cheap
follow-up if a bad ratchet is ever observed; `--update-baseline` is already an
explicit human action producing a reviewable diff, so a second in-command
approval step would add ceremony without adding a check.)

### Scope: org-wide from the start

All 9 audited org repos (the 8-repo `sha-pins` matrix in `org-drift-sweep.yml`
plus `Nimbus` itself, which that matrix excludes only because it is the
checkout host for the other jobs, not an audit target), keyed
`(repo, workflow, job)`. The roadmap's founding observation is that controls
stop where they were written, and a Nimbus-only latency gate would be the
fifth instance of exactly that. API cost is bounded: one `runs` call per repo
(`RUN_LIST_PAGE` = 100, the API max in one page) plus one or more `jobs` calls
per sampled run, capped at `MAX_RUNS_PER_WORKFLOW` (12) runs per workflow —
capping per workflow rather than per repo is what makes `MIN_SAMPLES_FOR_RATCHET`
(7) reachable at all.

### Where it runs

A new `ci-latency` job on `org-drift-sweep`, `--strict`, reusing the
`_gh-audit.ts` contract (fail soft locally, hard in CI, `classifyReadFailure`
for reads). Not in the preflight fast tier: it needs network and says nothing
about the diff under test.

## Failure model

Unchanged from the rest of the program, and fail-closed in the same direction:

- Unreadable run or job list → `indeterminate`, never a finding.
- Fewer than `MIN_SAMPLES` observations → `insufficient-data`, skipped.
- A key in the baseline that no longer appears (a renamed or deleted job) →
  reported as `stale-baseline-entry`, **not** a failure; the fix is
  `--update-baseline`, not a red on an unrelated PR.
- A key observed but absent from the baseline → recorded on the next
  `--update-baseline`; never a failure on first sight.
- Under `--strict`, a run where nothing was evaluable is red (the existing
  team-reachability rule) — except when every read SUCCEEDED and the window
  simply held no eligible job. That is reported as "no CI activity to measure,
  not an auth failure", because the default wording blames the token and would
  send whoever reads the sweep hunting a credential that is fine.
- **A partial sample is worse than no sample.** Failed job-list reads are
  counted, not merely tolerated: the survivors of a partial collection are
  whichever runs happened to succeed, so their median can be biased and the gate
  could manufacture a regression from it. Past `MAX_READ_FAILURE_RATIO` (25% of
  attempts) the run **skips gating entirely** rather than gate on degraded data.
  A failed run-*list* read counts as one attempt and one failure, so losing a
  whole repo can trip the guard.
- **The `created_at` eligibility assumption is monitored, not assumed.** If no
  observation anywhere carries a non-zero `dagWait`, the run warns that the
  assumption may have changed. It cannot prove this — it observes the signal
  (zero `dagWait` everywhere), not the cause (whether any sampled workflow
  declares `needs:`), and it warns rather than fails, because an upstream API
  change is not something a contributor can fix.

## Expected outcome on arrival

**Green, with an informational queue line.** Unlike the P2 and pin-freshness
gates there is no pre-existing drift to catch: the baseline is generated from
current reality, so by construction nothing exceeds it on day one.

That makes the red-proof a **unit-test** obligation rather than a live one: a
fixture whose median exceeds baseline past both thresholds must fail, and one
that exceeds only the ratio or only the absolute delta must pass. The live run
is the green-after half only.

The first genuinely useful output is the **queue and DAG-wait observations**,
which already have a finding to report: on the sampled 73.8-minute run the
longest runner queue was 31.6 min and the longest DAG wait 33.9 min, against a
longest single-job execution of 12.3 min. Both are owner-actionable in different
ways — contention says raise concurrency or cut job count, DAG wait says shorten
the dependency chain — and together they are the input the eventual tuning slice
must be justified against.

(An earlier revision summarised this as "~80% of wall-clock is contention".
That restated the same error the caveat at the top of this document corrects:
it folds DAG wait, which is dependencies doing real work, into contention. The
two maxima belong to different jobs and cannot be added, so no single percentage
describes the run.)

## Out of scope

- **Any tuning.** Cache changes, sharding, path filters, concurrency limits.
  The design of record puts these after measurement; this slice *is* the
  measurement. Acting now would be the hunch the principle forbids.
- **A latency dashboard** — that is P5's remaining half, and it should render
  this data rather than collect its own.
- **Per-step timings.** Job granularity is enough to locate a regression; step
  granularity multiplies API cost and baseline churn for little gain.
- **Self-hosted runners** as a concurrency fix — a real option, but a
  cost/security decision for the owner, not a gate.
