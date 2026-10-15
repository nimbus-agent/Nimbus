# Review: S3 MCP Capture Sink PR 3 — The Act Door Design

**Spec Under Review:** `2026-10-15-mcp-act-door-design.md`  
**Branch:** `dev/asaf/s3-act-door`  
**Review Date:** 2026-10-15  
**Reviewer:** Pair Programming Agent (verified against codebase at `436937b9`)

---

## 1. Executive Summary

The proposed act door design (`2026-10-15-mcp-act-door-design.md`) represents a thoughtful, security-first extension of the MCP capture sink (PR 1/2, invariant I28). The core architectural choices are sound and align well with Nimbus’s local-first principles:
- **Approach A (Unified `capture` Table):** Treating `action` as a 5th capture kind avoids table sprawl and reuses the existing gate, lifecycle, and client policies.
- **Fail-Closed Classification & Totality Testing:** Establishing a strict classification table pinned against `HITL_REQUIRED.size === 139` guarantees that newly introduced HITL action types cannot be proposed until classified.
- **Unredacted Provenance Display (I42 Extension):** Showing raw verbatim input and unverified summary prevents prompt-injected agents from smuggling arguments past regex redaction.
- **Double Lock-Off & Monotonic Policy:** Ensuring `action` is never enabled by default (`[mcp_sink] kinds`) and introducing the 9th capability `mcp_action` prevents accidental exposure.

However, a deep verification against the runtime codebase reveals **one critical architectural blocker** regarding first-party connector dispatching, **one interface contract discrepancy** in `ToolExecutor` execution, and several important edge cases in async dependencies, CLI formatting, and database invariants.

---

## 2. Critical Architectural Findings (Blockers)

### 2.1 The First-Party Action Dispatch & Tool Name Mismatch

> **Issue:** As currently designed, every first-party connector action will fail with `ERR_ACTION_TOOL_NOT_FOUND` upon acceptance.

#### The Problem:
1. **The Spec Design:**  
   - § 8 step 6 builds the action as `{ type: payload.actionType, payload: { input: payload.input } }` with **never `mcpToolId`**.
   - § 2 Non-goals states: *"No change to `engine/executor.ts` or `connectors/registry.ts`."*
   - § 12.2 adds rule D32(g): *"the `mcpToolId` literal appears under `mcp-sink/` only in `capture-validate.ts`."*
2. **The Codebase Reality (`packages/gateway/src/connectors/registry.ts`):**  
   In `registry.ts`:
   ```ts
   const fromPayload = action.payload?.["mcpToolId"];
   const toolId = typeof fromPayload === "string" && fromPayload.length > 0 ? fromPayload : action.type;
   const map = await toolsFor(action, toolId);
   const tool = resolveServerTool(map, serviceOf(action.type), toolId);
   ```
   - For **user-MCP** actions (`mcp_<id>.<tool>`), `registry.ts` specifically calls `userMcpToolKeyForActionType(action.type)` which maps the dot to an underscore (`mcp_echo.echo` → `mcp_echo_echo`). That is why user-MCP works in the E2E mock.
   - For **first-party** actions (e.g. `slack.message.post`, `jira.issue.create`), Mastra MCP registers the tools with underscores, e.g. `slack_slack_message_post` or `jira_jira_issue_create`.
   - `resolveServerTool(map, "slack", "slack.message.post")` checks:
     1. `ownEntry(map, "slack.message.post")` → `undefined`
     2. `ownEntry(map, "slack_slack.message.post")` → `undefined`
   - It throws `new Error("Tool not found")`.
   - In `packages/gateway/src/connectors/connector-write-tool-ids.ts`, `MIGRATED_WRITE_TOOL_IDS` explicitly documents that first-party write tools are:
     > *"Write tool ids routed through the connector consent kit but NOT dispatchable from the gateway... these tools have no dispatch path, and inventing rows for them would put fictional routing into a real routing table."*
3. **Why tests didn't catch this:**  
   § 13 notes that `capture-action-flow.test.ts` uses a **fake dispatcher** that accepts `{type, {input}}` directly, while the E2E test uses a **mock user-MCP server** (where `userMcpToolKeyForActionType` translates the name). Neither tests first-party tool dispatch through the real `createConnectorDispatcher`.

#### Recommended Solution:
- **Revise Non-Goals:** Allow a narrow extension in `connectors/registry.ts` or `lazy-mesh/tool-map.ts`.
- **Add Canonical Tool Name Translation:** Just as `userMcpToolKeyForActionType` was introduced for I42, provide a canonical resolution for first-party proposable action types (e.g. `firstPartyToolKeyForActionType(action.type)` mapping `slack.message.post` → `slack_message_post`, `jira.issue.create` → `jira_issue_create`).
- Alternatively, have `createConnectorDispatcher` normalize `action.type` dots to underscores when resolving tools within the designated server.

