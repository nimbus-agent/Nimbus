# Spec Review: Phase 6 Slice 6c — Tribal-Knowledge Extraction (design)

**Review Date:** 2026-06-12  
**Reviewer:** Antigravity (AI Coding Assistant)  
**Target Spec:** [2026-06-12-phase6-slice6c-tribal-knowledge-design.md](./2026-06-12-phase6-slice6c-tribal-knowledge-design.md)

---

## 1. Security & Privacy Considerations (Crucial)

### 1.1 Private/Restricted Channels & DM Data Leakage

- **Observation:** The local owner indexes history across all Slack/Teams channels they are part of (including private channels, group DMs, or direct messages).
- **Risk:** If a repeated question occurs in a shared/public channel, the vector search might pull semantically similar threads or answers from a private channel or DM that the local owner has access to, but other team members do not. The Synthesizer might then draft a KB page containing private info and citation deep-links to private messages, which are written to a shared team KB (Notion/Confluence).
- **Suggestions:**
  1. **Source Filtering:** Explicitly restrict the vector search / index retrieval in `answer-synthesizer.ts` to only search messages from public/shared channels, OR:
  2. **Visual Warning:** Highlight in the local owner's HITL gate if any of the citation/thread sources originate from a private channel or direct message, enabling the owner to vet it before publication.
  3. **Metadata Check:** Ensure `repeat-detector.ts` checks the channel types in the database before grouping/recalling messages.

---

## 2. Architecture & Pipeline Refinements

### 2.1 Handling Chat Message Updates & Deletions

- **Observation:** Watcher receives all channel messages.
- **Question:** What happens when messages that contributed to a cluster are edited or deleted in the chat application?
- **Suggestion:**
  - To keep the system simple (YAGNI), the pipeline should rely on the snapshot of the local SQLite index at query time rather than trying to sync deletions in real-time.
  - If a message is deleted, the vector search will simply not return it during the recall step (once the sync runner updates the database).

### 2.2 Vector Search & Embedding API Rate Limits / Costs

- **Observation:** Watching *all* messages in active Slack/Teams channels means running them through the question classifier (`is-question.ts`) and, if positive, generating an embedding for `repeat-detector.ts`.
- **Question:** If a team is highly active, this could result in thousands of embedding API calls daily. How do we prevent excessive LLM costs?
- **Suggestions:**
  - Enforce a strict rate-limiting / throttling mechanism on the embedding generator.
  - Optimize the cheap `is-question.ts` regex/rule-based classifier to filter out as much noise as possible before calling the embedding model.
  - Document this cost implication in the user setup guide.

### 2.3 Cluster Merging & Near-Duplicates

- **Observation:** If the `match` config is set to `"embedding"`, two clusters with slightly different wording might both fire and create duplicate suggestions.
- **Question:** How do we handle overlapping/near-duplicate clusters?
- **Suggestion:**
  - When a cluster is marked as `captured` or `dismissed`, its representative vector or a set of vectors should be used to automatically suppress/ignore near-duplicate candidate clusters or route them to the same cooldown period.

---

## 3. Configuration & Multi-Target Resolution

### 3.1 Resolving Target in `capture` Command

- **Observation:** Both Notion and Confluence can be configured simultaneously in `nimbus.toml`.
- **Question:** When calling `nimbus tribal capture <cluster-id>` or the corresponding IPC method, how does the system decide which KB target to write to?
- **Suggestion:**
  - Add an optional `--target` flag (e.g. `nimbus tribal capture <cluster-id> --target notion`) which defaults to the only configured target if only one is present, or prompts the user if both are available.
  - Since both targets are resolved from the local configuration file (meeting the **I25** invariant requirements), allowing the caller/command to specify a target choice (Notion vs. Confluence) does not compromise security.

### 3.2 Cooldown State Behavior

- **Observation:** Cooldown suppresses re-suggestion for a period.
- **Question:** If a cluster enters cooldown and a new, exact match of the question appears, does the cooldown timer reset or extend?
- **Suggestion:**
  - Keep cooldowns simple: the cluster stays in the cooldown state until `cooldown_until` passes, ignoring new occurrences during this window. Once the cooldown expires, the occurrence count resets back to 0 or starts counting fresh.

---

## Dispositions (2026-06-12, design author)

All 7 points **accepted (FIX)** — none deferred. The two substantive ones (§1.1, §2.3) materially
hardened the design; the rest tightened under-specified behavior. Spec updated in
`2026-06-12-phase6-slice6c-tribal-knowledge-design.md`.

| # | Disposition | Resolution in spec |
|---|---|---|
| **1.1 Private/DM leakage** | **FIX (substantive)** | Made `watch_channels` an **authoritative allowlist scoping the whole pipeline** — detection recall *and* synthesis source-retrieval both filter to `channel_id ∈ watch_channels`, so a private/DM thread can never become a cluster member or a citation. **Required non-empty when enabled** (boot fails closed; no "watch everything"). HITL approval card lists each citation's channel for provenance vetting. → design §2.1, §3, §4. *Chose the structural allowlist over a channel-type metadata check (suggestion #3) because it doesn't depend on the index recording public-vs-private channel type, and over a warning-only approach (#2) because the owner-enumerated allowlist is a hard boundary, with the warning as defense-in-depth.* |
| **2.1 Edits/deletions** | **FIX (adopt as-is)** | Adopted the reviewer's YAGNI answer verbatim: index-snapshot at query time; deletions drop out after the next connector sync; no bespoke real-time deletion tracking. → design §2.3. |
| **2.2 Embedding cost** | **FIX (clarify)** | Documented that embeddings default to **local MiniLM (no API cost)**; an API cost arises only with OpenAI embeddings configured. The cheap `is-question.ts` gate pre-filters before any embedding, and the embedding path reuses the existing rate-limiter; cost note goes in the setup guide. → design §2.3. |
| **2.3 Cluster merging** | **FIX (substantive)** | Specified **nearest-existing-cluster-within-threshold assignment before creating a new cluster**, and captured/dismissed clusters **absorb near-dup candidates into their cooldown**. Fixes embedding-only double-firing. → design §2.2. |
| **3.1 Multi-target resolution** | **FIX (adopt)** | `capture --target notion\|confluence`; defaults to the sole configured target; **errors (never silent-picks) when both are configured and `--target` is omitted**. Confirmed this does **not** weaken I25 — both are config-resolved destinations; the caller selects only *which configured KB*, never a page. → design §3.1, §7. |
| **3.2 Cooldown behavior** | **FIX (adopt)** | Cooldown stays until `cooldown_until`; in-window occurrences are **ignored (not reset/extended)**; counting **restarts fresh** after expiry. → design §3. |
