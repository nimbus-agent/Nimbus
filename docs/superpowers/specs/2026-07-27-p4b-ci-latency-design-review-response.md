# P4b design review — response

Response to [`2026-07-27-p4b-ci-latency-design-review.md`](./2026-07-27-p4b-ci-latency-design-review.md).

**All three findings are valid.** Two of them changed the design materially, and
the first one corrected a factual claim in the spec's own headline. Each was
checked against the live API rather than reasoned about, because two of the three
have answers that only measurement can give.

| # | Finding | Outcome |
| --- | --- | --- |
| 1 | DAG `needs` inflates `queue` | **Fixed** — and it corrected the spec's headline |
| 2 | 50% tolerance too loose for long jobs | **Fixed**, but by a different mechanism than suggested |
| 3 | Ratchet can lock in an anomalous fast run | **Partly pre-existing, residual risk fixed** |

---

## 1. DAG dependencies — fixed, and it corrected the headline

**The finding is right.** `queue = started_at − run_started_at` charges a
dependent job for its dependencies' execution. `ci.yml` uses `needs:` in ten
places, so this was not hypothetical.

The review's first suggestion — *"investigate if the API has a field indicating
when the job was actually unlocked"* — is exactly the right question, and the
answer is **yes**. The jobs API exposes a per-job `created_at`, and it tracks
**eligibility**, not run start: root jobs are created at `run_started_at`, while
jobs gated by `needs` are created only once their dependencies finish (verified
live — some jobs in a sampled run have `created_at` more than a minute after
`run_started_at`, while all root jobs sit at exactly 0.0).

So the metric becomes, with no documented limitation needed:

```ts
queue = job.started_at − job.created_at   // pure runner contention, DAG-free
dagWait = job.created_at − run.run_started_at  // time blocked by `needs`
```

### This invalidated the spec's central claim

The spec led with *"~80% of the wall-clock is queueing, not computing."* That
figure came from `started_at − run_started_at`, i.e. the conflated metric this
finding is about. Recomputed on the same run (30215198584, 73.8 min total):

| | old (conflated) | corrected |
| --- | --- | --- |
| max "wait" | 58.7 min | — |
| max **DAG wait** | — | 33.9 min |
| max **runner queue** | — | 31.6 min |
| max exec | 12.3 min | 12.3 min |

DAG wait is **not idle time** — it is dependencies doing real work. Counting it
as queueing overstated the contention case. Contention is still substantial
(~30 min, and concentrated almost entirely on **macOS** jobs, which is a
specific and actionable signal), but the headline is now stated correctly.

The spec's conclusion survives: execution is not the binding constraint, so the
design of record's proposed levers still miss. But it survives on a smaller
margin than the original text claimed, and `dagWait` is now a third recorded
metric — because "this run was slow because the DAG is deep" and "because
runners were scarce" have completely different fixes.

---

## 2. Tolerance — fixed, but neither suggested mechanism works

**The finding is right**: at 50%, a 15-minute job needs a 7.5-minute regression
to fail, which is absurd.

Both suggested fixes were tested against measured variance and **both fail**.
Eleven samples per job on `push`-to-default:

| job | median | observed spread (max−min) |
| --- | --- | --- |
| `Static — ubuntu-24.04` | 4.6 min | **0.7 min** |
| `Unit + Coverage — ubuntu-24.04` | 12.2 min | **2.0 min** |
| `Unit + Coverage — windows-2025` | 13.2 min | **14.5 min** |

A global cap (the review's `MAX_ABSOLUTE_LIMIT ≈ 3 min`) would make
`Unit + Coverage — windows-2025` fire constantly: its honest run-to-run spread
is 14.5 minutes. A lower global tolerance (0.25) has the same problem from the
other side. **No single global constant fits both a job that varies by 0.7
minutes and one that varies by 14.5.**

### Resolution: per-key noise band, measured rather than guessed

The collector already gathers N samples per key, so the baseline records the
job's own noise band alongside its median:

```ts
allowedIncrease = max(MIN_ABSOLUTE_DELTA, baseline.spread)
fail when observedMedian > baseline.median + allowedIncrease
```

where `spread` is the p90−median of the baseline window. This is tight exactly
where the data is tight (Ubuntu Unit+Coverage: ~+2 min, so a 4-minute regression
fails — under the old rule it needed 6.1) and lenient exactly where the job is
genuinely noisy, without a hand-picked constant that is wrong for one of them.

`MIN_ABSOLUTE_DELTA` (1 min) survives as the floor, for the reason it existed:
ratios and small bands are both meaningless on a 0.3-minute job.

**Added observation, not a gate:** a key whose spread exceeds 50% of its median
is reported as `unstable`. `Unit + Coverage — windows-2025` qualifies today
(14.5 / 13.2). A job that unpredictable is a real problem — but it is a
*flakiness* problem, and failing a PR for it would punish a contributor for
something their change did not cause. Same rule as `queue`.

---

## 3. Ratchet — premise partly incorrect, residual risk real

**Partly pre-existing.** The spec already ratchets to a *median over the sample
window*, not to a single run, so "a single atypical speedup" cannot by itself
move the baseline — the review's own first suggestion ("require multi-sample
verification") was already the design.

**But the residual risk is real** and worth closing: `MIN_SAMPLES` is 3, and
three consecutive hot-cache runs is an entirely plausible window. Two changes:

- Ratcheting **down** requires `MIN_SAMPLES_FOR_RATCHET` (5) samples — more than
  the 3 needed to *gate*. Lowering a threshold should demand more evidence than
  enforcing one, since the cost of a wrong lower bound is a permanently red gate.
- The recorded `spread` travels down with the median, so a newly-lowered
  baseline keeps its noise band and cannot become unachievable by construction.

The review's second suggestion — manual approval for large drops — is
**deferred**, not rejected. `--update-baseline` is already an explicit human
action producing a reviewable diff, so a second approval step inside a manual
command adds ceremony without adding a check. If a bad ratchet is ever observed
in practice, a `--max-drop` guard is the cheap follow-up.

---

## Not changed

The review's "Strengths" section (exec/queue separation, medians over means,
sparse-sample skipping) needs no response beyond confirming those are load-
bearing and unchanged. The exec/queue split in particular is now *more*
load-bearing, since finding 1 splits it three ways.
