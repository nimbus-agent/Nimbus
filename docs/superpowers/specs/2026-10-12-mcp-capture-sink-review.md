# Review: S3 — MCP Capture Sink (I28) Design

> **Review Date:** 2026-10-12  
> **Document Reviewed:** `2026-10-11-mcp-capture-sink-design.md`  
> **Target Branch:** `dev/asaf/s3-mcp-capture-sink`  
> **Reviewer:** Antigravity / Pair Programming Agent  

---

## 1. Executive Summary

The design document is exceptionally well-structured, adhering to Nimbus's established engineering principles:
- **Blast-radius tiering** (notes live unreviewed, decisions/terms/links HITL-gated).
- **Zero-egress boundary** (`nimbus prove` unaffected, stdio transport only).
- **Strict invariant discipline** (I28 gate, I31 provenance disclosure, I32 whitelist rebuilds, D32 static confinement).
- **Fail-closed posture** on capability and policy checks.

However, a thorough cross-examination against the existing codebase (`packages/gateway` and `packages/cli`) revealed **three critical architectural blockers** and several **lifecycle, security, and schema edge cases** that need resolution before implementing PR 1 and PR 2.

---

## 2. Critical Issues & Architectural Blockers (Must Fix)

### 2.1 Item ID Visibility Gap in MCP Read Tools
- **The Problem:**
  - § 4.2 specifies that `relatesTo`, `evidence`, `fromItemId`, and `toItemId` must be existing `item` IDs.
  - § 4.2 states: `Item-existence check is one SELECT id FROM item WHERE id IN (...)`.
  - In `item`, the primary key is `service:externalId` (e.g. `github:123`, `filesystem:/path/to/file`).
  - **However**, in `packages/cli/src/mcp/adapter.ts`, `searchIndex` and browse tools project items using `projectRankedItem()`. `projectRankedItem()` explicitly picks:
    `name`, `service`, `type`, `url`, `score`, `modifiedAt`, `semanticSnippet`, `meta`.
    **It completely omits `id` and `indexPrimaryKey`!**
- **Impact:**
  - An MCP client (Claude Code, Cursor) reading search results has **no way to know an item's ID**.
  - Any attempt by the agent to pass IDs to `capture_note(relatesTo)`, `propose_decision(evidence)`, or `propose_link(fromItemId, toItemId)` will either fail because the agent hallucinates IDs, passes bare titles/URLs, or fails validation.
- **Required Fix:**
  1. In `packages/cli/src/mcp/adapter.ts`, update `projectRankedItem()` to expose `id: r["indexPrimaryKey"] ?? r["id"]`.
  2. In `packages/cli/src/mcp/capture-tools.ts`, explicitly document in tool descriptions that item IDs must match the `id` field returned by `searchIndex` / browse tools.

---

### 2.2 Zombie Link Proposals: `nimbus:capture` Missing from Graph Entities
- **The Problem:**
  - § 4.2 allows `fromItemId` and `toItemId` in `propose_link` to be `nimbus:capture` items:
    > *"A referenced id that is itself a nimbus:capture item is allowed only when that capture is live or accepted."*
  - § 5.2 defines the link acceptance precondition:
    > *"link — each endpoint must resolve to an existing graph_entity with external_id = <itemId> and type ∈ ITEM_LINKED_ENTITY_TYPES (graph/relationship-graph.ts). Else ERR_CAPTURE_LINK_UNRESOLVED; the capture stays proposed so it can be accepted after a regraph."*
  - **However**, `ITEM_LINKED_ENTITY_TYPES` (`graph/relationship-graph.ts`) consists of:
    `pr`, `issue`, `ci_run`, `deployment`, `alert`, `message`, `incident`, `error_issue`, `git_commit`, `dependency`, `api_endpoint`, `code_symbol`, `obsidian_note`, `data_model`, `dashboard`, `data_quality_test`, `review`.
  - Neither `capture` nor `note` is in `ITEM_LINKED_ENTITY_TYPES`. Furthermore, `syncGraphFromIndexedItem` in `graph-populator.ts` ignores any item whose type is not in this list.
- **Impact:**
  - A note created via `capture_note` creates an item (`service = "nimbus"`, `type = "capture"`), but **never creates a `graph_entity`**.
  - If an agent proposes a link where either `fromItemId` or `toItemId` is a capture item (e.g. linking a note to a PR or issue), `acceptCapture` will **always fail** with `ERR_CAPTURE_LINK_UNRESOLVED`.
  - Running `nimbus index regraph` will never resolve it. The proposal becomes a permanent zombie that can never be accepted.
