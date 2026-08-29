# ChatOps Egress Ledger — Plan Review

**Date:** 2026-08-29  
**Reviewer:** Antigravity (AI Coding Assistant)  
**Status:** Under Review  
**Target Plan:** [2026-08-29-chatops-egress-ledger.md](./2026-08-29-chatops-egress-ledger.md)  

---

## 1. Summary of Review

The implementation plan for **PR 1: ChatOps Egress Ledger** is extremely precise and maps out the implementation steps logically. The factory approach to wrapping the raw post client (`buildLedgeredChatPosts`) cleanly solves the challenge of deriving the `method` context server-side without modifying the caller signatures or guessing context from payload heuristics.

One critical logical vulnerability has been identified in the proposed AST/regex rule for **D17** (Task 5), along with minor design suggestions.

---

## 2. Improvements & Suggestions

### 2.1 Critical Bug in D17 Regex Bypass (Task 5)

* **Observation:** The proposed static rule `checkChatopsUnwrappedPost` in Task 5 performs this check:
  ```ts
  if (!UNWRAPPED_POST_RE.test(stripped)) continue;
  if (WRAPPED_POST_RE.test(stripped)) continue;
  ```
* **Risk:** If a file contains **both** a wrapped call to `buildConnectorPost` and an unwrapped call to `buildConnectorPost`, `WRAPPED_POST_RE.test(stripped)` will be `true`, causing the scanner to skip the file entirely and miss the unwrapped call.
* **Recommendation:** Instead of a file-level early return, count the occurrences of both tokens in the file, or check each occurrence individually. Since every valid use of `buildConnectorPost` must be wrapped, the simplest check is asserting that the total count of `buildConnectorPost` matches the total count of `buildLedgeredChatPosts` in non-test files:
  ```ts
  const unwrappedCount = (stripped.match(/\bbuildConnectorPost\s*\(/g) || []).length;
  const wrappedCount = (stripped.match(/\bbuildLedgeredChatPosts\s*\(/g) || []).length;
  if (unwrappedCount > wrappedCount) {
    // Report violation: there is at least one unwrapped call
  }
  ```
  This is much more robust and prevents file-level skips when both patterns are present.

### 2.2 Vault Write Failures in `ensureChannelSalt` (Task 2)

* **Observation:** If the vault DPAPI/libsecret storage fails or is read-only at runtime, `vault.set` will throw.
* **Suggestion:** Since `ensureChannelSalt` is called during the boot path (`chatops-boot.ts`), a Vault write failure will block the bot from starting. This is the correct fail-closed posture, but we should make sure that the boot logs clearly distinguish a vault write failure from other connection errors to aid diagnostics.

---

## 3. Open Questions

1. **Uniqueness of Salt Across Multi-Gateways:**
   * If a user runs multiple Nimbus Gateway instances sharing the same database but separate local Vaults (e.g. on different local user accounts or machines), the channel hashes will differ between instances.
   * Since `nimbus prove` runs locally on the database, this is fine (each instance ledgers its own actions with its own salted hashes), but it means we cannot correlate channel activity *across* distinct physical machines using the hashes. This is expected and aligns with the local-first security model, but is worth keeping in mind.
