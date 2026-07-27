# P4b — CI latency: design review

## 1. DAG Job Dependencies and Queue Metrics

The current formula for the `queue` metric is defined as:

```text
queue = job.started_at − run.run_started_at
```

### Problem

In GitHub Actions workflows, jobs can have logical execution dependencies using the `needs` keyword (e.g., `test` depends on `build`). If `build` takes 5 minutes to run, the `test` job cannot start until minute 5.

Under the proposed definition, `test` will record at least 5 minutes of `queue` time, even if there is zero runner queue contention and the runner starts it immediately. This conflates logical DAG execution time with queue/runner contention, leading to misleading queue observations for all downstream jobs.

### Suggestions

- **API Check**: Investigate if the GitHub API job object has a field indicating when the job was actually unlocked/queued versus when it started (e.g., if there is a `started_at` and `created_at` that shifts for dependent jobs, or a queue time in the workflow run events).
- **Document/Acknowledge Limitation**: If the GitHub Actions API does not expose the unlocked timestamp, explicitly document that downstream jobs in a DAG will show inflated `queue` times that reflect the execution time of their dependencies.
- **Alternative (Future)**: Filter or group queue metrics by root jobs (jobs with no `needs` dependencies) to get an accurate representation of actual runner contention.

---

## 2. High Tolerance for Long-Running Jobs

The gate criteria requires:

- `median > baseline × (1 + TOLERANCE)` (where `TOLERANCE = 0.5`) AND
- `absolute_delta > MIN_ABSOLUTE_DELTA` (where `MIN_ABSOLUTE_DELTA = 1 minute`)

### Problem

While a 50% tolerance is highly effective at preventing noise/flakiness on short jobs, it becomes very loose for long-running jobs:

- A 2-minute job requires a 1-minute increase to fail (reasonable).
- A 15-minute job requires a **7.5-minute** increase to fail. A 7-minute regression in the main test suite is massive, yet it would bypass this gate.

### Suggestions

- **Sliding or Capped Tolerance**: Implement a tolerance that scales down for longer baselines, or cap the maximum allowed absolute increase. For example:

  ```ts
  const maxAllowedIncrease = Math.min(baseline * TOLERANCE, MAX_ABSOLUTE_LIMIT); // e.g., MAX_ABSOLUTE_LIMIT = 3 minutes
  ```

- **Grade-Based Tolerance**: Use a lower `TOLERANCE` (e.g., 0.25) combined with the absolute minimum floor to protect against short-job noise, while keeping a tighter rein on longer jobs.

---

## 3. Ratchet Mechanics & Baseline Drift

The design specifies that the baseline ratchets down immediately in the improving direction:
> "If a job gets faster, the baseline drops to the new median on the next `--update-baseline`"

### Problem

If a single run experiences an atypical speedup (e.g., due to an exceptionally hot cache, a partial run, or a temporary runner speedup), `--update-baseline` will lock in this abnormally fast execution time as the new baseline. Subsequent normal runs will then fail the gate as regressions.

### Suggestions

- **Require Multi-Sample Verification**: Ensure that the improved baseline is also calculated over a median of multiple recent runs (e.g., `MIN_SAMPLES` runs of the faster version), rather than a single run or a temporary state.
- **Conservative Ratcheting**: Allow a buffer when ratcheting down, or require manual verification/approval for significant baseline drops to avoid setting an unachievable threshold.

---

## 4. Strengths of the Design

- **Separation of Exec vs. Queue**: Decoupling the two metrics is excellent and prevents PR contributors from being penalized for runner pool congestion.
- **Median vs. Mean**: Using medians correctly avoids outlier distortion.
- **Sparse Sampling Handling**: Skipping keys with `< 3` samples prevents false positives due to matrix/conditional job noise.