---

### 2.2 `ToolExecutor` Construction and Injected `act.execute` Signature

> **Issue:** Ambiguity between how `ToolExecutor` is instantiated and how `provenanceConsent` wraps the accepting client's channel.

#### The Problem:
- In § 3: `ipc/capture-rpc.ts builds ToolExecutor(bindConsentChannel(accepting client), ...)` and injects `execute() + consent channel`.
- In § 8 step 7: `await act.execute(action, provenanceConsent)` where `provenanceConsent` wraps the accepting client's channel and replaces the prompt/details.
- In `engine/executor.ts`:
  ```ts
  export class ToolExecutor {
    constructor(private readonly consent: ConsentChannel, ...) {}
    async execute(action: PlannedAction): Promise<ActionResult> { ... }
  }
  ```
  `ToolExecutor.execute` takes ONLY `(action: PlannedAction)`. It does NOT accept a `ConsentChannel` argument.
- `capture-rpc.ts` only receives `{ id }` for `captures.accept`. It does not have the capture row's metadata (`client_label`, `summary`, `created_at`, `expires_at`) until `capture-act.ts` reads it.

#### Recommended Solution:
Clarify the dependency injection contract in `capture-act.ts` and `ipc/capture-rpc.ts`:
- Define `ActionProvenance`:
  ```ts
  export interface ActionProvenance {
    readonly clientLabel: string | null;
    readonly createdAt: number;
    readonly expiresAt: number;
    readonly summary: string;
  }
  ```
- Have `capture-rpc.ts` inject an execution runner function:
  ```ts
  export interface ActDependencies {
    execute(action: PlannedAction, provenance: ActionProvenance): Promise<ActionResult>;
  }
  ```
- In `capture-rpc.ts`:
  ```ts
  execute: async (action, provenance) => {
    const wrappedConsent = createProvenanceConsentChannel(acceptingClientChannel, provenance);
    const executor = new ToolExecutor(
      wrappedConsent,
      auditSink,
      dispatcher,
      undefined, // delegation = undefined (I20)
      egressSink,
      policyHitl, // I22 overlay
    );
    return executor.execute(action);
  }
  ```
- This maintains D32(f) (no `executor.ts` imports in `mcp-sink/`), satisfies `security-invariants.test.ts` (the `new ToolExecutor` scan checks for `policyHitl`), and cleanly encapsulates prompt formatting.

---

## 3. Preconditions & Dependency Invariants

### 3.1 `submitCapture` Must Be Asynchronous
- **Issue:** Step 5b runs `isConnectorConfigured(serviceOf(actionType))`.
- In `packages/gateway/src/sync/connector-configured.ts`, `isConnectorConfigured(vault, serviceId)` is `async` because `NimbusVault.get()` is asynchronous.
- Today, `submitCapture` in `capture-gate.ts` is synchronous.
- **Impact:** `submitCapture` must become `async Promise<{ id: string; state: CaptureState; expiresAt?: number }>`.
- **Suggestion:** `CaptureGateDeps` should take an injected `isConfigured(serviceId: string): Promise<boolean>` function. This prevents `mcp-sink/capture-gate.ts` from directly importing `sync/connector-configured.ts` or `connectors/`, adhering to D32(f).

### 3.2 Handling Generic Action Types (`email.*`, `calendar.*`)
- **Issue:** Table 6.1 classifies `email.send`, `email.draft.send`, `email.draft.create`, and `calendar.event.create` as proposable.
- `serviceOf("email.send")` returns `"email"`.
- However, `"email"` is NOT a service in `CONNECTOR_VAULT_SECRET_KEYS` or `DERIVED_CONFIGURED_CHECKS`.
- In `connector-configured.ts`, querying a service with no registered keys returns `true` unconditionally (treating it as configured).
- Consequently, `isConnectorConfigured("email")` will return `true` even if the user has configured no email provider (neither Gmail, Outlook, Fastmail, IMAP, Apple Mail, nor Protonmail).
- **Suggestion:**
  - Either disallow generic `email.send` in favor of provider-specific types (`gmail.message.send`, `outlook.mail.send`, etc.), OR
  - Define an explicit composite configured check for `"email"`: `configured iff any(gmail, outlook, fastmail, imap, apple, protonmail) is configured`.

