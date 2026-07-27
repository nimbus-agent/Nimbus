# P4b — CI latency Implementation Plan: Review

## 1. Job `created_at` behavior in GitHub Actions API

The plan relies on:

```ts
const queue = minutesBetween(j["started_at"], j["created_at"]);
const dagWait = minutesBetween(j["created_at"], runStartedAt);
```

### Open Question

Does the GitHub Actions API set `created_at` for a job when it is *eligible* to run (after dependencies are resolved), or when the *workflow run* itself is created?

In GitHub Actions, the workflow run engine generally creates all jobs in the run database at the very start of the workflow execution. Therefore, `j["created_at"]` is typically identical (or very close) to the workflow run's `run_started_at` for all jobs, including downstream ones.

If this is the case:

- `dagWait` will evaluate to `0` for all jobs.
- `queue` will evaluate to `started_at - run_started_at`, which still includes the execution time of all upstream dependencies.

### Recommendation

- **Verification**: Run a manual query or check existing API responses for a workflow run with dependencies to verify whether `created_at` differs for downstream jobs.
- **Alternative**: If `created_at` is indeed fixed to the run start time, we may need to reconstruct/parse the DAG dependencies (e.g. from workflow YAML or by finding the completion time of the jobs listed in `needs`) to calculate true queue/concurrency wait vs. DAG wait.

---

## 2. API Call Performance and Rate Limits

The collector walks 9 repositories, fetches the last 30 runs for each, and then fetches the jobs for each of those runs:

- `9` repos × `1` run list query = `9` requests.
- `9` repos × `30` runs × `1` jobs query = `270` requests.
- Total API calls = `279` requests.

### Suggestions

- **Sequential Latency**: Executing 279 sequential `gh api` calls will take around 1–3 minutes depending on network latency. Since this runs in a background sweep (`org-drift-sweep`), this is acceptable, but sequential execution could be optimized.
- **Rate Limit Safety**: The default GITHUB_TOKEN has a rate limit of 1,000 requests per hour per repository (for GitHub Actions). 279 requests is well within this limit, but if more repos or runs are added, it could approach the limit.
- **Recommendation**: Ensure the collector handles rate limit headers gracefully or exits early with a clear warning instead of throwing unhandled exceptions if rate limits are hit.

---

## 3. Ratchet Stability on Small Sample Sets

In `baseline.ts`:

```ts
if (prev && s.execMedian < prev.execMedian && s.samples < MIN_SAMPLES_FOR_RATCHET) {
  entries.set(key, prev);
  continue;
}
```

If `s.samples >= MIN_SAMPLES_FOR_RATCHET` (5 samples), the baseline is aggressively ratcheted down.

### Suggestions

- A sample size of 5 is still relatively small. A single run with an exceptionally fast runner or hot caches might bias the median downwards.
- **Recommendation**: Consider setting `MIN_SAMPLES_FOR_RATCHET` to a slightly higher value (e.g., 7 or 10) to ensure a highly stable improved baseline before ratcheting down.
