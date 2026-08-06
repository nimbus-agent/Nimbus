# HTTP Agent Invocation + Resolve-by-URL — Design Review

**Date:** 2026-08-06
**Subject File:** [`2026-08-06-http-agents-route-and-resolve-by-url-design.md`](file:///C:/gitrep/Nimbus/.claude/worktrees/http-agents/docs/superpowers/specs/2026-08-06-http-agents-route-and-resolve-by-url-design.md)

---

## 1. Open Questions & Design Clarifications

### Q1.1: Gateway Restart & `AgentRunController` State Persistence

* **Context:** The design specifies that `AgentRunController` will manage agent runs via a "plain `Map`, injected clock, lazy expiry, tombstone set driving 410-vs-404, concurrency cap."
* **Concern:** Because this state is kept purely in-memory, restarting the Nimbus gateway will wipe all active and historical run statuses. Any polling client (e.g., a browser extension or editor) that tries to query the status of a run across a restart will receive a `404` (unknown) rather than a clean resumption or historical failed/interrupted state.
* **Recommendation:** Consider whether agent run records should be persisted to a lightweight SQLite table (e.g., `agent_runs`) or if transient in-memory polling is truly acceptable. If in-memory is chosen, document the expected client behavior on `404` (e.g., treating it as aborted/failed and offering a retry).

### Q1.2: Token Lifecycle and Scope Updates

* **Context:** Scopes (`clip`, `briefs`, `agents`, `resolve`, `fetch`) are stored in the Vault map as `{token, scopes[]}`. Legacy tokens default to `["clip", "briefs"]`.
* **Concern:** If a user wants to expand or modify the scopes of an existing paired client (e.g., granting a browser extension the `agents` or `resolve` scope), is the only path to delete and re-pair from scratch?
* **Recommendation:** Clarify if there will be a CLI subcommand or flow (e.g., `nimbus clip update-scopes --token <label> --scopes ...`) to update scopes in the Vault without requiring a full re-pair cycle.

### Q1.3: JS Execution in Migration V50

* **Context:** The migration V50 will add the `resolve_key` column and run a batched backfill using `canonicalizeUrl` (which is written in JavaScript/TypeScript).
* **Concern:** Database migrations are typically defined as raw SQL schema upgrades. If the migration runner does not support executing arbitrary JS logic natively, executing a JS backfill during the migration might be complex or error-prone.
* **Recommendation:** Confirm that the Nimbus migration runner (`packages/gateway/src/db/`) supports JS-based steps or programmatic migration execution. If not, plan a two-step approach: SQL migration for schema layout, followed by an automated post-migration JS backfill run at gateway startup.

---

## 2. Suggestions & Improvements

### Suggestion 2.1: Ambiguous Resolve UX (Returning Candidates)

* **Context:** "A trimmed match must be **unique** or the answer is `ambiguous` — trimming can over-reach, and guessing between candidates is worse than declining."
* **Improvement:** Instead of returning a flat `{found:false, reason:"ambiguous"}` when multiple candidate items match the trimmed URL paths, the API should return the list of matching candidates (e.g., ids, titles, services). This enables client UIs (like the browser extension) to display a dropdown or selection menu, allowing the user to explicitly disambiguate the item they meant to select.
* **Proposed Shape:**

  ```json
  {
    "found": false,
    "reason": "ambiguous",
    "candidates": [
      { "id": "item_123", "service": "github", "type": "pull_request", "title": "PR #42: Feature" },
      { "id": "item_456", "service": "github", "type": "issue", "title": "Issue #42: Bug" }
    ]
  }
  ```

### Suggestion 2.2: Public Routes Exclusion Test

* **Context:** "Adding a route without a scope fails the suite rather than defaulting to 'any token works.'"
* **Improvement:** Ensure the completeness test also explicitly asserts that all public/unauthenticated routes (like health checks or public static assets, if any) are intentionally mapped as public, verifying they are excluded from the bearer-gated checks so they don't break.

### Suggestion 2.3: Static Audit Rule `D22(d)` Verification

* **Context:** "No file outside `packages/gateway/src/ipc/agents-rpc.ts` may import an agent **emitter** module..."
* **Improvement:** Ensure that `scripts/structure-audit/check-nimbus-invariants.ts` is explicitly updated in PR 2 to statically parse files and enforce this import boundary. This ensures `audit:invariants` catches any violation at lint/static time.
