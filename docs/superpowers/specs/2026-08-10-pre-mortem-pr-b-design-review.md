# `nimbus pre-mortem` PR B — Design Review & Feedback

## Open Questions

1. **Vercel/Prefect deploy outcome representation in UI or CLI:**
   - The design notes that `deploy_failed` covers only CI-annotated deployments because Vercel/Prefect have different vocabularies/structures.
   - *Question:* Should the CLI or agent brief actively warn the user if they query a service whose deployment mapping is Vercel/Prefect, explaining *why* a deploy-failure watcher cannot be set up? (e.g. "deploy_failed watcher is only supported for CI-annotated deployments; Vercel is not supported.")

2. **Tauri Gateway Bridge Method Name:**
   - In PR B2, the design proposes adding `agents.premortem` to `gateway_bridge.rs:ALLOWED_METHODS` (I7).
   - *Question:* Is the IPC method namespaced as `agents.premortem` or `agents.preMortem` or similar? Let's check `packages/gateway` agent naming conventions to make sure it matches.
   - Also, does Tauri need access to `premortem.refresh` eventually? The design says: "*premortem.refresh stays unexposed*". If Tauri users need to force a refresh of the pre-mortem data, how will they do it without that method?

3. **Validation Code Error Range:**
   - For `watcher.create` unknown kinds, the design specifies rejecting with `-32602` (Invalid params in JSON-RPC).
   - *Question:* Does the workspace have a unified helper/error enum for JSON-RPC error codes? Or are raw integers used?

## Suggestions & Improvements

1. **Extend `watcher.validateCondition` or condition-kind metadata:**
   - Since we now have a `condition-kind table` mapping condition types to item types and predicates, we should ensure `watcher.validateCondition` (or a similar validation helper) leverages this table directly to validate target parameters (e.g. checking if the filtered service exists or is valid for that item type) rather than just checking if the string is in the table. This keeps the validation logic dry and robust.

2. **Documenting the Agent Write-Access Exception (I2 vs Agent Shape):**
   - Built-in agents are strictly read-only by the Agent Shape Invariant. However, the pre-mortem agent writes paused watcher rows (mutating `premortem_watcher_proposal`).
   - *Suggestion:* Make sure we clearly define in the Agent Shape Invariant that writes to `premortem_watcher_proposal` or `watcher` (if any) are either:
     - Gated by a specific, non-bypassable local executor / consent gate (HITL), OR
     - The agent doesn't write directly but instead returns a *proposal payload* to the client (CLI/UI), and the client triggers the mutation via a distinct write-enabled IPC method (`watcher.create` or a new pre-mortem command) which is HITL-gated.
     - *If the agent writes directly:* Ensure this does not violate security invariant **I2** (HITL gate) or the read-only built-in agent invariant without a specific exception. Returning proposals for the client to execute is typically cleaner and safer.

3. **Linear Support Warning:**
   - Since the extraction is Jira-only and company-managed Jira projects return zero services, the pre-mortem CLI tool should explicitly output a friendly diagnostic/info message when run on a non-supported issue tracker or company-managed Jira project: e.g. "Linear is currently not supported for pre-mortem cohort analysis." or "No affected services found (pre-mortem analysis is limited to Jira team-managed projects)." This avoids user confusion where they get empty results with no explanation.
