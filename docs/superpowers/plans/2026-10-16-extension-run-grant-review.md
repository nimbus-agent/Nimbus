# Plan Review: Extension Run-Grant Store & Approval RPC (PR 2 of 4)

**Reviewed plan:** [`2026-10-16-extension-run-grant.md`](file:///C:/gitrep/Nimbus/.claude/worktrees/extension-run-grant/docs/superpowers/plans/2026-10-16-extension-run-grant.md)  
**Reference spec:** [`2026-10-11-extension-runtime-design.md`](file:///C:/gitrep/Nimbus/.claude/worktrees/extension-run-grant/docs/superpowers/specs/2026-10-11-extension-runtime-design.md)  
**Date:** 2026-10-16

---

## Executive Summary

The plan is well-structured, keeps the PR 2 blast radius tight (no subprocess spawning), and aligns closely with the § 11 spec amendments (`extension_run_grants` schema V69, `D33(b)` AST gate, `runState` truth table, LAN/Tauri RPC exclusions, and TTY-only CLI approval).

Cross-checking the plan against the current worktree surfaced **1 critical bug** (consent payload redaction), **3 spec/doc mismatches**, **3 CI/static-audit gate traps**, and **4 open questions / security-hardening suggestions**.

---

## 1. Critical Bug

### 1.1 `keyFingerprint` in `consentPayload` will be redacted to `"[REDACTED]"` by `ToolExecutor` (Task 4)

- **Where in plan:** Task 4, [`2026-10-16-extension-run-grant.md`](file:///C:/gitrep/Nimbus/.claude/worktrees/extension-run-grant/docs/superpowers/plans/2026-10-16-extension-run-grant.md#L1687-L1693) (`packages/gateway/src/extensions/approve-run.ts`):
  ```ts
  publisher:
    manifest.publisher === undefined
      ? "unsigned"
      : {
          id: manifest.publisher.id,
          keyFingerprint: publisherKeyFingerprint(manifest.publisher.key),
        },
  ```
- **Why it breaks:** Both [`redactPayloadForConsentDisplay`](file:///C:/gitrep/Nimbus/.claude/worktrees/extension-run-grant/packages/gateway/src/engine/executor.ts#L240-L254) in `packages/gateway/src/engine/executor.ts` and `redactAuditPayload` in `packages/gateway/src/audit/format-audit-payload.ts` recursively redact any object property whose key matches `SENSITIVE_PAYLOAD_KEY = /(token|key|secret|password|credential|bearer|auth)/i`. Because `"keyFingerprint"` contains `"key"`, both the interactive consent prompt and the `audit_log` row will replace the SHA-256 fingerprint with `"[REDACTED]"`.
- **Precedent in PR 1:** [`packages/gateway/src/extensions/install-from-local.ts`](file:///C:/gitrep/Nimbus/.claude/worktrees/extension-run-grant/packages/gateway/src/extensions/install-from-local.ts#L379-L384) hit and documented this exact trap:
  > *"`fingerprint` is the first 32 hex chars of SHA-256 over the decoded Ed25519 public key. It is deliberately NOT named `key`: the consent display redacts any payload field whose name contains 'key' (`executor.ts` `SENSITIVE_PAYLOAD_KEY`), which would hide the one value that lets the owner tell two publishers with the same id apart."*
- **Recommendation:**
  1. Rename `keyFingerprint` to `fingerprint` (or `pubFingerprint`) in `approve-run.ts` (and update Spec § 3.2 if keeping them 1:1).
  2. Add a test in `approve-run.test.ts` with a signed manifest (`publisher: { id, key, signature }`) that passes the payload through `redactPayloadForConsentDisplay` (or a real `ToolExecutor.requestWriteConsent` gate) and asserts the 32-char hex fingerprint survives unredacted.

---

## 2. Spec & Documentation Mismatches

### 2.1 Missing `demo-gate.ts` entries required by Spec § 4.8 (Task 5)

- **Where in spec:** [`2026-10-11-extension-runtime-design.md`](file:///C:/gitrep/Nimbus/.claude/worktrees/extension-run-grant/docs/superpowers/specs/2026-10-11-extension-runtime-design.md#L337) (§ 4.8 Lifecycle):
  > *"Demo-rooted gateway (I41) | Inert. No slot is registered, and `extension.approveRun` / `revokeRun` join `extension.install` in the demo gate (`ipc/server/demo-gate.ts`)."*
- **Where in codebase:** [`DEMO_REFUSED_METHODS`](file:///C:/gitrep/Nimbus/.claude/worktrees/extension-run-grant/packages/gateway/src/ipc/server/demo-gate.ts#L16-L21) in `packages/gateway/src/ipc/server/demo-gate.ts` currently lists `["vault.set", "vault.delete", "data.import", "extension.install"]`.
- **Gap:** Task 5 does not update `packages/gateway/src/ipc/server/demo-gate.ts` or [`demo-gate.test.ts`](file:///C:/gitrep/Nimbus/.claude/worktrees/extension-run-grant/packages/gateway/src/ipc/server/demo-gate.test.ts).
- **Open Question / Suggestion:** Should `extension.approveRun` and `extension.revokeRun` (and potentially `extension.rehash`) be added to `DEMO_REFUSED_METHODS` in Task 5 now so demo-mode gateways cannot mutate `extension_run_grants`?

### 2.2 `nimbus extension list` and `nimbus extension info` human output vs. `docs/cli-reference.md` (Tasks 7 & 8)

- **Where in plan:**
  - Task 5 adds `runGrant` and `runState` to the `extension.list` and `extension.info` RPC payloads.
  - Task 8 Step 1 ([`2026-10-16-extension-run-grant.md`](file:///C:/gitrep/Nimbus/.claude/worktrees/extension-run-grant/docs/superpowers/plans/2026-10-16-extension-run-grant.md#L2542)) updates `docs/cli-reference.md` to state that *"extension `list` / `info` now show `runState` and `runGrant`"*.
  - However, Task 7 ([`packages/cli/src/commands/extension.ts`](file:///C:/gitrep/Nimbus/.claude/worktrees/extension-run-grant/packages/cli/src/commands/extension.ts#L118-L202)) only adds `runExtensionApprove` and `runExtensionRevoke`. It does **not** update `formatExtensionListTable` or `runExtensionInfo` to render `runState` or `runGrant` in human-readable terminal output (they only appear when `--json` is passed).
- **Suggestion:** Update `formatExtensionListTable` (e.g., adding a `RUN` column showing `runState`) and `runExtensionInfo` (printing `Run state:` and `Run grant:`) in Task 7, and add assertions in [`packages/cli/src/commands/extension.test.ts`](file:///C:/gitrep/Nimbus/.claude/worktrees/extension-run-grant/packages/cli/src/commands/extension.test.ts).

---

## 3. Static Audit & CI Gate Traps

### 3.1 `check-status-drift.ts` will fail on `D10–D32` ceiling ranges once `D33(b)` lands (Tasks 3 & 8)

- **Why it breaks:** [`scripts/structure-audit/check-status-drift.ts`](file:///C:/gitrep/Nimbus/.claude/worktrees/extension-run-grant/scripts/structure-audit/check-status-drift.ts#L99-L134) dynamically computes `canonicalStaticRule` as the highest `D<N>` identifier in `check-nimbus-invariants.ts`. When Task 3 adds `D33(b)`, `canonicalStaticRule` becomes `33`. Every file in `CEILING_RANGE_SURFACES` (`CLAUDE.md`, `GEMINI.md`, `docs/architecture.md`, `docs/README.md`, `docs/SECURITY-INVARIANTS.md`, `.github/SECURITY.md`, `.coderabbit.yaml`, `.claude/commands/nimbus-*.md`) that still says `D10–D32` will fail `bun run audit:status-drift`.
- **Gap in Task 8:** Task 8 Step 2's grep command (`git grep -n "V69\b\|schema V68\|PR 1 of 4\|Installed extensions are not executed"`) does not search for `D32`.
- **Suggestion:** Add `D32` (and `D10–D32`) to the Task 8 Step 2 grep command and explicitly list the `D10–D32` → `D10–D33` sweep across `CEILING_RANGE_SURFACES`.

### 3.2 Missing `RULE_ANCHORS` entry in `check-nimbus-invariants.ts` (Task 3)

- **Where in codebase:** [`RULE_ANCHORS`](file:///C:/gitrep/Nimbus/.claude/worktrees/extension-run-grant/scripts/structure-audit/check-nimbus-invariants.ts#L2586-L2675) in `scripts/structure-audit/check-nimbus-invariants.ts` pairs each D-rule with a concrete production file path so `verifyRuleAnchors()` fails if `iterateSourceFiles()` ever stops reaching that directory.
- **Suggestion:** Add `"packages/gateway/src/extensions/approve-run.ts"` (or `"packages/gateway/src/extensions/run-grant-store.ts"`) to `RULE_ANCHORS` in Task 3.

### 3.3 `package.json` `test:coverage:extensions` uses an explicit file list, not a glob (Task 8)

- **Where in codebase:** Root [`package.json`](file:///C:/gitrep/Nimbus/.claude/worktrees/extension-run-grant/package.json#L127) defines `"test:coverage:extensions"` as an explicit list of test files (`packages/gateway/src/extensions/install-from-local.test.ts`, `manifest.test.ts`, etc.) rather than a glob.
- **Suggestion:** In Task 8, append the 5 new extension test files (`extension-service-id.test.ts`, `extension-run-grants.test.ts`, `run-grant-store.test.ts`, `approve-run.test.ts`, `run-state.test.ts`) to `"test:coverage:extensions"` in `package.json` so coverage runs include PR 2's unit tests.

---

## 4. Security Hardening & Edge-Case Suggestions

### 4.1 Post-consent TOCTOU check on symlink retargeting outside `install_path` (Task 4)

- **Where in plan:** In [`approve-run.ts`](file:///C:/gitrep/Nimbus/.claude/worktrees/extension-run-grant/docs/superpowers/plans/2026-10-16-extension-run-grant.md#L1748-L1760), after `await deps.gate(...)` returns `true` (which waits on human terminal input), the code re-checks:
  ```ts
  const after = deps.extensionStore.get(id);
  if (
    after === undefined ||
    after.enabled !== 1 ||
    after.version !== row.version ||
    after.tree_digest !== treeDigest ||
    digestOrNull(after.install_path) !== treeDigest
  ) { ... }
  ```
- **Edge case:** `digestOrNull(after.install_path) !== treeDigest` catches any modification to files inside `install_path` while the user was reading the prompt. However, if the manifest declares a `filesystem.read` or `filesystem.write` path outside `install_path`, and a symlink along that external path is retargeted to a protected path (e.g. `dataDir`) while the prompt is open, `treeDigest` will not change.
- **Suggestion:** Re-run `resolveExtensionRunGrants(manifest.permissions, after.install_path, deps.env)` after `deps.gate(...)` returns `true` and verify `serializeRunGrants(recheckedGrants) === permissionsJson` before calling `upsertExtensionRunGrant`.

### 4.2 Checking `signatureDisabledRegistry` (or I16 signature) in `approveExtensionRun` (Task 4)

- **Where in plan:** `assertRunnable(row)` in `approve-run.ts` checks `row.enabled !== 1`, `verifyOneExtensionStrict(row)` (`manifest_hash` + `entry_hash`), and `computeExtensionTreeDigest(row.install_path)`.
- **Edge case:** `verifyOneExtensionStrict` does not check `signatureDisabledRegistry.has(row.id)` (from [`verify-extensions.ts`](file:///C:/gitrep/Nimbus/.claude/worktrees/extension-run-grant/packages/gateway/src/extensions/verify-extensions.ts#L50-L56)) or re-verify the Ed25519 publisher signature against the Vault. If an extension failed signature verification at startup (which sets `enabled = 0` and records `id` in `signatureDisabledRegistry`), and the user later called `extension.enable` (which flips `enabled = 1` in SQLite without re-verifying the signature), `approveExtensionRun` would allow approving it.
- **Open Question / Suggestion:** Should `assertRunnable` in `approve-run.ts` also reject when `signatureDisabledRegistry.has(row.id)` (and/or should `extension.enable` refuse to enable extensions in `signatureDisabledRegistry`)?

### 4.3 Canonicalize `row.install_path` in `consentPayload.filesystem.runtimeRead` (Task 4)

- **Where in plan:** [`approve-run.ts`](file:///C:/gitrep/Nimbus/.claude/worktrees/extension-run-grant/docs/superpowers/plans/2026-10-16-extension-run-grant.md#L1695-L1700) constructs:
  ```ts
  filesystem: {
    read: grants.filesystem.read,
    write: grants.filesystem.write,
    runtimeRead: [row.install_path, ...env.runtimeReadPaths],
  },
  ```
- **Observation:** `grants.filesystem.read` and `grants.filesystem.write` are canonicalized via `env.realpath(...)` inside `resolveExtensionRunGrants`, whereas `runtimeRead` uses the raw `row.install_path` (which on Windows or symlinked temp dirs may differ in short-path/casing/symlink form from `grants.filesystem.read`).
- **Suggestion:** Use the canonicalized install path (via `env.realpath(row.install_path)` with fallback) in `runtimeRead` so all paths shown in the consent prompt share a consistent canonical format.

---

## 5. Minor Open Questions

1. **Gateway event emission on `approveRun` / `revokeRun` (Task 5):**
   - `extension.install`, `extension.update`, `extension.enable`, `extension.disable`, and `extension.remove` all call `emitGatewayEvent("extension.stateChanged", ...)` in [`packages/gateway/src/ipc/automation-rpc.ts`](file:///C:/gitrep/Nimbus/.claude/worktrees/extension-run-grant/packages/gateway/src/ipc/automation-rpc.ts). Since `extension.list` and `extension.info` now include `runState`, should `extension.approveRun` and `extension.revokeRun` also emit `extension.stateChanged` so any connected UI refreshes its extension state?
2. **`NIMBUS_SCRIPT_CONSENT_SOURCE` interaction with `nimbus extension approve` (Task 7):**
   - Task 7 calls `registerConsentFor(client, { kind: "prompt" })` in `runExtensionApprove`. In [`packages/cli/src/lib/interactive-ipc-handlers.ts`](file:///C:/gitrep/Nimbus/.claude/worktrees/extension-run-grant/packages/cli/src/lib/interactive-ipc-handlers.ts#L203-L211), `{ kind: "prompt" }` checks `process.env["NIMBUS_SCRIPT_CONSENT_SOURCE"]` before falling back to interactive terminal prompting. Because `runExtensionApprove` checks `deps.isTTY()` first, non-TTY script pipes are blocked, while E2E tests in a PTY or with `isTTY: () => true` can still drive consent if needed. Worth confirming whether `approve` should ever honor `NIMBUS_SCRIPT_CONSENT_SOURCE` in a real TTY or always call `registerConsentPromptHandler(client)` directly.