### 3.3 Module Location of `action-proposability.ts` vs D32(f)
- **Issue:** The spec places `action-proposability.ts` under `packages/gateway/src/mcp-sink/`.
- Rule D32(f) forbids any file under `packages/gateway/src/mcp-sink/` from importing `engine/executor.ts` (even type-only).
- However, `action-proposability.ts` needs:
  1. `isUserMcpActionType` (currently in `engine/executor.ts` line 236).
  2. The totality test asserting equivalence with `HITL_REQUIRED`.
- **Suggestion:**
  - Move `isUserMcpActionType` to `engine/service-of.ts` (which is already isolated from `executor.ts` to prevent cycles) and re-export it from `executor.ts`.
  - The totality test can live in `action-proposability.test.ts` (test files are exempt from D32 rules).

---

## 4. Data Model & Storage Refinements

### 4.1 Database CHECK Constraints for `action` Kind
- **Issue:** § 4 states: *"An action never has an `item_id` (it is never indexed or embedded) and never a `native_ref`."*
- However, the proposed `V69` DDL does not enforce this in SQLite.
- **Suggestion:** Add an explicit constraint to `capture`:
  ```sql
  CHECK (kind <> 'action' OR (item_id IS NULL AND native_ref IS NULL))
  ```
  This guarantees fail-closed schema integrity against erroneous writes.

### 4.2 Explicit Column Names in Migration SQL
- In `index/capture-action-v69-sql.ts`, ensure the copy statement explicitly enumerates column names on both sides:
  ```sql
  INSERT INTO capture_new (id, kind, state, item_id, payload_json, payload_bytes, client_label, session_id, native_ref, created_at, decided_at)
  SELECT id, kind, state, item_id, payload_json, payload_bytes, client_label, session_id, native_ref, created_at, decided_at
  FROM capture;
  ```
  This matches the V68 precedent and prevents column shifting issues.

### 4.3 `action_max_pending` Separation in `CaptureStore`
- Today, `CaptureStore.countByState("proposed")` counts all proposed rows across all kinds.
- Step 8 specifies that actions are capped against `action_max_pending` (unexpired proposals only), while decisions/terms/links are capped against `max_pending`.
- **Suggestion:** Introduce dedicated store methods:
  - `countPendingActions(nowMs: number): number` → `SELECT COUNT(*) FROM capture WHERE kind = 'action' AND state = 'proposed' AND expires_at > ?`
  - `countPendingNative(): number` → `SELECT COUNT(*) FROM capture WHERE kind <> 'action' AND state = 'proposed'`
  This ensures expired actions don't block new proposals and action proposals cannot starve native proposal quotas.

### 4.4 Expiry Audit Logging
- § 8 step 3 and § 9 mention auditing when an action expires.
- The spec does not define the audit `actionType` or payload for expiry.
- **Suggestion:** Use `actionType: "capture.action.expire"` with `hitlStatus: "not_required"` and `actionJson: JSON.stringify({ captureId: id, expiredAt: expires_at, outcome: "expired" })`.
- During `listCaptures`, run a single batch SQL update rather than row-by-row CAS:
  ```sql
  UPDATE capture SET state = 'expired', decided_at = ? WHERE kind = 'action' AND state = 'proposed' AND expires_at <= ?;
  ```
  This avoids write overhead and latency during query operations while keeping stored state consistent.

---

## 5. CLI & Agent Surface Adjustments

### 5.1 `nimbus captures accept <id>` Result Handling
- **Issue:** In `packages/cli/src/commands/captures.ts`:
  ```ts
  function assertAcceptResult(raw: unknown): void {
    const r = raw as { state?: unknown; nativeRef?: unknown } | null;
    if (r?.state !== "accepted" || typeof r.nativeRef !== "string" || r.nativeRef.length === 0) {
      throw new Error("captures.accept returned a malformed result; the capture was not confirmed accepted");
    }
  }
  ```
  Action acceptance returns `{ id, state: "executed" | "rejected" | "failed", outcomeRef?, errorCode? }` with `nativeRef` absent.
- `assertAcceptResult` will immediately throw an error when accepting an action.
- `confirmation()` also expects `nativeRef` and formats output as a glossary term, decision, or link.
- **Suggestion:** Update `captures.ts` to branch between native captures and action captures:
  - If `raw.state === "executed"`: `[ok] Executed action ${id} (${raw.outcomeRef ?? "no outcome ref"})`
  - If `raw.state === "rejected"`: `[rejected] Action proposal declined.`
  - If `raw.state === "failed"`: `[failed] Execution failed: ${raw.errorCode}. The action may or may not have reached the service.`

