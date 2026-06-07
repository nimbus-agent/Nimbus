# Phase 6 Slice 4 Design Review

**Date:** 2026-06-07
**Target:** [2026-06-07-phase6-slice4-policy-admin-observability-design.md](./2026-06-07-phase6-slice4-policy-admin-observability-design.md)

## Open Questions & Suggestions

1. **Line Ending Normalization for Signature Verification**
   * **Problem:** Windows and Linux handle text line endings differently (`\r\n` vs `\n`). If `nimbus.policy.toml` is stored locally and undergoes line ending normalization (either by Git or a text editor), the raw byte array of the file will change. This will break the Ed25519 signature verification on different platforms.
   * **Suggestion:** Before signing and verifying, the policy content bytes must be normalized to a canonical form (e.g., converting all `\r\n` to `\n` and trimming trailing whitespace) to guarantee cross-platform signature stability.

2. **Monotonicity Rule and Policy Updates**
   * **Question:** The design states: *"Policy may only make enforcement stricter (monotonic). The EnforcedPolicy view is computed so that a policy attempting to lower a quorum or drop a HITL requirement has no weakening effect."*
   * Does this mean a policy cannot be modified to be less strict than a *previously active* policy? (e.g., if an admin sets quorum to 3, then decides 2 is sufficient).
   * **Suggestion:** Clarify that "stricter" means `effective = max(localConfig, policy)`. An admin should be able to lower the org policy (e.g., from 3 down to 2) as long as it is still equal to or stricter than the local `localConfig` default (e.g., 1). The policy engine should not lock in a "high-water mark" of policy history that prevents admins from ever scaling back organizational constraints.

3. **Offline Peers during GDPR Purge**
   * **Question:** GDPR purge calls `federation.purge` for each peer. If a peer is offline or network-partitioned during the command execution, how is the purge tracked? Does the command fail, or is the purge queued for delivery when the peer comes back online?
   * **Suggestion:** Because compliance operations require high reliability, the purge state of each peer should be persisted in `policy-store`. Any pending peer purges should be retried automatically during subsequent federation sync cycles until a signed deletion record is returned by that peer.

4. **Authentication for `/metrics` Endpoint**
   * **Question:** Does the `GET /metrics` Prometheus endpoint require the same bearer token as `/v1/admin/status`?
   * **Suggestion:** Prometheus scrapers typically run as infrastructure agents. If `/metrics` is authenticated, specify that it accepts standard HTTP Bearer authentication so users can configure their Prometheus scrapers with the Gateway's bearer token.

5. **Static Admin Console Build/Deploy Lifecycle**
   * **Question:** How does the static bundle in `packages/admin-console` get compiled, and when?
   * **Suggestion:** Clarify the build pipeline. For example, `packages/admin-console` should have a build script using `bun build` to compile the vanilla TS to `dist/bundle.js`. Ensure that the monorepo's global build scripts compile `packages/admin-console` before running Gateway tests or packaging Gateway releases.

## Alignment with Invariants

- **I22 Invariant:** The monotonic-stricter requirement and trust-anchor signature check are well-designed and preserve the HITL structural invariant.
- **Tauri Allowlist (I7):** Safely excludes destructive/RCE commands (`policy.sign`, `policy.trust`, `team.purge`) from the Tauri bridge.
- **Audit Shipping (I11/I19):** By design, the audit shipper only transmits metadata, preventing any leak of credentials or sensitive action payloads.
