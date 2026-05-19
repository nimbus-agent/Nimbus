# Phase 5 T2 PR 3 — Auto-update Review

**Review Date:** 2026-05-19  
**Reviewer:** Gemini CLI  
**Plan File:** `2026-05-19-phase-5-t2-pr3-auto-update.md`

## Executive Summary

The implementation plan for extension auto-update is **exceptionally robust**, following high engineering standards and strictly adhering to project security invariants. The use of a two-version on-disk layout (`active/` vs `_prev/`) coupled with startup crash recovery provides excellent reliability. The TDD approach ensures high coverage and correctness at every step.

## Key Strengths

1.  **Security Invariants (I2, I3, I4, I5, I7, I14, I16):** The plan correctly identifies and reinforces all relevant invariants. The use of `HITL_REQUIRED_BACKING` based on action types (I3) and the exclusion of new methods from LAN (I5) and Tauri renderer (I7) are correctly handled.
2.  **Reliability & Atomic Swaps:** The atomic `fs.rename` strategy for upgrading and downgrading is well-designed. The inclusion of a `_holding` directory for older `_prev` versions ensures no state is lost if a swap fails mid-process.
3.  **Crash Recovery (Task 14):** Automatically promoting the most recent `_prev` version if `active/` is missing on startup is a critical reliability feature for a local-first system.
4.  **Auditability:** Every significant event (detection, application, failure, crash recovery) is recorded in the audit log, matching the Phase 4/5 standards.
5.  **Modular Primitives:** Splitting types, permission diffing, and apply logic into pure modules (Phase A, D) makes testing straightforward and reduces side effects.

## Open Questions & Suggestions

### 1. Semver Comparison Robustness (Task 10)
The plan implements `isStringSemverLess` as a simple numeric-array comparison. 
- **Suggestion:** While sufficient for `x.y.z`, it may fail on pre-release versions (e.g., `1.1.0-beta.1`). If the extension registry supports pre-release tags, consider using a more robust comparison or explicitly documenting that pre-release tags are unsupported for v1.

### 2. Registry Client Assumptions (Task 8)
Task 8 assumes `registryClient.fetchLatestVersion` and `registryClient.fetchManifest` are available.
- **Question:** Were these added in T2 PR 2 (Verified Publisher), or should they be explicitly added in a sub-task here? If they are not yet implemented, Phase D or E should include their implementation in `packages/gateway/src/extensions/registry-client.ts`.

### 3. IPC `extension.info` and `extension.prevVersions` (Task 18)
Task 18 mentions `extension.prevVersions` as a "new IPC" to compute `prevVersion`.
- **Suggestion:** To minimize RPC roundtrips for the CLI, consider including the `prevVersion` directly in the `extension.info` response. This simplifies Task 17 and 18.

### 4. Lazy-mesh Invalidation Hook (Task 9)
The plan implements `invalidateExtension(id)` as a no-op because "lazy-mesh re-reads the manifest on every spawn".
- **Check:** Ensure that `mesh.ts` or `connector-spawns.ts` doesn't have an in-memory `Map` caching the `ServerSpec` for the lifetime of the Gateway process. If it does, the no-op will lead to the old version being spawned until Gateway restart.

### 5. HITL Payload Detail (Task 10)
The HITL payload for `extension.autoUpdate` includes `addedPermissions` and `removedPermissions`.
- **Improvement:** Ensure the `StructuredPreview` (Task 20) also renders the `publisherStatus`. If a publisher key was rotated (`needs_sync`), the UI should prominently warn the user before they are forced to run `nimbus extension sync`.

## Minor Improvements

- **Task 5 (Config):** The interval is `[1, 168]`. Consider if `1` hour is too aggressive for the public registry; perhaps a minimum of `6` or `12` hours should be default, allowing `1` only for dev overrides.
- **Task 7 (Max Bytes):** `MAX_TARBALL_BYTES` is 50 MiB. This is safe, but maybe should be a config-overridable value in the future.

## Conclusion

The plan is **Approved for Execution**. The suggested improvements are minor refinements and do not block the start of implementation.