### 5.2 Interactive TTY Requirement Guard
- § 11 specifies: *"No TTY → refuse up front (exit 1, message names the TTY requirement), never auto-approve."*
- To prevent accidental auto-approval or silent hangs in automated CI environments:
  - In `runCapturesCmd`: if `verb === "accept"`, check `process.stdin.isTTY`. If false, reject immediately with `CliExit(1)` and print:
    `"nimbus captures accept requires an interactive terminal (TTY) for HITL confirmation."`

### 5.3 `CaptureStatus` Return Type Expansion
- § 10 states that `propose_action` is registered only when `capture.status` reports `actionEnabled`, and lists `proposableActionTypes` (capped at 200).
- Update `CaptureStatus` in `capture-gate.ts`:
  ```ts
  export interface CaptureStatus {
    readonly enabled: boolean;
    readonly kinds: readonly CaptureKind[];
    readonly actionEnabled: boolean;
    readonly proposableActionTypes?: readonly string[];
    readonly pending: number;
    readonly actionPending?: number;
    readonly maxPending: number;
    readonly actionMaxPending?: number;
    readonly maxPerHour: number;
    readonly refusedSinceStart: Readonly<Record<string, number>>;
    readonly disabledReason?: string;
  }
  ```

---

## 6. Resolution of Open Points in § 15

In § 15 of the spec, the following open point was left for planning verification:
> *"To verify at planning: whether the consent coordinator has its own TTL and what gate() returns when it fires — the plan must pin the terminal state for that path."*

**Code Verification Result:**
- In `packages/gateway/src/ipc/consent.ts`, `ConsentCoordinatorImpl` has **no internal timer or TTL**.
- It holds pending consent promises in a map until `handleRespond` is called or a client disconnects.
- The timeout is bounded by the client connection (`BATCH_RPC_TIMEOUT_MS = 6 hours` for CLI batch prompts, 30s default for regular RPC).
- If the CLI disconnects (e.g. user aborts or process kills): `onClientDisconnect` triggers `ConsentDisconnectedError`.
- In `packages/gateway/src/engine/executor.ts` lines 414–420, `ToolExecutor.gate()` explicitly catches `ConsentDisconnectedError`, records `hitlStatus = "rejected"`, appends a `blocked` egress entry, and returns `{ status: "rejected", reason: e.message }`.
- Therefore, when a client aborts or disconnects during consent, the capture terminal state is cleanly and deterministically **`rejected`**.

---

## 7. Suggested Improvements & Summary of Changes

| Area | Current Draft Spec | Recommended Adjustment |
|---|---|---|
| **Dispatch Routing** | Assumes first-party actions dispatch directly by `action.type` without changes to `registry.ts`. | Add first-party tool mapping in `connectors/registry.ts` or `tool-map.ts` (e.g. `slack.message.post` → `slack_message_post`); update Non-Goals. |
| **`act.execute` Interface** | `await act.execute(action, provenanceConsent)` but `ToolExecutor.execute` only takes `action`. | Define `execute(action, provenance)` in `capture-act.ts`; instantiate `ToolExecutor` per execution inside `capture-rpc.ts`. |
| **`submitCapture` Signature** | Assumed synchronous. | Make `submitCapture` `async` to support `isConnectorConfigured` Vault checks; inject `isConfigured` in `CaptureGateDeps`. |
| **Generic Action Types** | `email.send` and `calendar.event.create` in proposable list. | Define multi-provider resolver in `isConnectorConfigured` for generic services, or restrict proposable list to provider-specific types. |
| **Module Boundaries** | `action-proposability.ts` in `mcp-sink/` needs `isUserMcpActionType`. | Move `isUserMcpActionType` to `engine/service-of.ts` to prevent D32(f) violations. |
| **Schema Integrity** | Prose says actions never have item_id / native_ref. | Add `CHECK (kind <> 'action' OR (item_id IS NULL AND native_ref IS NULL))` to `capture` DDL. |
| **Store Pending Queues** | `countByState("proposed")` used for both queues. | Add `countPendingActions(nowMs)` (filtering unexpired) and `countPendingNative()` to `CaptureStore`. |
| **CLI Acceptance** | `assertAcceptResult` expects `state === "accepted"` and non-empty `nativeRef`. | Update `captures.ts` to support action outcomes (`executed`, `rejected`, `failed`) and enforce TTY check. |
| **Open Point § 15** | Consent coordinator TTL unconfirmed. | Document verified behavior: coordinator has no TTL; disconnect yields `rejected`. |

---
*End of review.*
