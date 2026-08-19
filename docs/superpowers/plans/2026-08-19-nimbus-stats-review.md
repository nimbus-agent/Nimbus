# Review & Feedback: `nimbus stats` Implementation Plan

This document reviews [2026-08-19-nimbus-stats.md](./2026-08-19-nimbus-stats.md) and compiles open questions, suggestions, and potential improvements for the implementation steps.

---

## 1. Task 2: Metric Registry & `incidents-opened` Implementation

### Event Timestamp for `incidents-opened`

* **Context:** The plan notes that `incidents-opened` should count incident rows whose `metadata.opened_at_ms` falls in `[startMs, endMs)`.
* **SQL Optimization vs. Fallback:**
  * In `dora.ts`, the incident selection reads:

        ```ts
        const openedRaw = meta["opened_at_ms"];
        const opened = typeof openedRaw === "number" ? openedRaw : r.synced_at;
        ```

  * If we optimize the SQL query using `json_extract(i.metadata, '$.opened_at_ms')` to filter in SQL directly, we might miss incidents that fell back to `synced_at` (because `opened_at_ms` was missing or not a number).
  * *Recommendation:* In `packages/gateway/src/metrics/stats.ts`, the query for `incidents-opened` should load the metadata and calculate the actual opened timestamp (incorporating the `synced_at` fallback logic) in JS/TS, or use a SQL fallback like `COALESCE(json_extract(i.metadata, '$.opened_at_ms'), i.synced_at)`.
* **Resolution Status:** DORA MTTR and change failure rate only consider *resolved* incidents (`meta?.["status"] === "resolved"`). For `incidents-opened`, we likely want to count **all** incidents opened in that window, including those that are still open or unresolved. The implementation details should clarify whether we filter by status or include unresolved incidents.

---

## 2. Task 3: Error Handling mapping in IPC

* **Context:** `dispatchMetricsRpc` is modified to catch `StatsBucketError` and convert it to a `MetricsRpcError(-32602, ...)`.
* **Suggestion:** Ensure that any other validation errors arising from the CLI parameters or database query failures are cleanly mapped. Since this is a local-only RPC interface, ensuring that the error messages are descriptive (naming the service, the metric, or the bounds) will be highly valuable for the CLI to print a clean error rather than a generic RPC stack trace.

---

## 3. Task 4: CLI Rendering details

* **Format of `—` / `null` values:** The plan states that a `null` value prints as `—` with its gap in a trailing column.
* **Suggestion:** If a series contains mostly nulls (due to sparse data or `low_sample`), the table could look empty. Adding a summary line at the bottom or a header stating the percentage of complete buckets or the gap reason can help guide the user.
