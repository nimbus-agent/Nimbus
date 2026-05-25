# Docs & Roadmap Enhancements Design Review

**Date:** 2026-05-25

This document captures open questions, suggestions, and potential improvements based on a review of the `2026-05-25-docs-roadmap-enhancements-design.md` specification.

## Open Questions

1. **Proposed I17 Taint Tracking Mechanism:**
   * *Question:* Item ④ proposes a taint barrier (I17) where attacker-influenceable tool output cannot satisfy standing approvals. How is this "taint" technically tracked? Will it rely on a complex dynamic taint tracking system within the TypeScript runtime, or will it be a simpler metadata-driven provenance tag attached to the indexed rows and tool envelopes? 

## Suggestions & Improvements

1. **WAL Invariant Enforcement:**
   * *Suggestion:* Item ② flags that `PRAGMA journal_mode = WAL` is missing and tracks the fix separately. Once that fix is implemented, there should be a static or runtime invariant added (e.g. to `check-nimbus-invariants.ts` or a new test) to explicitly ensure WAL mode remains enabled across all SQLite connections, preventing future regressions in concurrency.

2. **Model Weight Integrity Strictness:**
   * *Suggestion:* In Item ③, the plan for model weight integrity mentions that it will "warn on drift" if the local GGUF digest doesn't match the pinned known-good digest. Given that a compromised model represents a total compromise of the agent's reasoning (and therefore its security boundaries), it might be safer to offer a "strict mode" where the gateway explicitly refuses to boot or execute inference if the signature/digest verification fails, rather than just warning.

3. **M7 Egress Ledger Tamper-Evident Clarification:**
   * *Suggestion:* Item ① notes that the audit chain is tamper-evident, not tamper-proof, because an attacker with the same UID could truncate and regenerate the chain. It would be helpful to briefly clarify in the documentation whether `nimbus egress` signed exports are meant to be generated automatically on a cron/schedule and pushed to a remote SIEM to minimize the window where an attacker could rewrite the chain locally.
