# Review & Feedback: Phase 6 Slice 7 — Wave 7b Team-Shared Credentials Design

**Review Date:** 2026-06-14  
**Design Document Reviewed:** [2026-06-14-phase6-slice7-wave7b-team-credentials-design.md](file:///C:/gitrep/Nimbus/.claude/worktrees/dev+asafgolombek+phase6-slice7-wave7b/docs/superpowers/specs/2026-06-14-phase6-slice7-wave7b-team-credentials-design.md)  
**Status:** Review Feedback / Suggestions / Open Questions

---

## 1. Process Spawning & Pagination (Addressing O2)

### Context
In **D5** (Transport unification) and **O2** (Pagination within one team spawn), the design proposes unifying both personal and team sync onto a spawn-based path where the gateway calls the connector's `<svc>_list` tool. Since sync involves exhaustive retrieval of items, pagination is necessary.

### Suggestion / Improvement
- **Avoid Spawn-Per-Page on Windows:** Process spawning is highly expensive on Windows (the host OS). Spawning a subprocess for *every page* of a sync operation will introduce severe latency and overhead.
- **Persistent/Session-Based Spawn during Sync:** We should design the helper to spawn the connector subprocess *once* for the duration of a sync cycle, keeping the process stdin/stdout channel alive, and calling `<svc>_list(cursor)` iteratively on that same client instance before tearing it down.
- **Streaming Alternative:** If the client/MCP transport supports it, we could also introduce a streaming channel or an option to return all items in chunks over a single process invocation. If not, the persistent-spawn/loop approach is the most efficient and robust.

---

## 2. Invariant I18 and `localOperator` Identity Validation

### Context
In **§5** (Principal-polymorphic gate) and **§7** (Security & invariants), the design says:
> `localOperator` → authorized by the **config pin**: the connector's `team_entry` resolves to an existing entry whose `service` matches the connector, **and** if `[identity]` is enabled, `identity.isOperatorValid()` must hold (I18).

### Open Questions
1. **Fallback when `[identity]` is disabled:** When a solo/single-player machine has `[identity]` disabled (the default for offline or local-only setups), does authorization succeed implicitly just by matching the config pin and Team Vault entry presence? We should explicitly document that if `[identity]` is disabled, the validity check is bypassed (or returns `true`), ensuring zero friction for local single-player setups.
2. **Expired Identity Flow:** If `[identity]` *is* enabled but `isOperatorValid()` returns false (e.g., OIDC token expired), the sync will fail. Do we write a specialized, actionable warning to the sync result/log indicating that the operator needs to re-authenticate (e.g., "Run `nimbus login` to re-authorize team credentials")?

---

## 3. Configuration Validation & Fail-Closed Error UX

### Context
In **§4** (Config schema), the validation states:
> `credential = "team"` with absent/empty `team_entry` → config error.

### Suggestions
- **Actionable Error Messaging:** When the config validation fails or when a configured `team_entry` is missing from the Team Vault, the error thrown must guide the user on how to resolve it. 
  - For example, if the entry `prod-snowflake` doesn't exist, the error message should say: 
    `Team vault entry "prod-snowflake" not found. Add it using: nimbus team-vault add prod-snowflake`
- **Config Migration Guard:** If a user upgrades Nimbus, we must ensure that existing connectors (which implicitly default to `"personal"`) continue to work seamlessly without forcing any config file updates. The back-compat section addresses this nicely, but we should verify that parsing defaults are robustly handled.

---

## 4. Audit Log Detail and Multi-User / Peer Traceability

### Context
In **§5** (Principal-polymorphic gate):
> Audit records the real principal: the `teamvault.invoke.<decision>` audit row carries `localOperator` (not a synthetic peer id).

### Suggestions / Open Questions
- **Distinguishing Operators in Audits:** While Nimbus is primarily local-first, the Team Vault and federation features support teams. If multiple operators share/access a Team Vault, does `localOperator` need to be annotated with the local system user name (e.g., OS username) or the validated OIDC identity subject (sub)? 
- **Recommendation:** If `[identity]` is enabled, the audit log should store the verified OIDC user identity/email alongside `localOperator` (e.g., `localOperator:user@org.com`) to provide authenticability in shared team environments, while falling back to a generic identifier (or system username) when `[identity]` is disabled.

---

## 5. Security & Invariant I19 Coverage

### Context
Invariant **I19** specifies: "team-vault secrets consumed only via `invoke-gate.ts` ... ephemeral team-credentialed connector; leak-proof result, fail-closed on missing secret."

### Suggestion
- Ensure that in the `security-invariants.test.ts` extension, we verify that calling the sync tool via the local-operator path does not leak the secret into the `SyncResult`, the indexed sqlite database, or the gateway logs.
- Add an explicit test case where the config specifies `credential = "team"` but the tool is invoked with a normal tool-invocation context that is *not* routed through the polymorphic gate, confirming that the tool fails to acquire the secret (fail-closed).
