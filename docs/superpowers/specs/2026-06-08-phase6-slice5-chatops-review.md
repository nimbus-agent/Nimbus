# Phase 6 Slice 5 — ChatOps Design Review

This document lists open questions, suggestions, and potential improvements identified during the review of the [2026-06-08-phase6-slice5-chatops-design.md](file:///C:/gitrep/Nimbus/.worktrees/phase6-slice5-chatops/docs/superpowers/specs/2026-06-08-phase6-slice5-chatops-design.md) specification.

---

## 1. Open Questions

### Q1: Caching and Rate-Limiting for User Identity Mapping

- **Context:** Resolving a platform user ID to an email requires running `slack_user_info` or `teams_user_info` via the connector tools. Doing this lookup on *every single incoming message* could introduce significant latency (additional network round-trip to the cloud API) and rapidly consume platform API rate limits (e.g., Slack's Web API Tier 4 limits).
- **Question:** How will user mapping results be cached? What is the cache eviction/TTL strategy? If cached, how are changes in user status (e.g., user deactivated, email changed in the IdP) handled to prevent stale or orphaned authorization states?

### Q2: Teams Webhook Inbound Ingress & Authentication Validation

- **Context:** Teams messages are sent via HTTPS POST webhooks. The design notes authentication via "bearer-or-HMAC".
- **Question:** Standard Teams/Microsoft Bot Framework webhooks use Microsoft-signed JWT tokens for verification against public key endpoints (`https://login.botframework.com/v1/.well-known/openidconfiguration`).
  - Will the gateway validate these standard Teams/Microsoft Bot JWT signatures directly?
  - If so, does it have access to fetch the public keys (potentially violating the local-first network constraints or requiring internet connectivity at the gateway level)?
  - If using a simpler HMAC/bearer proxy, does that push the security validation responsibility to an external gateway ingress/reverse proxy?

### Q3: Owner Resolution Glob Collisions & Quorum Interaction

- **Context:** Section 5 defines ownership globs:

  ```toml
  "payment-service" = "alice@acme.com"
  "payment-*"       = "pay-lead@acme.com"
  ```

- **Questions:**
  - If multiple patterns match (e.g., `payment-service` matches both patterns above), does the resolution algorithm strictly choose the longest/most-specific match (as stated), or can it support multiple owners?
  - If a resource resolves to multiple owners, or if the owner group is a team email, how does this interact with the I21 Quorum requirement?
  - What happens if the owner email resolves back to the requester themselves? Does the HITL gate fall back to a self-approval blockage (requiring an independent peer), or is self-approval allowed for certain owners?

---

## 2. Suggestions & Improvements

### S1: Command Parser Normalization (Slack Formatting Clean-up)

- **Problem:** Chat platforms often alter raw text. For example, Slack auto-formats URLs (converting `example.com` to `<http://example.com|example.com>`), wraps strings in backticks/quotes, or turns quotes into smart quotes (`“` and `”` instead of `"`).
- **Suggestion:** The `command-parser.ts` should explicitly include a normalization step to strip chat platform decorators (backticks, Slack user tags like `<@U12345>`, smart quotes, and HTML-like channel/URL links) before tokenizing the arguments for `run <action> k=v...`.

### S2: WebSocket Reconnection & Backoff Strategies

- **Problem:** Slack Socket Mode relies on a persistent WebSocket connection. In a local-first gateway setting, networks are expected to drop or change (e.g., laptop going to sleep, Wi-Fi reconnection).
- **Suggestion:** Explicitly detail the backoff/retry strategy for Socket Mode. The `slack-socket-adapter` should monitor socket health (ping/pong) and handle reconnection with exponential backoff to avoid hammering the Slack Socket Mode API during outage periods.

### S3: Fail-Safe for Unresolvable Ownership

- **Problem:** Section 5 states: "fallback-owner-absent → refuse".
- **Suggestion:** We should add an explicit warnings/audit-log entry when a write command is refused due to a missing fallback owner glob, so operators can immediately diagnose why the bot is ignoring or refusing their commands.

---

## 3. Resolution (2026-06-08)

All items evaluated against the codebase. Seven **fixed** in the design spec, one **deferred** with
rationale. Full disposition table + landing sites: design spec **§3.2 Review resolutions**.

| Item | Disposition | Summary |
|------|-------------|---------|
| Q1 | **Fixed** (§4.4) | Cache `userId→email` (TTL+LRU); authorization re-checked **live** locally per message; deprovision evicts + flips local `active` → no stale-auth window. |
| Q2 | **Fixed** (§7) | Teams = **Bot Framework Microsoft-signed JWT**, validated via the existing `identity/jwks-cache.ts` RS256 pattern (same outbound-for-verification as OIDC; not a local-first violation). "bearer-or-HMAC" was an error. Slack Socket Mode (outbound WS, app-token) needs no inbound signature. |
| Q3a | **Fixed** (§5) | Deterministic owner precedence (exact → longest literal prefix → `*`); equal-specificity collision ⇒ refuse + audit. |
| Q3b | **Deferred** (§3.1) | Group/multi-owner ownership out of scope; owner = one SCIM email; quorum (I21) composes orthogonally. |
| Q3c | **Fixed** (§5) | Self-approval allowed only when no quorum applies; under quorum the requester is ≤1 distinct peer. |
| S1 | **Fixed** (§4.5) | Normalization pass (mentions, `<url\|text>`, smart quotes, backticks) before the `run` grammar. |
| S2 | **Fixed** (§4.5) | Fresh-before-close, ping/pong health, exponential backoff + jitter, at-least-once + `(channel,ts)` idempotency. |
| S3 | **Fixed** (§5) | Every policy refusal emits an audit entry (reason code) + a one-line in-channel "why". |
