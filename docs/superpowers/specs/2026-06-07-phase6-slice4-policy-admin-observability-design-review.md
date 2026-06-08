# Phase 6 Slice 4 Design Review

**Date:** 2026-06-07
**Target:** [2026-06-07-phase6-slice4-policy-admin-observability-design.md](./2026-06-07-phase6-slice4-policy-admin-observability-design.md)

## Status Update (2026-06-07)

The design has been updated to address all 5 open points from the initial review:

1. **Line ending normalization:** Solved in §4.2.1 via `policy-signing.canonicalize(toml)` (LF conversion, BOM-stripping, trailing whitespace cleanup).
2. **Monotonicity policy updates:** Clarified in §4.3 R3 (stricter relative to the local baseline, allowing admins to scale back down to defaults without a high-water mark lock-in).
3. **GDPR purge offline peer durability:** Solved in §9.1 via a database-persisted job/request queue in `policy-store` retried during sync cycles.
4. **`/metrics` authentication:** Clarified in §6 (requires bearer token, matching read surface security).
5. **Static console build lifecycle:** Solved in §7.1 (using `bun build` and build pre-flight assertions).

All resolutions have been integrated into the design and are listed in §15.

---

## Remaining Considerations & Minor Suggestions

1. **Purge Ledger Lifecycle & Database Growth**
   * **Question:** The new `gdpr_purge_job` and `gdpr_purge_request` tables store completed purges and their signed deletion records.
   * **Suggestion:** Since completed deletion records are also written to the audit chain, is there a retention policy for these table records? Once a job is marked `done` and the audit entry is written, the raw table rows are mostly historical. It is recommended to keep them indefinitely as a ledger of purges but document their size impact (which should be negligible, as purge events are rare).

2. **TOML Formatting Sensitivity in Canonicalization**
   * **Observation:** The canonicalization removes line-ending and whitespace differences but does not parse the TOML structure itself. This means changes in comments or whitespace between keys (even if semantically identical in TOML) will alter the signature.
   * **Note:** This is the correct approach to avoid complex TOML AST reconstructions, but developers editing the file manually must be reminded that *any* character change requires running `nimbus policy sign` to update the detached signature.

3. **Prometheus Scraping Token Access**
   * **Suggestion:** Since `/metrics` requires the Gateway's bearer token, document how the user or scraper configuration is expected to retrieve this token securely (e.g., exposing a CLI command to query it, similar to `nimbus admin status` or reading it from a configured environment variable/file).
