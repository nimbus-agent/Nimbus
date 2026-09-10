# Implementation Plan Review: S2 — Runtime Tool Generation, PR 3: Persistence + Signing

**Date:** 2026-09-10  
**Reviewer:** Antigravity (AI Coding Assistant)  
**Status:** Review Complete — Approved with Targeted Architectural & Implementation Refinements  
**Target Plan:** [`2026-09-10-s2-toolgen-persistence.md`](file:///C:/gitrep/Nimbus/docs/superpowers/plans/2026-09-10-s2-toolgen-persistence.md)  
**Target Spec:** [`../specs/2026-09-10-s2-toolgen-persistence-design.md`](file:///C:/gitrep/Nimbus/docs/superpowers/specs/2026-09-10-s2-toolgen-persistence-design.md)  
**Spec Review:** [`../specs/2026-09-10-s2-toolgen-persistence-design-review.md`](file:///C:/gitrep/Nimbus/docs/superpowers/specs/2026-09-10-s2-toolgen-persistence-design-review.md)  
**Spine Slot:** [Spine S2 — Local Compute Fleet](../../roadmap.md#active)  
**Relevant Invariants & Rules:** Invariant **I40** (Saved Tool Integrity & Keypair Verification), Invariant **I39** (Runtime Tool Generation Gate & Confinement), Invariant **I2** (HITL Frozen Set), Invariant **I10** (Constant-time Comparison), Static Rules **D29(a–d)**, Schema **V61** (`generated_tool`)

---

## 1. Executive Summary & Plan Strengths

The implementation plan provides a rigorous, 12-task, test-driven engineering roadmap for **PR 3: Persistence + Signing**. It fully addresses all core architectural challenges identified in the design phase and sets a new quality floor for secure, verifiable standing approvals.

### Notable Strengths & Architectural Innovations

1. **The "Derived Script" Paradigm (Plan-Level Refinement):**  
   Storing `canonicalArtifactBytes(artifact)` verbatim in `artifact.json` and treating `index.ts` as a **disposable, derived artifact re-emitted from the verified body at spawn** is a superior architectural design. It eliminates an entire class of canonicalization mismatch bugs on disk load and transforms "tampering with `index.ts` is detected" into "tampering with `index.ts` is irrelevant because it is overwritten with the approved bytes before execution".
2. **Portable Manifest Separation (Task 1):**  
   Signing `PortableToolManifest` (dropping machine-derived absolute read paths) while asserting strict set equality at spawn (`assertConcreteManifestMatches`) cleanly avoids brittle platform dependencies (e.g. Bun upgrades or OS path changes) while preserving strict sandbox confinement guarantees.
3. **Double Remediation of Pre-existing Vulnerabilities (Tasks 5 & 6):**  
   - **Task 5 (Vault Credential Leak):** Sweeps `toolgen.` Vault credentials on revoke, shutdown, and boot (retaining only `toolgen.signing.*`), ensuring ephemeral and saved secrets never leak across gateway sessions.
   - **Task 6 (Unauthenticated Fetch Bypass):** Extends `ToolgenBrokerDeps` with `credentialHostsFor` and refuses requests to credentialed hosts when `binding === null` with `ERR_TOOLGEN_CREDENTIAL_REQUIRED`, ledgering a `blocked` egress row instead of silently issuing unauthenticated traffic.
4. **Clean Existence vs. Content Authority Split (Tasks 2 & 8):**  
   Splitting authority—where the SQLite `generated_tool` row governs *existence* (was it saved and not revoked?) and disk-plus-signature governs *content integrity* (has it been tampered with?)—prevents revoked or zombie tools from being adopted on reboot.
5. **Strict Spawn-Time Re-Verification (Task 9):**  
   Verifying the Ed25519 signature and rebuilding `index.ts` at spawn time guarantees that long-running gateway processes never execute code that was modified after boot.

---

## 2. Critical Implementation Details & Code-Level Refinements

### 2.1 Reconstructing `ExtensionManifest` from `PortableToolManifest` at Spawn (Tasks 1 & 9)

- **Context in Plan (Task 1 Step 6 & Task 9 Step 3):**  
  In Task 1, `canonicalArtifactBytes` canonicalizes `manifest: toPortableManifest(artifact.manifest)`.  
  Therefore, the parsed JSON from `artifact.json` contains a `manifest` of type `PortableToolManifest` (lacking `permissions.filesystem` and `permissions.network`).  
  However, `buildToolSpawnSpec` (`toolgen-client.ts`) expects a full `ExtensionManifest` to pass to `wrapServerSpec(spec, envelope.artifact.manifest, cwd)`.
- **The Trap:**  
  If the parsed artifact from `artifact.json` is passed directly as `envelope.artifact` to `spawnGeneratedTool`, `wrapServerSpec` will fail or produce an invalid sandbox configuration because `manifest.permissions` is `undefined`.
- **Required Resolution in Task 9 Step 3:**  
  In `spawnSavedTool`:
  1. Parse the verified canonical JSON into a raw record.
  2. Reconstruct the concrete `ExtensionManifest` using `buildGeneratedManifest(toolId, { scriptDir: savedDir, runtimeReadPaths })`.
  3. Assert that the concrete manifest matches the signed portable manifest via `assertConcreteManifestMatches(concreteManifest, parsed.manifest, [savedDir, ...runtimeReadPaths])`.
  4. Construct the runtime `ToolgenEnvelope` using the **concrete manifest**:

```ts
// packages/gateway/src/toolgen/toolgen-saved-spawn.ts (or toolgen-registry.ts)

export async function spawnSavedTool(
  toolId: string,
  deps: SavedSpawnDeps,
): Promise<GeneratedToolHandle> {
  const verified = await deps.readVerifiedSavedTool(deps.configDir, toolId, deps.pubkeyB64);
  if (!verified.ok) {
    throw new ToolgenError(
      ERR_TOOLGEN_SIGNATURE_INVALID,
      `saved tool ${toolId} failed verification: ${verified.reason}`,
    );
  }

  const rawArtifact = JSON.parse(verified.canonicalJson);
  const savedDir = deps.savedToolDir(deps.configDir, toolId);
  const runtimeReadPaths = deps.runtime.requiredReadPaths();

  // Re-emit derived index.ts from the verified body
  const scriptPath = await deps.rewriteSavedToolScript(
    deps.configDir,
    toolId,
    emitToolScript({
      toolId,
      toolName: rawArtifact.toolName,
      description: rawArtifact.description,
      body: rawArtifact.body,
      inputSchema: rawArtifact.inputSchema,
    }),
  );

  // Reconstruct concrete manifest and assert shape
  const concreteManifest = buildGeneratedManifest(toolId, {
    scriptDir: savedDir,
    runtimeReadPaths,
  });
  assertConcreteManifestMatches(concreteManifest, rawArtifact.manifest, [savedDir, ...runtimeReadPaths]);

  const envelope: ToolgenEnvelope = {
    artifact: {
      toolId,
      toolName: rawArtifact.toolName,
      description: rawArtifact.description,
      body: rawArtifact.body,
      approvedHosts: rawArtifact.approvedHosts,
      credentialHosts: rawArtifact.credentialHosts,
      inputSchema: rawArtifact.inputSchema,
      manifest: concreteManifest, // Full ExtensionManifest for wrapServerSpec
    },
    sessionId: "saved",
    scriptPath,
    approvedAt: rawArtifact.approvedAt ?? deps.now(),
  };

  return deps.spawn(envelope);
}
```

---

### 2.2 Self-Healing Disabled Tools in `saveGeneratedTool` (Task 7 Step 4)

- **Context in Plan (Task 7 Step 4, Step 6 in list):**  
  Step 6 of `saveGeneratedTool` states:
  > *"6. existing row with the same digest? -> `{ status: "already_saved" }`, no prompt"*
- **The Edge Case:**  
  Suppose a saved tool's on-disk files (`artifact.json` or `artifact.sig`) were corrupted or deleted, causing boot reconciliation to mark `disabledReason = "artifact_missing"` or `"signature_mismatch"`.  
  If the owner runs `nimbus tool save <toolId>` on the live session tool to repair/re-save it:
  - If `saveGeneratedTool` only checks `existingRow.artifactDigest === digest` and immediately returns `{ status: "already_saved" }` without writing files or clearing `disabledReason`, the tool remains permanently broken and disabled on disk!
- **Required Resolution:**  
  Only short-circuit with `{ status: "already_saved" }` if the existing row is **healthy** (`disabledReason === null` AND disk files verify):

```ts
// packages/gateway/src/toolgen/toolgen-save-gate.ts

const existingRow = deps.repo.getSavedTool(deps.db, toolId);
if (
  existingRow !== null &&
  existingRow.artifactDigest === digest &&
  existingRow.disabledReason === null
) {
  return { status: "already_saved", toolId };
}
```
If `existingRow.disabledReason !== null`, proceed through approval (or repair write) to re-sign, rewrite disk files, and reset `disabledReason` to `null`.

---

### 2.3 Strict Host Normalization in `toolgen.credentialSet` (Task 10)

- **Context in Plan (Task 10 Step 3):**  
  `toolgen.credentialSet` receives `{ toolId, host, binding }`.
- **The Pitfall:**  
  Users typing `--host` or RPC callers might pass unnormalized host strings (e.g. `https://API.example.com/v1`, `api.example.com:443`, or uppercase `API.EXAMPLE.COM`).  
  `artifact.credentialHosts` stores normalized lowercase hostnames (e.g. `api.example.com`).
- **Required Resolution:**  
  `toolgen.credentialSet` must pass `host` through `normalizeHost(host)` before testing `artifact.credentialHosts.includes(normalizedHost)` and before writing to Vault via `toolCredentialKey(toolId, normalizedHost)`.

```ts
// packages/gateway/src/ipc/toolgen-rpc.ts

"toolgen.credentialSet": async (params, ctx) => {
  const rec = asRecord(params) ?? {};
  const toolId = requireString(params, "toolId");
  const rawHost = requireString(params, "host");
  const binding = parseToolCredentialBinding(rec["binding"]);

  const normalizedHost = normalizeHost(rawHost);

  // Look up tool from saved repo or registry
  const saved = ctx.savedRepo.getSavedTool(ctx.db, toolId);
  const live = ctx.gateDeps.registry.get(toolId);
  const credentialHosts = saved
    ? (JSON.parse(saved.artifactJson).credentialHosts as readonly string[])
    : (live?.artifact.credentialHosts ?? []);

  if (!credentialHosts.includes(normalizedHost)) {
    throw new ToolgenError(
      ERR_TOOLGEN_CREDENTIAL_HOST_UNKNOWN,
      `host "${rawHost}" (${normalizedHost}) is not among the tool's approved credential hosts: [${credentialHosts.join(", ")}]`,
    );
  }

  await ctx.writeCredential(toolId, normalizedHost, binding);
  return { ok: true, toolId, host: normalizedHost };
};
```

---

### 2.4 Documented Tradeoff: Database Loss Sweeps Saved Tool Directories (Task 8)

- **Context in Plan (Task 8):**  
  Pass 2 of boot reconciliation sweeps any directory in `<configDir>/toolgen/saved/` that does not have a corresponding row in the SQLite `generated_tool` table.
- **Architectural Tradeoff:**  
  - *Advantage:* Guaranteed defense against resurrecting revoked tools or orphaned artifacts left by unclean shutdowns.
  - *Consequence:* If a user deletes `nimbus.db` or restores an empty database, existing valid saved tools on disk will be swept on next boot.
- **Recommendation:**  
  Keep the orphan sweep (it mirrors `sweepOrphanActiveDirsBestEffort` in extensions), and add a clear docstring in `toolgen-boot-reconcile.ts` recording that the SQLite table is the root of existence for saved tools.

---

## 3. Task Verification & Invariant Tracking

| Task | Core Responsibility | Key Invariants & Rules Asserted | Verification & Regression Controls |
|---|---|---|---|
| **Task 1** | Portable manifest derivation & assertion | Invariant **I39**, **I40** | `toPortableManifest` strips machine paths; `assertConcreteManifestMatches` verifies exact read set. |
| **Task 2** | Schema V61 `generated_tool` & repo CRUD | Static Rule **D12** / **I14**, **I9** | Migrations bump `CURRENT_SCHEMA_VERSION = 61`; bound parameters and `dbRun` writes only. |
| **Task 3** | Vault Ed25519 signing keypair | Non-Negotiable #3, Static Rule **D29(c)** | Detached TweetNaCl signing; Vault key allow-list audit; seed never exported. |
| **Task 4** | Saved tool store & verifying accessor | Static Rule **D29(d)** | Single verifying read accessor; `artifact.sig` written last; derived `index.ts`. |
| **Task 5** | Ephemeral Vault credential sweep | Invariant **I40**, Non-Negotiable #3 | Sweep on revoke, boot, and shutdown; retains `toolgen.signing.*`. |
| **Task 6** | Unbound credential host fetch refusal | Invariant **I40**, Invariant **I29** | `credentialHostsFor` dep; throws `ERR_TOOLGEN_CREDENTIAL_REQUIRED`; ledgers `blocked` egress row. |
| **Task 7** | Save gate with separate consent | Invariant **I2** (`tool.save` in `HITL_REQUIRED_BACKING`) | Refusals before consent; `persistence: true` disclosed; non-TTY refusal. |
| **Task 8** | Boot reconciliation & orphan sweep | Invariant **I40** | Validates rows against disk; distinguishes `pubkey_rotated` from tampering; sweeps unindexed dirs. |
| **Task 9** | Global registry & verify-at-spawn | Invariant **I40**, Invariant **I39** | `forSession` unions saved tools; re-verifies signature at spawn; rebuilds derived script. |
| **Task 10** | IPC (`toolgen.save`, `credentialSet`) & CLI | Invariant **I5** (LAN-forbidden) | `nimbus tool save`, `credential set`, and `list` CLI commands with TTY guards. |
| **Task 11** | Invariant I40, Rule D29(d), and docs | Invariant **I40**, Static Rule **D29(d)** | Triple rule: structure audit rule + docs + `security-invariants.test.ts` in one commit. |
| **Task 12** | Cross-platform integration & ledger sync | Platform Equality, Delivery Re-ledger | End-to-end multi-boot integration test; sync across `CLAUDE.md`, `GEMINI.md`, `roadmap.md`. |

---

## 4. Summary of Recommended Edits to the Plan

| Plan Task | Plan Step | Recommended Change | Rationale |
|---|---|---|---|
| **Task 9** | Step 3 | Explicitly reconstruct `ExtensionManifest` from `PortableToolManifest` before passing to `buildToolSpawnSpec` / `wrapServerSpec`. | Prevents runtime `TypeError` when sandbox wrapper accesses `manifest.permissions`. |
| **Task 7** | Step 4 (Step 6 of list) | Only return `{ status: "already_saved" }` if `existingRow.disabledReason === null`. If disabled, proceed to re-sign and repair disk files. | Enables user-driven self-healing of corrupted on-disk artifacts via `nimbus tool save`. |
| **Task 10** | Step 3 | Add `normalizeHost(rawHost)` in `toolgen.credentialSet` before validating against `artifact.credentialHosts` and writing to Vault. | Prevents false-negative refusals due to URL scheme, port, or casing differences. |
| **Task 8** | Step 3 | Add docstring documenting that DB is authority of existence and unindexed disk directories are intentionally swept. | Preserves architectural clarity and aligns with extension orphan sweeping precedent. |
