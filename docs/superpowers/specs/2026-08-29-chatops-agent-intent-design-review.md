# ChatOps Agent Intent — Design Review

**Date:** 2026-08-29  
**Reviewer:** Antigravity (AI Coding Assistant)  
**Status:** Under Review  
**Target Spec:** [2026-08-29-chatops-agent-intent-design.md](./2026-08-29-chatops-agent-intent-design.md)  

---

## 1. Summary of Review

The design for **ChatOps Agent Intent — Agents on the Channel** is solid and addresses a critical architectural inversion (letting deterministic agents execute without LLM requirements) and a security gap (unledgered ChatOps replies).

The decomposition into two PRs makes complete sense:

1. **PR 1** plugs the egress ledger gap for all outbound ChatOps posts, ensuring compliance with the spirit of **I29**.
2. **PR 2** extends the intent router to parsed agent commands, leveraging the ledgering layer introduced in PR 1.

Below are specific improvements, suggestions, and open questions to address during implementation.

---

## 2. Improvements & Suggestions

### 2.1 Post Wrapper Context and Signature Change (PR 1)

* **Observation:** In §5.1, the spec proposes wrapping the raw `post` function at `chatops-boot.ts:164`:

  ```ts
  post: (platform: ChatPlatform, channelId: string, text: string) => Promise<void>
  ```

  In §5.3, it is stated that `method` (e.g., `chatops.reply`, `chatops.approvalCard`, or `chatops.agentBrief`) is derived server-side from the call site and is never supplied by the caller.
* **Problem:** Since the `post` closure signature only takes `(platform, channelId, text)`, the wrapper has no way of knowing whether the caller was `ReplyDispatcher` (regular reply or agent brief) or `ApprovalPresenter` (approval card) without parsing the text/layout structure (which is highly fragile and prone to false positives/negatives).
* **Recommendation:** Update the signature of `post` (or pass an optional parameter/metadata) to explicitly declare the post kind, or have `wrapLedgeredChatPost` return specialized handlers (or a structured client interface) instead of a single flat function. For example:

  ```ts
  post: (platform: ChatPlatform, channelId: string, text: string, context?: "reply" | "approvalCard" | "agentBrief") => Promise<void>
  ```

  This guarantees that the exact `method` type is propagated explicitly rather than guessed via heuristics.

### 2.2 Salting the Hashed Channel ID (PR 1)

* **Observation:** The spec suggests hashing the `channel_id` using BLAKE3 to prevent the ledger from becoming a social graph mapping.
* **Risk:** Standard Slack/Teams channel IDs (e.g., `C12345678`) have a low-entropy predictable prefix and length. A simple unsalted BLAKE3 hash can be trivially brute-forced by dictionary/rainbow-table attacks to recover the cleartext room/channel ID.
* **Suggestion:** Salt the channel ID before hashing. The salt could be derived from an existing installation-specific or host-specific secret in the Vault (e.g. the same DPAPI entropy key or a system uuid), ensuring that only the local gateway instance can map the hash back to the channel if needed, while making external leakage/reconstruction impossible.

### 2.3 Handling `NaN` during Coercion (PR 2)

* **Observation:** §6.2 mentions that numeric coercion uses `Number()` which handles floats and integers.
* **Risk:** If a user supplies a value that cannot be parsed as a number (e.g. `depth=three`), `Number("three")` returns `NaN`. Passing `NaN` into the RPC validator could cause unexpected errors or pass type checks unexpectedly if the target validator only asserts `typeof depth === "number"`.
* **Recommendation:** Ensure `agent-commands/parse-agent-command.ts` checks for `Number.isNaN()` after coercing, and returns `bad_agent_params` directly if coercion yields an invalid number.

### 2.4 Truncation Splicing & Preservation of `## Gaps` (PR 2)

* **Observation:** §6.6 requires keeping the `## Gaps` section intact and re-attaching it verbatim, dropping body sections if necessary to fit the byte limits.
* **Suggestion:** Since briefs are formatted as structured markdown, a simple line-based splitter or a regex matching `^##` followed by a space should be used. The parser can identify the `## Gaps` section (and any other target I31 sections), slice the preceding body to fit the budget, and then append the re-assembled gaps footer.

---

## 3. Open Questions

1. **Failure to Ledger on Blocked Write:**
   * If the `egress_ledger` cannot be appended to (e.g., SQLite DB locked or disk full), the wrapper correctly propagates the error and blocks the post. Does the user/channel receive any diagnostic reply indicating that the message failed due to a system ledger error, or does the bot simply drop offline and stay silent?
   * Since this is fail-closed, silence is safer, but it might lead to debugging confusion. Should we log this locally with high visibility?
2. **Peers and Identity Mapping under `public-read`:**
   * The decision to block unmapped users from running agents is excellent. However, what about mapped users in a shared channel who trigger federated requests (e.g. `ghost` or `huddle`)? Do we inherit their local mapped identity and permissions when invoking the remote peers, and is the peer transport aware that this originated from a ChatOps channel?
