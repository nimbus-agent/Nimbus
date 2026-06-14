# Review & Feedback: Phase 6 Slice 7 — Wave 7c HITL-Gated WRITE Actions Design

**Review Date:** 2026-06-14  
**Design Document Reviewed:** [2026-06-14-phase6-slice7-wave7c-hitl-writes-design.md](./2026-06-14-phase6-slice7-wave7c-hitl-writes-design.md)  
**Status:** Review Feedback / Suggestions / Open Questions

---

## 1. IPC & Network Hardening of `answerLocalOperatorInvoke`

### Context

In **§4.2** (Local write flow), the design introduces a new function/flow:
```text
team     → answerLocalOperatorInvoke (NEW, I19 local-operator single-tool variant)
              → withConnectorSession(teamVaultView) → session.call(writeToolId, args)
```
Since this function accesses Team Vault credentials for local writes and bypasses the peer restriction checks applied to federated invokes, we must be absolutely certain about its exposure.

### Suggestions / Open Questions

1. **Isolation from Network/IPC Layer:** Is `answerLocalOperatorInvoke` exposed to any external-facing interfaces?
   - **Verification:** Ensure that this method is **strictly internal** to the gateway's connector execution layer and is not bound to the Tauri IPC bridge, the LAN Server, or HTTP/RPC listener surfaces.
   - **Enforcement:** We should verify that `check-nimbus-invariants.ts` (or D20) asserts that `answerLocalOperatorInvoke` is never imported or registered in `packages/gateway/src/ipc/` or `ui/src-tauri/src/`.
2. **Access Control Check:** If any local IPC client (e.g., CLI) can invoke this method directly, how is authorization checked? It must only run if initiated by the local gateway process as part of an `executor.execute` flow that has already cleared the HITL check (I2).

---

## 2. Asynchronous Refresh Job Tracking & UX

### Context

In **§3** (Write surface) and **§7** (Manual checklist), several actions trigger asynchronous operations:
- `tableau.datasource.refresh` / `tableau.workbook.refresh`
- `powerbi.dataset.refresh` / `powerbi.dataflow.refresh`

These API calls typically return a `202 Accepted` status and a job/run ID, with the actual refresh running in the background on the cloud provider's side.

### Suggestions / Open Questions

1. **How does the Agent know when a refresh completes?**
   - If the agent triggers a refresh to update a dataset before answering a query, returning a simple "queued" status immediately might cause the agent to read stale data on the very next step.
   - **Recommendation:** Provide clear API response shapes for these write tools. If they return a Job ID, the tool output should explain that the job is asynchronous.
   - **Optional Polling Tool / Guidance:** Consider whether we need a lightweight "check refresh status" read tool, or if we should instruct the agent to wait/poll, or simply document that verification must be done via subsequent metadata/lineage updates.
2. **Rate Limits & Overlap:** If the user or agent triggers multiple refreshes on the same dataset/datasource in rapid succession, does the target API reject it? (e.g., Power BI has strict refresh rate limits per day/dataset). The write tools should gracefully catch and report these specific limit-exceeded errors.

---

## 3. Scoping Parameters Validation (Tableau Sites / Power BI Groups)

### Context

The REST API endpoints for Tableau and Power BI writes require container/scoping IDs:
- Tableau: `/sites/{site}/datasources/{id}/refresh`
- Power BI: `/groups/{g}/datasets/{id}/refreshes`

### Suggestions

- **Strict Validation in Schema:** The Zod schemas for these tools must validate that `{site}` and `{g}` (group/workspace ID) are provided, or fall back to defaults indexed during the metadata sync.
- **Agent Context:** Ensure that when the metadata sync indexes these objects, the site and group IDs are stored in the SQLite schema in a way that allows the LLM agent to retrieve them and construct the correct parameters for the write actions.

---

## 4. Fallback Behavior for Audit Logs (Identity-Subject Refinement)

### Context

In **§4.5** (Deferred follow-ups), the design states:
> `teamvault/team-vault-audit.ts` audit rows gain an optional `identitySubject?: string`. When identity is enabled, the resolved subject (from the verifier already threaded into the invoke gate as `identity`) is recorded...

### Suggestions / Open Questions

1. **Handling Disabled/Null Identity:** If `[identity]` is disabled (e.g., in a local single-player offline environment), what is written to `identitySubject`?
   - **Recommendation:** Default to a string literal like `"local-owner"` or `"disabled"` rather than leaving it `NULL` or empty, making it clear in audit trails that the operation was performed by the local instance owner under local control.
2. **Audit Schema Compatibility:** Ensure that adding `identitySubject` to `team-vault-audit.ts` is backward-compatible and does not require database migration (e.g., handled as an optional column or within an existing JSON payload if serialized).

---

## 5. Privilege / Role Mismatch UX

### Context

Writes (especially tags/comments in Snowflake or refresh triggers in Looker) often fail due to insufficient database privileges or workspace roles of the executing credential.

### Suggestions

- **Diagnostic Error Envelopes:** Since the write tools run inside the MCP connector subprocess, database/API errors should be wrapped securely (I11) but retain sufficient detail to diagnose role issues.
- If Snowflake returns an authorization error (e.g., `Object does not exist or operation cannot be performed`), the tool should format this into a helpful UX suggestion (e.g., `"Ensure the role associated with the credential has the appropriate privileges to SET TAG on table..."`).
