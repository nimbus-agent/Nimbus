# Phase 6 Slice 5 — ChatOps Plan Review

This document lists open questions, suggestions, and potential improvements identified during the review of the [2026-06-08-phase6-slice5-chatops.md](file:///C:/gitrep/Nimbus/.worktrees/phase6-slice5-chatops/docs/superpowers/plans/2026-06-08-phase6-slice5-chatops.md) implementation plan.

---

## 1. Open Questions & Dependency Gaps

### Q1: Missing `@nimbus-dev/client` IPC Wrapper Updates
- **Context:** Task 10 describes implementing `chatops-rpc.ts` on the gateway and adding the `nimbus chatops` subcommand in the CLI. The CLI communicates with the Gateway via IPC using the typed `@nimbus-dev/client` wrapper.
- **Question:** The plan does not explicitly list modifying `packages/client` to add the typed RPC methods for `chatops.*` (`chatops.status`, `chatops.start`, `chatops.stop`, `chatops.test`). 
- **Suggestion:** Add a step in Task 10 to update `packages/client/src/index.ts` (or the relevant RPC client file) to export these new methods so the CLI compiler does not fail on missing types.

### Q2: Teams JWKS Cache Ingress Offline/Local Fallback
- **Context:** Task 9 Step 6 mentions validating the Teams Bot Framework JWT via a JWKS cache using `https://login.botframework.com/v1/.well-known/openidconfiguration`.
- **Question:** In offline or restricted intranet environments, a local-first gateway will not be able to retrieve the Microsoft JWKS keys dynamically.
  - Is there a fallback mechanism? (e.g. caching the keys long-term on disk, or allowing an operator to configure a static webhook signing secret / HMAC validation instead of Bot Framework JWT auth for localized deployments?)

---

## 2. Suggestions & Improvements

### S1: Bounding the Memory usage of Slack Event Deduplication
- **Context:** Task 9 Step 3 mentions using a `Set<string>` of seen dedupe keys inside `SlackSocketAdapter` to handle Slack event retries.
- **Suggestion:** Specify a concrete eviction strategy or limit for this set (e.g. limit to the last 1000 message IDs, or clear entries older than 5 minutes) to prevent memory leaks in long-running gateway instances.

### S2: Consolidating `slack_socket_open` in Task 8
- **Context:** Task 8 describes adding MCP connector tools. Step 4 mentions postponing the implementation details of `slack_socket_open` to Task 9 after the Step 0 spike.
- **Suggestion:** To keep the connector package edits cleaner, keep the spike in Task 9 Step 0, but fully document/implement both the registration of the `slack_socket_open` tool in `packages/mcp-connectors/slack` and its transport usage inside Task 9, or define a clear interface contract for it in Task 8.

---

## 3. Resolution (2026-06-08)

Evaluated against the codebase. Two **fixed**, two **declined with evidence** (Q1 reviewer-context, Q2 conflicts with the approved spec decision). Full disposition: plan **"Plan review resolutions"** section.

| Item | Disposition | Summary |
|------|-------------|---------|
| Q1 | **Declined (clarified)** | `@nimbus-dev/client` uses a generic `ipc.call(method, params)` — no per-method wrappers exist (grep of `packages/client/src` finds no `policy.*`/`identity.*`); `chatops.*` needs none. The CLI compiler will not fail. Task 10 Step 6 documents this. |
| Q2 | **Declined HMAC + documented** | HMAC/static-secret was explicitly rejected in spec §7 (approved). A Teams Bot Framework bot is online by definition (receives from + replies to Microsoft's cloud). Resilience = disk-cached JWKS (`oidc_jwks_cache`, long TTL) surviving transient outages; cold-start-during-outage fails closed (correct). Task 9 Step 6. |
| S1 | **Fixed** | Dedupe `Set` + insertion-order queue capped at 1000, FIFO eviction + test. Task 9 Step 3. |
| S2 | **Fixed** | `slack_socket_open` tool contract (`{} → { url:string }`) fully defined in Task 8 Step 4; Task 9 only consumes it. |
