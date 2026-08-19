# Review & Feedback: `nimbus stats` Design

This document reviews [2026-08-19-nimbus-stats-design.md](./2026-08-19-nimbus-stats-design.md) and compiles open questions, suggestions, and potential improvements.

---

## 1. Questions & Clarifications

### Time Window vs. Bucket Durations

* **Validation:** What behavior should occur if `--window` is smaller than `--bucket` (e.g., `--window 3d --bucket 1w`)?
  * *Suggestion:* The command should throw a validation error or warn the user rather than returning a single truncated bucket.
* **Duration Formats:** Which time-parsing utility will be used to parse intervals (e.g., `90d`, `1w`, `24h`)? We should ensure the syntax is fully unified with duration parsers used elsewhere in the Gateway.

### Performance of Iterative DORA Calculation

* **Sequential Queries:** For a large number of buckets (e.g., `--window 90d --bucket 1d` yields 90 buckets), executing the existing DORA calculators sequentially means running 90 separate SQLite queries.
  * *Question:* Is there any risk of query/response latency for local databases? Should there be a cap on the maximum number of buckets (e.g. max 100 buckets) to prevent performance degradation or DOS-like behavior on large databases?

### Security Invariants & Egress Ledger (I29)

* *Question:* Since `metrics.stats` operates purely on the local SQLite database and does not perform outbound connector actions or remote LLM synthesis, it is expected to be exempt from egress ledger logging (similar to `metrics.dora` or local reindexing). Can we explicitly record this in the spec to prevent future security compliance doubts?

---

## 2. Recommended Improvements & Suggestions

### Improving UX of Arithmetic Buckets

* **Calendar Alignment Alternative:** Since buckets walk backward from the request time without calendar alignment, the time windows for the same query (e.g., `--bucket 1w`) will shift depending on the day and hour the command is run. This makes comparing charts or outputs from different days difficult.
  * *Suggestion:* Consider a future option `--align` (or default behavior) that snaps bucket boundaries to calendar boundaries (e.g., beginning of the UTC day/week) if the user specifies standard units.

### Unifying PR Metadata Fields (GitLab / Bitbucket)

* **Standardizing `merged_at` / `created_at`:** In future work to bring GitLab and Bitbucket parity for `pr-merges`, we should define a common schema structure within `item.metadata` (e.g., `metadata.merged_at` as epoch milliseconds) to prevent database queries from having connector-specific paths.

### Potential Metrics to Add Later

* **PR Open Rate (`pr-opened`):** Similar to `pr-merges`, a metric for PR creation rates would be useful. If we capture `created_at` in the metadata, we could easily compute `pr-opened`.