- **Required Fix:**
  Choose one of two clear models:
  - **Option A (Capture Notes in Graph):** Add `capture` (or `agent_note`) to `ITEM_LINKED_ENTITY_TYPES` and have `graph-populator.ts` upsert a `graph_entity` when a `nimbus:capture` note is written.
  - **Option B (Links Restrict to Connector Items Only):** Disallow `nimbus:capture` item IDs in `propose_link` at submit-time validation, restricting graph links strictly to connector-indexed entities, while keeping `relatesTo` metadata for notes.

---

### 2.3 Foreign Key Cascade Risk on V67 `decision_record` Migration
- **The Problem:**
  - § 4.4 states:
    > *"Table rebuilds (the V46 glossary_term rebuild is the precedent; follow nimbus-db-migrations):*  
    > *- decision_record.extraction_source CHECK widens to ('llm','snippet','agent')."*
  - In `glossary-manual-v46-sql.ts`, rebuilding `glossary_term` was safe because no table referenced it.
  - **However**, in `decisions-v47-sql.ts`:
    ```sql
    CREATE TABLE decision_evidence (
      decision_id TEXT NOT NULL REFERENCES decision_record(id) ON DELETE CASCADE,
      ...
    );
    ```
  - In Nimbus production runtime, `local-index.ts` enables foreign keys: `PRAGMA foreign_keys = ON;`.
- **Impact:**
  - If the migration runner executes a naive table rebuild (`CREATE TABLE decision_record_v67 ...; INSERT ...; DROP TABLE decision_record; ALTER TABLE ... RENAME;`), dropping `decision_record` while foreign keys are ON will **cascade-delete all existing `decision_evidence` rows in production** or fail with a constraint violation.
- **Required Fix:**
  - The spec must specify that V67 migration follows SQLite's 12-step table rebuild procedure:
    1. `PRAGMA foreign_keys = OFF;`
    2. Rebuild and copy `decision_record`.
    3. Run `PRAGMA foreign_key_check;`.
    4. Re-enable `PRAGMA foreign_keys = ON;`.
  - Alternatively, rebuild `decision_evidence` alongside `decision_record` in the same migration step.

---

## 3. State Machine, Storage & Lifecycle Gaps

### 3.1 Duplicate / Overlapping Glossary Term Proposals
- **Scenario:**
  Agent A proposes term `"chokepoint"`. The owner accepts it.
  `glossary_term` now has `term_key = "chokepoint"`, `definition_source = 'agent'`.
  Later, Agent B proposes an updated definition for `"chokepoint"`.
- **Open Questions in § 5.2 & § 5.3:**
  1. What happens when the owner accepts the second capture?
     - § 5.2 only checks: `status = 'vetoed'` or `definition_source = 'manual'`.
     - Does the second accept overwrite the existing `definition_source = 'agent'` row? If so, does it succeed or throw?
  2. What happens if the owner subsequently revokes the first capture?
     - § 5.3 says: `glossary row deleted only if it is still definition_source='agent'`.
     - Revoking Capture A would delete the term from `glossary_term`, even though Capture B is still in `accepted` state!
- **Recommendation:**
  - On `acceptCapture`: If an existing row has `definition_source = 'agent'`, allow the update but update the term's origin reference.
  - On `revokeCapture`: Store the `capture_id` in `glossary_term` (or match `updated_at` / `native_ref`) so revoking an older superseded proposal does not delete an active term accepted by a newer proposal.

---

### 3.2 Rejection Metadata and Retention Anchor
- **The Problem:**
  - § 4.1 defines `decided_at INTEGER` in `capture`.
  - § 5.2 states that `acceptCapture` sets `decided_at = now`.
  - For `rejectCapture`, § 5.2 states:
    > *"rejectCapture = steps 1–3, then state='rejected', audit capture.reject with hitl_status='rejected'. Nothing native is written."*
  - Notice `decided_at` is **not set** on rejection.
  - § 4.5 states:
    > *"rejected rows older than 90 days are deleted by the existing nightly prune hook"*
- **Open Question:**
  - Is retention calculated from `created_at` or `decided_at`?
  - If a proposal sits pending for 85 days and the owner rejects it on day 86, is it pruned 5 days later or 90 days after the owner's decision?
