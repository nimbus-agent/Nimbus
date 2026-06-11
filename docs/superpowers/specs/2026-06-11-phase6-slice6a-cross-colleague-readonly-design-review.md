# Phase 6 Slice 6a — Cross-colleague Intelligence (read-only) — Design Review

This document lists open questions, suggestions, and potential improvements identified during the review of the [2026-06-11-phase6-slice6a-cross-colleague-readonly-design.md](./2026-06-11-phase6-slice6a-cross-colleague-readonly-design.md) specification.

---

## 1. Open Questions

### Q1: Cold-Start UX & Namespace Discovery

- **Context:** The design introduces the `federation_known_namespaces` cache table to store successfully queried namespaces per peer. If the cache is empty, the default sweep fails with a gap note asking the user to manually supply `--namespace <name>`.
- **Questions:**
  - Is there a way to auto-bootstrap this cache or query for available namespaces? If namespace discovery is strictly out of scope (per non-goals), how does the user initially discover which namespaces exist on their peers' machines?
  - Can pairing or mDNS advertisement exchange a list of active public namespaces, or must this exchange happen entirely out-of-band (e.g. over Slack/Teams)?

### Q2: Interactive Consent Prompts & Timeout Latency

- **Context:** If a peer has interactive (non-standing) consent, the owner of that peer will be prompted for consent when `nimbus huddle` or another ambient tool queries their machine.
- **Questions:**
  - If a peer's owner is AFK or ignores the prompt, the query will block on the asker side until `consentTimeoutMs` expires (which could be up to 10–30 seconds). Since the fan-out primitive aggregates all peers, does this mean one unresponsive peer can slow down the entire asker command to the maximum timeout limit?
  - Should there be a shorter, agent-specific timeout for interactive consent (e.g., 2000ms) when doing ambient sweeps?
  - Does the gateway support a "silently ignore" or "decline if not cached" option for background/ambient queries to prevent interrupting peers?

### Q3: Cross-Machine path / Entity Resolution

- **Context:** `nimbus ghost <file>` and `nimbus conflicts <file>` require resolving a local file to a graph entity and querying peers for information about it.
- **Questions:**
  - How are file paths resolved across different colleagues' machines? If user A has `C:\gitrep\Nimbus\src\main.ts` on Windows and user B has it at `/Users/bob/projects/Nimbus/src/main.ts` on macOS, how does the query identify the same entity?
  - Does the start entity resolution convert paths to a repository-relative path (e.g., `src/main.ts`) or use a different mechanism (e.g., code symbol names, git tracking IDs)?

### Q4: Concurrency in `peer-fanout.ts`

- **Context:** Section 11 notes that sequential per-peer wire calls bound the brief latency.
- **Questions:**
  - Will the fan-out helper execute queries in parallel (e.g. via `Promise.all` with a concurrency limit) or strictly sequentially?
  - If sequentially, what is the maximum duration we will wait before giving up on the remaining peers?

---

## 2. Suggestions & Improvements

### S1: Cache Cleanup and Eviction for Known Namespaces

- **Problem:** If a peer is unpaired, changes their IP, or deletes a namespace, the stale rows in `federation_known_namespaces` will remain in the SQLite database indefinitely.
- **Suggestion:** Add an automatic pruning hook. When a peer is unpaired, or when `listLanPeers()` shows a peer is no longer known, delete their corresponding rows from `federation_known_namespaces`. Additionally, add a last-seen cleanup to prune rows older than 30 days.

### S2: Parallel Fan-out with Bounded Concurrency

- **Problem:** Sequential querying scales poorly with the number of paired peers.
- **Suggestion:** Implement bounded parallel queries using a concurrency limiter (e.g., a simple promise pool helper). This ensures that we query up to e.g. 5 peers simultaneously, minimizing overall latency while avoiding socket starvation or connection spikes.

### S3: Normalizing and Deduplicating Contacts

- **Problem:** Multiple peers might return the same expert with varying relevance or different display names.
- **Suggestion:** Standardize the suggested contacts formatting during post-filtering on the asker side. Deduplicate contacts by email/identity and select the highest ranking context/display name.
