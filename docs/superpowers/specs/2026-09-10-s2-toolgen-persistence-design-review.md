# Design Review: S2 — Runtime Tool Generation, PR 3: Persistence + Signing

**Date:** 2026-09-10  
**Reviewer:** Antigravity (AI Coding Assistant)  
**Status:** Review Complete — Approved with Critical Implementation & Architectural Resolutions  
**Target Spec:** [`2026-09-10-s2-toolgen-persistence-design.md`](./2026-09-10-s2-toolgen-persistence-design.md)  
**Parent Spec:** [`2026-09-09-s2-runtime-tool-generation-design.md`](./2026-09-09-s2-runtime-tool-generation-design.md)  
**Sibling Spec:** [`2026-09-09-s2-toolgen-drafting-design.md`](./2026-09-09-s2-toolgen-drafting-design.md)  
**Spine Slot:** [Spine S2 — Local Compute Fleet](../../roadmap.md#active)  
**Relevant Invariants & Rules:** Invariant **I40** (Saved Tool Integrity & Keypair Verification), Invariant **I39** (Runtime Tool Generation Gate & Confinement), Invariant **I2** (HITL Frozen Set), Invariant **I10** (Constant-time Comparison), Static Rules **D29(a–d)**, Schema **V61** (`generated_tool`)

---

## 1. Executive Summary & Architectural Assessment

The design specification for **PR 3: Persistence + Signing** completes the runtime tool generation subsystem by providing a durable, cryptographically verified promotion mechanism (`nimbus tool save <tool-id>`). It addresses the core architectural challenge of **standing approvals**: ensuring that a tool approved for execution across gateway restarts executes only the exact bytes the human saw, while upholding strict air-gap and secret isolation properties.

### Key Architectural Strengths

1. **Precise Threat Modeling & Cryptographic Grounding (§ 2):**  
   The spec correctly rectifies the parent document's premise by identifying that hash verification in SQLite defends against out-of-band disk modification only if the database is trusted. Using a local Ed25519 signature verified against a Vault-held public key isolates the trust boundary to DPAPI / Keychain / libsecret, properly defending against an attacker with local filesystem write access.
2. **Dedicated Store vs. Extension Subsystem (§ 3):**  
   Rejecting the reuse of `extensions/local.*` is architecturally sound. Saved tools do not need extension dependency resolution, auto-update mechanisms, or registry clients. Placing saved tools in `<configDir>/toolgen/saved/<toolId>` avoids polluting the extension lifecycle while maintaining a clean sibling relationship with `toolgen/ephemeral/`.
3. **Decoupled Secret Lifecycle — "The Approval Persists, The Secret Does Not" (§ 8):**  
   Persisting code execution capability while intentionally wiping secrets at session shutdown prevents the creation of unattended ambient capabilities. This design choice strikes the right security balance for local-first agentic computing.
4. **Exhaustive Vault Sweeps & Orphan Reclamation (§ 8.2):**  
   Discovering and addressing the pre-existing credential leak from ephemeral tools by sweeping `listKeys("toolgen.")` (retaining only `toolgen.signing.*`) at boot and shutdown guarantees that orphaned secrets never accumulate indefinitely in the OS keychain.
5. **Separate Human Consent for Persistence (§ 6.1):**  
   Treating persistence as a distinct, un-reusable capability transition ("run this now in this session" vs. "run this in every future session standing") via the `tool.save` HITL action type (joining `HITL_REQUIRED_BACKING`) prevents privilege escalation via implicit re-scoping.

---

## 2. Critical Implementation Blockers & Code-Level Traps

### 2.1 Manifest Path Invalidation / Sandboxed Filesystem Grant Mismatch

- **Context in Spec (§ 3, § 6, § 7) & Substrate (`toolgen-stub.ts`, `toolgen-artifact.ts`):**  
  In PR 1/2, when an ephemeral tool is created:

  ```ts
  const manifest = buildGeneratedManifest(toolId, {
    scriptDir: deps.scriptDir(toolId), // -> <configDir>/toolgen/ephemeral/<toolId>
    runtimeReadPaths: runtime.requiredReadPaths(),
  });
  ```

  `manifest.permissions.filesystem.read` contains `[ "<configDir>/toolgen/ephemeral/<toolId>", ...runtimeReadPaths ]`.  
  `artifact.manifest` is hashed as part of `canonicalArtifactBytes(artifact)` and signed into `artifact.sig`.

- **The Trap:**  
  When `nimbus tool save <toolId>` runs:
  1. The approved script is written to `<configDir>/toolgen/saved/<toolId>/index.ts`.
  2. At the next gateway session, the saved tool loads from `saved/<toolId>/`.
  3. When the sandboxed child spawns, if the sandbox helper (Windows AppContainer or Linux `bwrap`) configures read grants from `artifact.manifest.permissions.filesystem.read`, it will grant read access to **`ephemeral/<toolId>`** (which is wiped and empty!), and **DENY read access to `saved/<toolId>`**.
  4. On Windows AppContainer, Bun will fail immediately with OS Access Denied (`exit 68`). On Linux `bwrap`, `saved/<toolId>/index.ts` will not be mounted into the isolated filesystem namespace.

- **Required Resolution:**  
  The spec must explicitly define how `manifest` is constructed and signed for saved tools:
  - When `saveGeneratedTool` promotes an artifact, `artifact.manifest` must be updated to reference `savedScriptDir(configDir, toolId)` before generating the canonical bytes to sign and approve in `tool.save`.
  - Alternatively, `buildGeneratedManifest` should compute the filesystem read grant dynamically at spawn time from the active `scriptDir`, while `canonicalArtifactBytes` canonicalizes the portable permission structure (e.g. `network: []`).

```ts
// packages/gateway/src/toolgen/toolgen-save-gate.ts

export function buildSavedToolArtifact(
  ephemeralArtifact: GeneratedToolArtifact,
  savedScriptDir: string,
  runtimeReadPaths: readonly string[],
): GeneratedToolArtifact {
  const savedManifest = buildGeneratedManifest(ephemeralArtifact.toolId, {
    scriptDir: savedScriptDir,
    runtimeReadPaths,
  });

  return {
    ...ephemeralArtifact,
    manifest: savedManifest,
  };
}
```

---

### 2.2 Broker Missing Enforcement for Uncredentialed Refusal on `credentialHosts`

- **The Requirement in Spec (§ 8.3):**  
  > *"A saved tool's `credentialHosts` — already inside the signed artifact — records which hosts will carry a credential. On load with nothing bound, the tool lists as `needs-credentials`, and the broker **refuses** requests to those hosts rather than sending them uncredentialed."*

- **The Code-Level Gap in `ToolgenBroker` (`packages/gateway/src/toolgen/toolgen-broker.ts`):**  
  In the current implementation of `ToolgenBroker.handleFetch`:

  ```ts
  let binding: ToolCredentialBinding | null;
  try {
    binding = await this.#deps.readCredential(toolId, host);
  } catch (err) {
    return refuse("ERR_TOOLGEN_CREDENTIAL_UNAVAILABLE", ...);
  }
  if (binding !== null) applyCredential(headers, binding);
  ```

  If `host` was declared in `artifact.credentialHosts`, but no credential has been bound yet in the Vault (or was wiped on reboot), `readCredential(toolId, host)` returns `null` (not a throw).  
  As a result, the current broker silently skips `applyCredential` and proceeds with an **unauthenticated request**, violating the security invariant and leaking request data to endpoints expecting authentication!

- **Required Resolution:**  
  1. Extend `ToolgenBrokerDeps` with `credentialHostsFor: (toolId: string) => readonly string[]`.
  2. Inside `handleFetch`, check whether `host` is in `credentialHosts`. If `binding === null`, immediately refuse and ledger a `blocked` row:

```ts
// packages/gateway/src/toolgen/toolgen-broker.ts

const isCredentialHost = this.#deps
  .credentialHostsFor(toolId)
  .some((h) => h.toLowerCase() === host);

if (isCredentialHost && binding === null) {
  return refuse(
    "ERR_TOOLGEN_CREDENTIAL_REQUIRED",
    `host ${host} requires a credential binding, but none is set for tool ${toolId}. ` +
      `Bind one via 'nimbus tool credential set ${toolId} ${host}'.`,
  );
}
```

---

### 2.3 Two-Way Startup Verification: DB-to-Disk vs. Disk-to-DB Reconciliation

- **The Conflict in Spec (§ 7 vs. § 11):**  
  - **§ 7 states:** *"Startup verifies; it does not spawn. `verifySavedToolsAtStartup` walks the rows, re-reads each artifact from disk, recomputes `canonicalArtifactBytes`, verifies the signature against the Vault pubkey, and writes `disabled_reason` on failure."*
  - **§ 11 states (as a required test):** *"Row missing, disk valid → the row is rebuilt, not the artifact deleted."*

- **The Problem:**  
  If `verifySavedToolsAtStartup` only performs `SELECT * FROM generated_tool` and walks DB rows, it will **never discover** an artifact that exists on disk whose DB row was lost, deleted, or restored from an older backup. Thus, the test in § 11 would fail.

- **Required Resolution:**  
  `verifySavedToolsAtStartup` (or a dedicated `reconcileSavedTools`) must perform two passes:
  1. **Row Reconciliation Pass:** For every row in `generated_tool`, check disk files (`index.ts`, `artifact.json`, `artifact.sig`). If missing or tampered, update `disabled_reason` in SQLite.
  2. **Disk Discovery Pass:** Read directory entries in `<configDir>/toolgen/saved/`. For any directory not present in `generated_tool`, read `artifact.json` and `artifact.sig`, verify the Ed25519 signature against the Vault public key, and if valid, insert a new `generated_tool` row (`saved_at = now()`, `last_loaded_at = null`, `disabled_reason = null`).

---

### 2.4 Registry Session Scope vs. Global Saved Tools

- **Context in `ToolgenRegistry` (`toolgen-registry.ts`) & CLI:**  
  `ToolgenRegistry` is currently session-scoped:

  ```ts
  forSession(sessionId: string): ToolgenEnvelope[] {
    return [...this.#byId.values()]
      .filter((e) => !e.terminated && e.envelope.sessionId === sessionId)
      .map((e) => e.envelope);
  }
  ```

  CLI commands use `CLI_TOOLGEN_SESSION_ID = "cli"`. Agent workflow sessions use unique UUIDs.

- **The Conflict:**  
  Saved tools must be available across **all sessions** (future CLI runs, background fleet jobs, user chat sessions). If a saved tool is registered with `sessionId: "cli"` or a specific session ID, other sessions calling `forSession(agentSessionId)` will not see it.  
  Furthermore, `maxToolsPerSession` in `createGeneratedTool` bounds ephemeral creation; saved tools should not be constrained by or consume ephemeral session slots.

- **Required Resolution:**  
  Support global registration in `ToolgenRegistry`:

  ```ts
  export interface ToolgenEnvelope {
    readonly artifact: GeneratedToolArtifact;
    readonly sessionId?: string; // Optional or "global" for saved tools
    readonly scriptPath: string;
    readonly approvedAt: number;
    readonly isSaved?: boolean;
  }
  ```

  And update `forSession(sessionId)` to return:
  `[...this.#byId.values()].filter(e => !e.terminated && (e.envelope.isSaved || e.envelope.sessionId === sessionId))`

---

## 3. Detailed Review of Architecture & Invariants

### 3.1 Schema V61 & Migration Design (§ 4)

The table schema is clean and minimal:

```sql
CREATE TABLE generated_tool (
  tool_id          TEXT PRIMARY KEY,
  tool_name        TEXT NOT NULL,
  description      TEXT NOT NULL,
  artifact_json    TEXT NOT NULL,
  artifact_digest  TEXT NOT NULL,
  signature        TEXT NOT NULL,
  pubkey           TEXT NOT NULL,
  approved_at      INTEGER NOT NULL,
  saved_at         INTEGER NOT NULL,
  last_loaded_at   INTEGER,
  disabled_reason  TEXT
);
```

#### Verification & Best Practices

1. **Migration Runner Integration:**  
   - Add `GENERATED_TOOL_V61_SQL` in `packages/gateway/src/index/generated-tool-v61-sql.ts`.
   - Register step `simpleStep(60, 61, "generated_tool (runtime tool persistence v61)", GENERATED_TOOL_V61_SQL)` in `packages/gateway/src/index/migrations/runner.ts`.
   - Bump `CURRENT_SCHEMA_VERSION = 61` in `packages/gateway/src/index/local-index.ts`.
2. **D12 Compliance:** All SQLite writes to `generated_tool` must use `dbRun`/`dbExec`/`dbStmtRun` from `packages/gateway/src/db/write.ts`.

---

### 3.2 Vault Keypair & Signing Engine (§ 5)

The keypair management mirrors `share/share-keypair.ts`:

- Vault Keys:
  - `toolgen.signing.privkey` (32-byte Ed25519 seed, base64)
  - `toolgen.signing.pubkey` (32-byte Ed25519 public key, base64)
- Verification & Detached Signatures:
  - Use TweetNaCl `nacl.sign.detached` and `nacl.sign.detached.verify` over UTF-8 bytes of `canonicalArtifactBytes(artifact)`.
  - Storing the base64 signature in `saved/<toolId>/artifact.sig` and base64 pubkey in `generated_tool.pubkey`.

```ts
// packages/gateway/src/toolgen/toolgen-keypair.ts

import { decodeBase64, encodeBase64, generateEd25519Keypair } from "@nimbus-dev/sdk";
import nacl from "tweetnacl";
import type { NimbusVault } from "../vault/nimbus-vault.ts";

export const TOOLGEN_SIGNING_PRIVKEY = "toolgen.signing.privkey";
export const TOOLGEN_SIGNING_PUBKEY  = "toolgen.signing.pubkey";

export async function signArtifact(
  vault: NimbusVault,
  canonicalBytes: string,
): Promise<{ sigB64: string; pubkeyB64: string }> {
  const { privkeyB64, pubkeyB64 } = await ensureToolgenKeypair(vault);
  const seed = decodeBase64(privkeyB64);
  const kp = nacl.sign.keyPair.fromSeed(seed);
  const sig = nacl.sign.detached(new TextEncoder().encode(canonicalBytes), kp.secretKey);
  return { sigB64: encodeBase64(sig), pubkeyB64 };
}

export function verifyArtifactSignature(
  canonicalBytes: string,
  sigB64: string,
  pubkeyB64: string,
): boolean {
  try {
    return nacl.sign.detached.verify(
      new TextEncoder().encode(canonicalBytes),
      decodeBase64(sigB64),
      decodeBase64(pubkeyB64),
    );
  } catch {
    return false;
  }
}
```

---

### 3.3 Static Rule D29(d) Specification

- **The Rule:** *There is no unverified read accessor for a saved artifact.*
- **Enforcement Pattern in `scripts/structure-audit/check-nimbus-invariants.ts`:**
  Add a structural audit rule scanning production source code to ensure that filesystem operations targeting `toolgen/saved/` or `toolgen-saved-store.ts` internal paths are not performed outside `toolgen-saved-store.ts`:

```ts
// scripts/structure-audit/check-nimbus-invariants.ts

const D29_SAVED_STORE_FILE = "packages/gateway/src/toolgen/toolgen-saved-store.ts";
const D29_SAVED_STORE_PATH_RE = /toolgen[\\/]saved/;

export function checkD29SavedStoreConfinement(files: readonly SourceFile[]): AuditViolation[] {
  const violations: AuditViolation[] = [];
  for (const f of files) {
    if (f.relPath === D29_SAVED_STORE_FILE || f.relPath.includes(".test.")) continue;
    if (D29_SAVED_STORE_PATH_RE.test(f.contents)) {
      violations.push({
        file: f.relPath,
        rule: "D29(d)-saved-store-confined",
        message: `D29(d) access to toolgen/saved directory outside toolgen-saved-store.ts`,
      });
    }
  }
  return violations;
}
```

---

## 4. Open Questions & Recommendations

### Q1: Storage of `pubkey` on Disk vs Database during Recovery

- **Question:** If the SQLite database is wiped/lost, and the gateway reconciles artifacts from `<configDir>/toolgen/saved/`, how does it verify the signature if `pubkey` was only stored in SQLite?
- **Recommendation:**  
  When reconciling unindexed disk artifacts:
  1. Attempt verification against the current Vault public key (`TOOLGEN_SIGNING_PUBKEY`).
  2. If it verifies, rebuild the DB row with `pubkey = currentPubkey`.
  3. If it does not verify against current Vault pubkey, mark the unindexed artifact as `disabled_reason: "pubkey_rotated"` (or `"signature_mismatch"`).  
  Optionally, include `"pubkey": "<b64>"` inside `artifact.json` as metadata outside the canonicalized payload.

---

### Q2: Handling of `nimbus tool save` on an Already-Saved Tool

- **Question:** What happens if `nimbus tool save <tool-id>` is invoked on a tool that is already saved?
- **Recommendation:**  
  Make `saveGeneratedTool` idempotent or return a clear diagnostic:
  - If the tool is live and already in `generated_tool`, re-computing and overwriting the signature is safe, but returning `{ status: "already_saved", toolId }` (or exit 0 with `"Tool <tool-id> is already saved"`) avoids unnecessary re-prompting.

---

### Q3: Process Lifecycles on Promotion (`ephemeral/` vs `saved/`)

- **Question:** When an active ephemeral tool is saved during a running session, what happens to the running child process?
- **Recommendation:**  
  Do not kill or restart the child process during `tool save`. Let the active child continue running from `ephemeral/<toolId>` for the remainder of the session. The `saved/<toolId>` files will be used when the tool is spawned in subsequent sessions.

---

### Q4: Complete Error Code Taxonomy

- **Recommendation:** Ensure all error codes across the gate, broker, and CLI are enumerated and distinct:
  - `ERR_TOOLGEN_SAVE_DISABLED`: Capability disabled by config or org policy.
  - `ERR_TOOLGEN_SAVE_NOT_LIVE`: Tool ID is not an active, non-terminated tool.
  - `ERR_TOOLGEN_SAVE_DENIED`: Owner rejected the `tool.save` HITL prompt.
  - `ERR_TOOLGEN_SIGNATURE_INVALID`: Ed25519 signature mismatch on load/spawn.
  - `ERR_TOOLGEN_CREDENTIAL_REQUIRED`: Outbound fetch attempted to a host in `credentialHosts` with no active Vault binding.
  - `ERR_TOOLGEN_CREDENTIAL_HOST_UNKNOWN`: Attempted to bind a credential for a host not in the signed `credentialHosts`.

---

## 5. Verification & Test Plan Additions (§ 11)

The test plan should explicitly verify the following scenarios in `toolgen-persistence.test.ts` and `security-invariants.test.ts`:

1. **End-to-End Promotion Cycle:**
   - Create tool -> bind credential -> save tool -> approve `tool.save` -> verify files in `toolgen/saved/<toolId>/` -> verify row in SQLite `generated_tool`.
2. **Post-Restart Credential Oblivion & Re-binding:**
   - Simulate restart (clear in-memory registry, execute Vault sweep).
   - Verify tool loads with `needs-credentials` status.
   - Broker call to credentialed host without binding -> throws `ERR_TOOLGEN_CREDENTIAL_REQUIRED` and ledgers `blocked` egress row.
   - Run `nimbus tool credential set <id> <host> --bearer token123`.
   - Broker call now succeeds and attaches `Authorization: Bearer token123`.
3. **Re-binding to Unapproved Host Refusal:**
   - `nimbus tool credential set <id> evil.com --bearer token` -> throws `ERR_TOOLGEN_CREDENTIAL_HOST_UNKNOWN`.
4. **Tamper Detection (Red-Proved):**
   - Flip 1 byte in `saved/<id>/index.ts` -> verification fails (`signature_mismatch`).
   - Flip 1 byte in `saved/<id>/artifact.json` -> verification fails.
   - Delete `saved/<id>/artifact.sig` -> verification fails (`signature_missing`).
5. **Keypair Rotation Detection:**
   - Replace Vault keypair with a new keypair.
   - Boot verification flags row with `disabled_reason: "pubkey_rotated"`.
6. **Disk-to-DB Reconciliation:**
   - Delete row from SQLite table `generated_tool`.
   - Startup reconciliation detects valid files on disk and restores the SQLite row.
7. **Spawn-Time Re-Verification:**
   - Pass boot verification -> modify disk script -> attempt spawn -> fails immediately at spawn gate.
8. **D29(d) Static Confinement Test:**
   - Structure audit test confirms zero occurrences of `toolgen/saved/` access outside `toolgen-saved-store.ts`.

---

## 6. Summary Table of Proposed Spec Adjustments

| Spec Section | Proposed Revision | Rationale |
|---|---|---|
| **§ 3 & § 6** | Specify that `artifact.manifest` must have `scriptDir` set to `saved/<toolId>` prior to computing canonical bytes for `tool.save`. | Prevents sandbox ACL failure on Windows AppContainer / Linux bwrap when loading saved scripts. |
| **§ 8.3** | Add `credentialHostsFor` to `ToolgenBrokerDeps` and refuse requests when `binding === null` on credentialed hosts with `ERR_TOOLGEN_CREDENTIAL_REQUIRED`. | Closes security hole where missing credentials resulted in unauthenticated outbound HTTP requests. |
| **§ 7 & § 11** | Specify two-way reconciliation (DB -> Disk and Disk -> DB) in `verifySavedToolsAtStartup`. | Fulfills the § 11 test requirement: "row missing, disk valid → row rebuilt". |
| **§ 7 & § 9** | Define `ToolgenRegistry` global / saved tool support and clarify that saved tools do not consume `maxToolsPerSession`. | Ensures saved tools are accessible across all sessions and agent workflows without exhausting session budgets. |
| **§ 9** | Add `ERR_TOOLGEN_CREDENTIAL_REQUIRED` to the error code taxonomy. | Provides explicit machine-readable error for missing credentials during broker fetch. |
