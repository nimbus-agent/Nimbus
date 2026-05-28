# Implementation Plan Review: OAuth Provider Registry (PR-1)

**Date:** 2026-05-27
**Target Plan:** `2026-05-27-oauth-provider-registry-pr1.md`

## Overview

The implementation plan for PR-1 provides an exceptionally clean, safe, and incremental approach to consolidating the four existing 3-legged OAuth providers. The strict adherence to the "zero behavior change" contract by relying on the six existing `auth/*.test.ts` files as a regression net is excellent.

Below are a few questions, suggestions, and minor improvements to consider before execution.

## Suggestions & Open Questions

### 1. Single-Flight Lock & Multi-Process Concurrency (Task 5, Step 3)

**Observation:** The single-flight lock (`inFlightRefresh`) is implemented as an in-memory `Map`. It successfully coalesces concurrent refresh attempts for the same `vaultKey` within the same process.
**Question:** Does `getValidVaultAccessToken` execute exclusively within the primary headless Gateway process (e.g., accessed via IPC by connectors), or is this file imported and executed directly within isolated connector sub-processes?
**Suggestion:** If connectors run in separate processes and import this directly, the in-memory map will only protect against concurrency within a single connector process. If multiple connectors (or the gateway + connector) attempt to refresh the same token simultaneously, the lock won't prevent a token invalidation race condition. Ensure this function is evaluated in a single centralized process, or consider an IPC/file-based locking mechanism if true multi-process concurrency is expected.

### 2. Vault Read vs. Single-Flight Check Ordering (Task 5, Step 3)

**Observation:** In `getValidVaultAccessToken`, the vault is read and parsed *before* checking the `inFlightRefresh` map.

```ts
const raw = await a.vault.get(vaultKey);
// ... parsing ...
const existing = inFlightRefresh.get(vaultKey);
```

**Improvement:** If an in-flight refresh is currently happening, the vault might still contain the *old* expiring token payload when it is read. By the time it parses and checks the lock, it will correctly wait on the promise (`existing`). However, checking the lock *before* reading the vault (or immediately awaiting the lock if it exists before proceeding to vault reads) can save unnecessary disk I/O and parse errors if the vault is midway through being updated by the active refresh promise.

### 3. Assertion Update Precision (Task 8, Step 3)

**Observation:** You caught that the Notion refresh error message changes from `"Notion token refresh failed"` to `"Token exchange failed (...)"` and explicitly allowed exactly one assertion update in `notion-access-token.test.ts`.
**Praise:** This is a masterful catch. Limiting the blast radius of a refactor to a single, highly specific string assertion update ensures that the "zero behavior change" contract remains practically untainted.

### 4. Slack Scope Delimiters (Task 3, Step 3)

**Observation:** The Slack scope parsing uses `.split(/[,\s]+/)`.
**Praise:** Slack's scopes in OAuth responses can sometimes be comma-separated rather than space-separated (unlike Google/Microsoft). Using a regex that handles both ensures robust parsing without brittle exact-character matching.

## Conclusion

The plan translates the design spec flawlessly. The incremental deletion of dead code alongside typechecking (Task 6, Step 2) is a very safe strategy. Once the concurrency scope (single process vs multi-process) of the in-memory lock is confirmed, this plan is fully ready for execution.