- **Recommendation:**
  1. Have `rejectCapture` set `decided_at = Date.now()`.
  2. Retention pruning query: `WHERE state = 'rejected' AND COALESCE(decided_at, created_at) < :cutoff`.
  3. Support an optional rejection reason: `nimbus captures reject <id> [--reason <text>]` recorded in the audit entry and/or capture table.

---

### 3.3 Tombstone Cleansing on Revoke
- § 4.1 specifies:
  `CHECK ((state = 'revoked') = (payload_json IS NULL))`
- § 5.3 states:
  `set state='revoked', payload_json=NULL, item_id=NULL;`
- **Question:** What about `native_ref` and `client_label` on revoke?
  - Does `native_ref` stay populated for audit/forensics, or is it cleared?
  - Keeping `native_ref` (e.g. which decision ID or graph edge was unlinked) is useful for post-mortem analysis. Clarify that `native_ref` remains preserved.

---

## 4. Security, Rate Limiting & Denial-of-Service

### 4.1 Audit Log Flooding on Refusals (Disk DoS Risk)
- **The Problem:**
  - § 5.1 Step 6 enforces `max_per_hour` (in-memory sliding window).
  - § 5.1 Step 9 states:
    > *"A refusal at steps 1–7 also appends one row with outcome: <code> and no payload. An audit append failure rolls back the write (fail-closed)."*
- **Vulnerability:**
  - In-memory rate limiting is designed to prevent abusive or runaway agents from consuming disk I/O and database write locks.
  - If a rate-limited request (`ERR_CAPTURE_RATE_LIMITED` at step 6) triggers `appendAuditEntry(db, ...)`, an agent sending 50,000 requests/sec will force 50,000 SQLite write transactions and SHA-256 hash-chain computations.
  - Similarly, when `[mcp_sink]` is disabled (`ERR_CAPTURE_DISABLED` at step 1), writing audit entries forces database writes for a feature that is supposed to be turned off.
- **Recommendation:**
  - Do **not** append an audit entry for `ERR_CAPTURE_RATE_LIMITED` and `ERR_CAPTURE_DISABLED`.
  - Only audit gate refusals where client capability was authorized and rate-limits passed, but semantic validation failed (e.g. `ERR_CAPTURE_INVALID`, `ERR_CAPTURE_UNKNOWN_ITEM`, `ERR_CAPTURE_QUEUE_FULL`).

---

### 4.2 Ephemeral `session_id` vs. Rate Limit Durability
- **The Problem:**
  - § 4.1 defines `session_id TEXT NOT NULL, -- gateway clientId of the submitting connection`.
  - § 4.1 defines `CREATE INDEX idx_capture_session_created ON capture(session_id, created_at DESC);`.
  - In `packages/gateway/src/ipc/server/server.ts`, `clientId` is generated as `randomUUID()` on every socket connection.
- **Questions & Observations:**
  1. Because `clientId` is ephemeral per connection, if Claude Code or Cursor disconnects/reconnects or starts a new subprocess, its in-memory sliding window resets to zero immediately.
  2. If the rate limit is strictly in-memory, what is the database index `idx_capture_session_created` used for? The spec does not describe any query filtering by `session_id`.
- **Recommendation:**
  - Either utilize the database index to enforce durable sliding-hour rate limits across reconnects:
    `SELECT COUNT(*) FROM capture WHERE session_id = ? AND created_at > ?`
  - Or, if keeping in-memory rate limiting, remove `idx_capture_session_created` to avoid index maintenance overhead on inserts.

---

### 4.3 Client Kind Policy: `unknown` Mapped to `owner`
- § 5.1 & § 5.2 map client kinds via `Record<ClientKind, "submit" | "owner" | "refuse">`:
  - `mcp` -> `submit`
  - `cli`, `ui`, `unknown` -> `owner`
- **Context:**
  In Nimbus, `USER_MCP_OFFER_BY_KIND` maps `unknown` to `true` because standard CLI commands connect without declaring kind.
- **Security Implication:**
  An un-declared client (any process connecting to the Unix socket that omits `session.declareKind("mcp")`) inherits full `owner` privileges (`captures.accept`, `captures.reject`, `captures.revoke`).
- **Improvement:**
  - Update `packages/cli/src/` to have `nimbus captures` explicitly invoke `session.declareKind("cli")`.
  - Document explicitly that local Unix socket trust assumes any process capable of opening the socket represents the local user, but `session.declareKind("cli")` is preferred.

