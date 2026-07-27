# P4b — CI latency: measure before tuning

**Status:** design approved 2026-07-27, not yet implemented.
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
| Longest job **wait for a runner** | **58.7 min** |
| Summed execution across all jobs | 166.5 min |

**About 80% of the wall-clock is queueing, not computing.** Cache tuning and
finer path filters shorten execution, which is not the binding constraint.
Matrix *sharding* would actively make it worse: more jobs contending for the
same runner pool. The binding constraint is total queued job-minutes against
available concurrency.

Two caveats stated up front, because a single number must not become its own
hunch:

1. That run happened during a burst with seven PRs in flight, so contention was
   atypically high. One sample cannot separate "slow" from "congested" — which
   is exactly why P4b's gate is *tracking*, not a one-off tune.
2. Run-level admission queueing is **zero** (`run_started_at == created_at` on
   every sampled run). The waiting is per-*job*, waiting for a runner.

## Goal

Per the sub-program's stated gate: **per-job wall-clock tracked; regressions
visible.** This slice delivers the measurement layer and the regression gate. It
deliberately delivers **no tuning** — the design of record puts optimisation
after measurement, and the numbers above show why that ordering was right.

## What is measured

Two metrics per job, kept **separate**, because they have different causes and
different fixes:

| Metric | Definition | Cause of a regression |
| --- | --- | --- |
| **exec** | `job.completed_at − job.started_at` | slower code, tests, or install |
| **queue** | `job.started_at − run.run_started_at` | more concurrent jobs, or less concurrency |

Conflating them is what produced the misleading "CI takes 74 minutes" reading.

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

Even trivial jobs vary **1.3–1.9×** run-to-run (measured over the same window).
A percentage threshold tight enough to catch a real 20% regression would fire
constantly on noise, and a flaky gate is an ignored gate.

**Resolution.** A key fails only when **both** conditions hold:

- the observed median exceeds `baseline × (1 + TOLERANCE)` (TOLERANCE = 0.5), and
- the absolute increase exceeds `MIN_ABSOLUTE_DELTA` (1 minute).

The absolute floor exists because ratios are meaningless on fast jobs: a
0.3 min → 0.5 min job is +67% and completely irrelevant. Requiring both means the
gate fires on "this job got materially slower", not on "this job jittered".

Medians, never means: a single 58-minute outlier from a contended run would drag
a mean past any threshold.

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

### Scope: org-wide from the start

All 8 public org repos, keyed `(repo, workflow, job)`. The roadmap's founding
observation is that controls stop where they were written, and a Nimbus-only
latency gate would be the fifth instance of exactly that. API cost is bounded:
one `runs` call per repo plus one `jobs` call per sampled run, capped at
`MAX_RUNS_PER_REPO` (30), so ~250 requests against a 5000/hr authenticated
limit.

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
  team-reachability rule).

## Expected outcome on arrival

**Green, with an informational queue line.** Unlike the P2 and pin-freshness
gates there is no pre-existing drift to catch: the baseline is generated from
current reality, so by construction nothing exceeds it on day one.

That makes the red-proof a **unit-test** obligation rather than a live one: a
fixture whose median exceeds baseline past both thresholds must fail, and one
that exceeds only the ratio or only the absolute delta must pass. The live run
is the green-after half only.

The first genuinely useful output is the **queue observation**, which already
has a finding to report: ~80% of wall-clock is contention, which is an
owner-actionable signal (raise concurrency or cut job count) and the input the
eventual tuning slice must be justified against.

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
