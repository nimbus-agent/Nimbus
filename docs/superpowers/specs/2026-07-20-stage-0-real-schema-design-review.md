# Stage 0 (Revised) Design Review — Feedback, Suggestions, and Open Questions

This document reviews the revised design specification for **Stage 0: Seal the Narrow Waist Against the Real Schema** ([2026-07-20-stage-0-real-schema-design.md](file:///C:/gitrep/Nimbus/.claude/worktrees/stage0-real-schema/docs/superpowers/specs/2026-07-20-stage-0-real-schema-design.md)).

---

## 1. Open Questions & Technical Clarifications

### Q1.1: Handling of Non-CamelCase DB fields in `rowToItem`

* **Observation:** The spec notes that `rowToItem` (`local-index.ts:161`) and `applyItemMetadataColumn` are the exact inverse of writing. However, does `rowToItem` currently handle all required camelCase properties, or are there additional properties from the V3 columns (such as `pinned`, `synced_at`, `body_preview`, `author_id`) that are expected to be on `NimbusItem` in the future?
* **Question:** If the VS Code extension or future client features need `synced_at` or `pinned`, should they be added to `NimbusItem` in Task A/B, or are they strictly out of scope for Stage 0? If out of scope, does the current `rowToItem` discard them entirely, or keep them in `rawMeta`?

### Q1.2: Uniqueness and Format of `indexPrimaryKey`

* **Observation:** The spec introduces `indexPrimaryKey = r.id` (where `r.id` is the `service:external_id` composite key from the DB, and `rowToItem` sets the returned `id` to just `external_id`).
* **Question:** Is there any scenario where `r.id` is not present, or is `r.id` guaranteed to be a non-null primary key in the SQLite schema? Let's verify if all queries to `item` are guaranteed to return this.

### Q1.3: Version Skew & Graceful Degradation in VS Code / Clients

* **Observation:** A client using `@nimbus-dev/client@0.6.0` against a pre-Task-A gateway will reject all rows with `IpcResponseError` (due to the presence of snake_case fields).
* **Question:** Can we make the validator in `@nimbus-dev/client@0.6.0` fallback gracefully or log a warning instead of hard-throwing `IpcResponseError` (which would crash the VS Code sidebar completely if a user updates the extension before updating the gateway)? Or is a hard fail-closed approach preferred to enforce correct pairings?

---

## 2. Suggested Improvements & Refinements

### Suggestion 2.1: Add a Schema Invariant Test Check (`scripts/structure-audit/`)

* **Context:** The project uses static analysis (`check-nimbus-invariants.ts`) to enforce security and architectural rules.
* **Suggestion:** We should add a static rule checking that `rpcIndexQueryItems` does not directly return query rows without wrapping them in `rowToItem` (or passing them through the mapper). This prevents future developers from introducing a direct database-row leak over IPC again.

### Suggestion 2.2: Verifying Codicon Mapping and Fallback in Task C

* **Context:** In Task C, we map a select list of types to VS Code Codicons.
* **Suggestion:** Ensure the fallback icon has high contrast and is distinct from standard file/folder icons (e.g., using `symbol-misc` or `info` for generic items, rather than mapping unknown types to a generic document/file icon which might confuse users about the item's true nature).

### Suggestion 2.3: Standardize the IPC Payload Envelope

* **Context:** The response shape is proposed as:

  ```json
  { "kind": "hit", "value": { "items": [], "meta": { "limit": 50, "total": 1 } } }
  ```

* **Suggestion:** Verify that this payload structure aligns with the `@nimbus-dev/client` standard envelope format (e.g., matching common patterns in `nimbus-ipc` and existing RPC responses).
