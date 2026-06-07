# Plan Review: Phase 6 Slice 2 — Team Vault + Multi-user/Quorum HITL

Review of the implementation plan: [2026-06-06-phase6-slice2-team-vault-quorum-hitl.md](2026-06-06-phase6-slice2-team-vault-quorum-hitl.md)

---

## 1. Naming Consistency (RPC & CLI)

* **Inconsistency in Task 19:**
  * The description mentions: *"invoke calls `federation.ask-invoke` with peer/entry/tool"*.
  * The test assertion expects: `expect(calls[0]?.method).toBe("federation.askInvoke");`.
  * The implementation note says: *"Add an asker-side `federation.askInvoke` to `federation-rpc.ts` mirroring `federation.ask`"*.
  * **Recommendation:** Standardize on camelCase `federation.askInvoke` to match `federation.ask` / `federation.askExpertise`.

---

## 2. Gating of Local `teamvault.put` and `teamvault.delete`

* **Observation:**
  * Task 14 specifies adding `teamvault.put` and `teamvault.delete` to `HITL_REQUIRED_BACKING` in `executor.ts`.
  * Currently, local vault actions like `vault.set` are gated inside `packages/gateway/src/ipc/server/vault-dispatch.ts` via `dispatchVaultGated` which intercepts the methods and calls `toolExecutor.gate()`.
  * **Recommendation:** Clarify in Task 14 or 17 where `teamvault.put`/`teamvault.delete` gating actually occurs. If they are dispatched via `dispatchTeamVaultRpc` (Task 14), we should either pass `toolExecutor` directly to the RPC handler or handle the delegation gating at the dispatcher level (similar to `dispatchVaultGated` in `vault-dispatch.ts`).

---

## 3. Delegation Scope Resolution

* **Observation:**
  * In Task 7, `DelegationStore.activeDelegateFor` performs an exact match on `scope_kind` and `scope_value`:

    ```ts
    `SELECT 1 AS one FROM hitl_delegations
     WHERE scope_kind = ? AND scope_value = ? AND delegate_peer = ?
       AND revoked_at IS NULL AND expires_at > ?`
    ```

  * During a HITL gate evaluation (such as executing an AWS tool), the action might belong to service `aws` (scope kind: `service`, value: `aws`) or have a specific action type (scope kind: `action_type`, value: `aws.ec2.instance.stop`).
  * **Suggestion:** Ensure the caller of `isActiveDelegate` in the executor layer queries *both* potential delegation scopes:
    1. A delegation matching `scopeKind = 'action_type'` and `scopeValue = actionType`.
    2. A delegation matching `scopeKind = 'service'` and `scopeValue = serviceName` (parsed from the action type's namespace prefix).
    This logic should be explicitly documented or handled in the integration gate.

---

## 4. Resolving Vault Secret Keys for Injection

* **Observation:**
  * Task 17 mentions that `runTool` is *"a closure that injects `teamvault.<entry>.<key>` secrets and dispatches the connector tool through the executor"*.
  * **Suggestion:** To correctly inject these secrets, the closure needs to know which keys belong to the given service. It should consult the manifest registry (`CONNECTOR_VAULT_SECRET_KEYS` in `packages/gateway/src/connectors/connector-secrets-manifest.ts` or the connector catalog) to resolve the list of secret keys for the active service, look them up in the OS Vault using the `teamVaultKey(entry, key)` format, and map them to the execution environment / tool arguments.

---

## 5. DB Grants Table Mutability & Audit Trail

* **Observation:**
  * `team_vault_grants` uses `PRIMARY KEY (entry, peer_id, tool_id)`.
  * When revoking, we update `revoked_at`. When re-granting, we do `ON CONFLICT DO UPDATE` to clear `revoked_at`.
  * This is correct and keeps the table size minimal, but means historical grants/revocations for the same user/tool are overwritten in the grants table.
  * **Note:** This is perfectly fine since all changes are also appended to the tamper-evident audit log via `appendTeamVaultAudit`. Just ensure the audit log remains the authoritative source for any compliance or security history.