---

## 5. IPC, LAN & Routing

### 5.1 LAN Denylist by Namespace Prefix
- § 7 states:
  > *"LAN: all seven added to the checkLanMethodAllowed denylist (it is a denylist; a new namespace is LAN-reachable by default)."*
- In `packages/gateway/src/ipc/lan-rpc.ts`:
  ```ts
  const ns = method.split(".")[0] ?? "";
  if (FORBIDDEN_OVER_LAN.has(ns) || FORBIDDEN_OVER_LAN.has(method)) { ... }
  ```
- **Improvement:**
  Instead of naming 7 discrete methods in `FORBIDDEN_OVER_LAN`, add the top-level namespaces `"capture"` and `"captures"` to `FORBIDDEN_OVER_LAN`. This guarantees that any future method added to either namespace is automatically blocked over LAN without risking accidental exposure.

---

## 6. Disclosure Anchors (I31) & Synthesis Contract

- § 5.4 specifies:
  > *"- nimbus decisions / nimbus why render an accepted extraction_source='agent' decision with a disclosure line: 'Agent-authored (captured via MCP, accepted by the owner on <date>).'  
  > - Each sentence is defined once in agents/_lib/brief-disclosures.ts with its anchors, so the synthesis guard (contractViolations) fails a rewrite that drops it."*
- **Implementation Note:**
  In `brief-disclosures.ts`, anchors are checked via substring matching during synthesis verification.
  Because `<date>` is variable, the anchor defined in `brief-disclosures.ts` must be the static prefix:
  `"Agent-authored (captured via MCP, accepted by the owner on "`
  Document this explicitly in § 5.4 so the synthesis guard implementation in PR 2 does not attempt an exact match on a dynamic timestamp.

---

## 7. Operator & CLI Experience Suggestions

### 7.1 Queue Overflow Visibility in `nimbus doctor`
- § 8.3 notes:
  > *"`nimbus doctor` adds one line when `[mcp_sink]` is enabled and proposals are pending (`N captures awaiting review — nimbus captures`)."*
- **Suggestion:**
  When `pending >= max_pending`, `nimbus doctor` should highlight this as a warning:
  `⚠️ Capture queue full: 100/100 proposals pending review. New proposals from agents are currently REFUSED. Run 'nimbus captures' to review.`

### 7.2 CLI Review Ergonomics
- Add support for accepting/rejecting multiple captures in one command:
  `nimbus captures accept cap_01... cap_02...`
- Provide a summary table format for `nimbus captures list`:
  ```
  ID            KIND      SUBMITTED    CLIENT        PREVIEW
  cap_01J...    decision  10m ago      claude-code   "Adopt SQLite WAL mode for..."
  cap_01J...    term      1h ago       cursor        "chokepoint: invariant gate..."
  ```

---

## 8. Summary of Action Items for Spec Revision

| Section | Issue | Recommended Action |
|---|---|---|
| **§ 4.2 / § 6** | `projectRankedItem` drops item IDs | Specify updating `projectRankedItem` in `adapter.ts` to output `id: item.indexPrimaryKey`. |
| **§ 4.2 / § 5.2** | `nimbus:capture` not in graph entity types | Clarify whether notes are populated into graph entities or if `propose_link` must reject capture item IDs. |
| **§ 4.4** | V67 table rebuild risks deleting `decision_evidence` | Specify `PRAGMA foreign_keys = OFF` and integrity checks for `decision_record` rebuild. |
| **§ 5.1** | Refusal audit logging creates disk DoS vector | Exclude `ERR_CAPTURE_RATE_LIMITED` and `ERR_CAPTURE_DISABLED` from writing audit log entries. |
| **§ 5.2 / § 5.3** | Duplicate glossary term proposals conflict | Define explicit overwrite and revoke rules when an existing term has `definition_source = 'agent'`. |
| **§ 4.1 / § 5.2** | `rejectCapture` doesn't set `decided_at` | Record `decided_at = now` on rejection and align 90-day retention pruning with `decided_at`. |
| **§ 7** | LAN denylist method listing | Add namespaces `"capture"` and `"captures"` to `FORBIDDEN_OVER_LAN` rather than 7 individual method names. |
| **§ 5.4** | Dynamic date in I31 disclosure anchor | Specify static substring anchor prefix for `brief-disclosures.ts`. |
