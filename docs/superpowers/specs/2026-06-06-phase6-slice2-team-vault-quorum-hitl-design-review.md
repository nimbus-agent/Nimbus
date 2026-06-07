# Phase 6 Slice 2 — Team Vault + Multi-user/Quorum HITL — Design Review

**Date:** 2026-06-06
**Target:** [2026-06-06-phase6-slice2-team-vault-quorum-hitl-design.md](2026-06-06-phase6-slice2-team-vault-quorum-hitl-design.md)

## Open Questions & Suggestions

1. **Mapping Vault Secrets to MCP Connector Environment Variables**
   * *Question:* How are the credentials in `teamvault.<entry>` mapped to the environment variables expected by the targeted MCP connector? For example, if a peer invokes a tool on the `prod-aws` service, the child process spawned by the anchor must receive `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`.
   * *Suggestion:* Clarify whether the mapping is hardcoded based on the connector's `service` ID or if the `team_vault_entries` table (or the secret payload itself) stores a mapping schema defining which environment variable keys to populate with the secret values. Hardcoding per connector type matches existing patterns, but a mapping mechanism provides better flexibility.

2. **Denial Semantics in Quorum HITL**
   * *Question:* If a quorum policy requires $N$ approvals (e.g., 2), and a peer explicitly **denies** the request, what happens? Does a single denial immediately abort the transaction and fail the quorum, or does the coordinator wait to see if other peers might still approve?
   * *Suggestion:* For security-critical actions, a single explicit denial should abort the quorum immediately to prevent approval spamming or authorization bypasses. This behavior should be explicitly coded into the `QuorumCoordinator`.

3. **Offline Delegates and Timeout Fallbacks in Delegated HITL**
   * *Question:* If a delegated HITL request is routed to a delegate who is offline, slow, or disconnects mid-flight, how is the request handled?
   * *Suggestion:* Ensure there is a defined timeout for delegated approvals. If the delegate fails to respond within a specific duration, the gateway should fall back to requesting local approval from the workspace owner to prevent workflows from hanging indefinitely.

4. **Zero-Latency Grant Revocation**
   * *Question:* The design mentions that revoking a grant stops further success "within one cycle". How is this checked?
   * *Suggestion:* Since the grants are stored in SQLite (`team_vault_grants`), check the database directly on every `federation.invoke` request rather than using memory-cached permissions. This guarantees true zero-latency revocation.

5. **Session-Only State Resiliency**
   * *Question:* Since the quorum coordinator and delegation queues are in-memory (session-only), what happens if the anchor gateway restarts mid-vote?
   * *Suggestion:* The requesting peer's client should receive a clean error (e.g., connection reset or standard JSON-RPC timeout) and know it is safe to retry, and the coordinator should cleanly release any acquired resources or partial states upon restart.

## Alignment with Invariants

* **Invariant I19 (Team Vault secret isolation):** The proposed design of only injecting the secret in-process within `answerFederatedInvoke` and validating via runtime tests and static checks (`D15`) is highly robust.
* **Invariant I20 & I21 (Verification in the gate):** Performing both delegation and quorum checks in `engine/executor.ts` (instead of the wire or prompt) preserves the structural nature of HITL.
* **Tauri Allowlist Pinning:** Ensure the exact method counts in `packages/gateway/src/security-invariants.test.ts` are updated alongside the allowlist count in `tauri.conf.json`.
