# Design Review: Standalone Connector Hardening (Project B)

**Date:** 2026-08-23  
**Status:** Design Review / Feedback  
**Target Spec:** [2026-08-23-standalone-connector-hardening-design.md](./2026-08-23-standalone-connector-hardening-design.md)

---

## 1. Summary of Feedback

The proposed design for Standalone Connector Hardening is structurally sound, leveraging MCP input elicitation and client-independent gates (scope allow-lists, budgets, and chained audits) to enforce security off-gateway.

This review outlines open questions, potential improvements, and concrete suggestions categorized by functional area.

---

## 2. Detailed Feedback & Open Questions

### Q1. Mode Spoofing & Module Isolation (B1)

The spec states:
> `"standalone"` is the default; the **gateway** is what must opt out.
> `run-bundled-connector.ts` calls `setConnectorMode("gateway")` before dynamically importing the connector.

* **Concerns:**
  * Since JS/TS module namespaces are shared in the same Bun process, if the gateway spawns connectors, could a bug or malicious sub-process cause crossover or leakage of the mode?
  * If a connector itself is imported statically/dynamically elsewhere in the gateway without going through the `run-bundled-connector.ts` wrapper (e.g., during tests or static audits), could it run in `"standalone"` mode by default inside the gateway?
* **Suggestions:**
  * Make `setConnectorMode(...)` throw if called more than once, ensuring the mode is locked for the lifetime of the process.
  * Ensure the default mode is indeed `"standalone"`, and audit all gateway-side entry points to guarantee `setConnectorMode("gateway")` is executed early enough.

### Q2. Elicitation Support & Client Compatibility (B3)

The consent gate relies heavily on MCP client-side `elicitation` capabilities:
> Write tools register **only** when `elicitation` is advertised.

* **Concerns:**
  * As of late 2025/early 2026, many mainstream MCP clients (Cursor, Claude Desktop, etc.) do not natively support or advertise the `elicitation` capability. This means that out-of-the-box, the standalone connectors will be **entirely read-only** in these clients.
* **Suggestions:**
  * Verify/document which current clients support `elicitation`.
  * Consider offering a fallback or explicit override (e.g., an env var `NIMBUS_MCP_UNSAFE_ALLOW_MUTATIONS=true` combined with strict scope/budget controls) for environments that do not support elicitation but still require mutation tools. This override must print a loud warning to stderr on startup.

### Q3. Scope Allow-list Syntax and Extensibility (B4)

The spec introduces service-specific env vars:
> `NIMBUS_MCP_<SERVICE>_WRITE_SCOPE=owner/repo,…`

* **Concerns:**
  * While `owner/repo` is intuitive for GitHub/GitLab, it does not translate well to database/warehouse connectors (e.g., BigQuery, Athena) or communication platforms (e.g., Slack, Notion, Jira).
* **Suggestions:**
  * Define a standard, generic scope syntax. For example, URI-like patterns:
    * GitHub: `repo:owner/repo`
    * BigQuery: `dataset:project.dataset.table` or `project:project-id`
    * Notion: `page:page_id` or `workspace:workspace_id`
  * Provide helper parser utilities in `@nimbus-dev/sdk/connector-kit` (or similar shared package) to parse and match these scope strings consistently across all connectors.

### Q4. Mutation Budget Exhaustion Behavior (B4)

* **Concerns:**
  * What happens when the lifetime mutation budget is exhausted? Does the server return a clean protocol error, or does it terminate the process?
  * If it returns an error, the model might try to retry or bypass it.
* **Suggestions:**
  * When the budget is exhausted, the connector should dynamically unregister/remove write tools (using `sendToolListChanged()`) so they are no longer visible to the client, rather than just rejecting calls.

### Q5. Reversibility & State Capture (B4)

* **Concerns:**
  * Capturing pre-state (like git SHAs) is powerful but highly tool-specific.
* **Suggestions:**
  * In `registerWriteTool`, require a structured `capturePreState` hook if `reversible` is set to `true`.
  * Ensure the audit logger handles these pre-state objects cleanly inside the JSONL payload.

### Q6. Portability of `Bun.spawn` Shim (B6)

* **Concerns:**
  * The 6 AWS/GCP connectors using `Bun.spawn` need to run on Node. `node:child_process` has subtle differences (e.g., handling buffer limits, promise-based API wrapping).
* **Suggestions:**
  * Implement a robust `nimbusSpawn` utility in the shared library that delegates to `Bun.spawn` under Bun and uses `node:child_process` (like `spawnSync` or `execFile`) under Node.

---

## 3. Checklist for Implementation (Project B)

* [ ] Lock default mode to `"standalone"`.
* [ ] Implement `setConnectorMode("gateway")` at the single gateway chokepoint.
* [ ] Define the schema and parser for `NIMBUS_MCP_<SERVICE>_WRITE_SCOPE`.
* [ ] Implement the mutation budget gate in the base connector registrar.
* [ ] Implement the SHA-256 JSONL audit chain utilizing `node:crypto`.
* [ ] Create the `nimbus-mcp` multi-connector launcher CLI.
* [ ] Add the Node compatibility shims for process spawning.
* [ ] Implement integration tests using a simulated MCP client with and without `elicitation` capabilities.
