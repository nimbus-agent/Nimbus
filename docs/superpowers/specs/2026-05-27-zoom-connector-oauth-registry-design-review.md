# Design Review: Zoom 3-legged OAuth Connector + OAuth Provider Registry

**Date:** 2026-05-27
**Target Spec:** `2026-05-27-zoom-connector-oauth-registry-design.md`

## Overview

The design proposes a solid architectural improvement by consolidating the disparate OAuth flows into a single data-driven registry, isolating the risk into PR-1 before introducing Zoom logic. The separation of concerns and the strict behavior preservation using existing tests (`auth/*.test.ts`) is excellent.

Below are a few questions, suggestions, and improvements to consider during the implementation planning phase.

## Suggestions & Open Questions

### 1. Concurrency Control for Rotating Refresh Tokens (Zoom & Generic)

**Observation:** Zoom's rotating refresh tokens are notoriously strict. If a refresh token is accidentally used twice (e.g., due to concurrent background syncs or MCP calls attempting to refresh simultaneously), Zoom invalidates the entire token chain, requiring the user to re-authenticate manually.
**Suggestion/Improvement:** Ensure that the generic `getValidVaultAccessToken` (or the underlying refresh implementation) utilizes an in-memory mutex (or an equivalent single-flight synchronization mechanism) keyed by the provider/clientId. This guarantees that concurrent refresh attempts for the same token yield to the first request rather than triggering parallel refresh API calls.

### 2. Missing Refresh Tokens in the Generic Flow (Notion)

**Observation:** Notion doesn't use standard refresh tokens (it has a synthetic 24h expiry), whereas Zoom, Google, and Microsoft do.
**Question:** How will the generic `getValidVaultAccessToken` handle a missing refresh token field or handle providers that don't rotate them?
**Suggestion:** Consider adding a flag to the `OAuthProviderDescriptor` (e.g., `hasRefreshFlow: boolean`) so the generic logic explicitly knows whether to invoke the refresh HTTP call or to immediately trigger a token expiration error (or bypass refresh for long-lived tokens).

### 3. VTT Parsing Edge Cases (Transcripts)

**Observation:** The VTT-to-plaintext helper strips `WEBVTT`, cue indices, and `HH:MM:SS` lines.
**Improvement:** Zoom's VTT transcripts occasionally include HTML-like styling tags (e.g., `<b>`, `<i>`, `<u>`, or `<v Speaker>`) and cues that span multiple lines.
**Suggestion:** Ensure the pure VTT parsing function strips out these styling/speaker tags (e.g., using a simple regex like `/<[^>]+>/g`) and correctly merges multi-line cues so the resulting prose is clean for the local MiniLM index.

### 4. Rate Limiting on Transcript Downloads

**Observation:** Fetching transcripts requires a second fetch of the `download_url` for every `recording_file`.
**Improvement:** Zoom enforces strict rate limits (HTTP 429). A dense 30-day window with numerous recorded meetings could easily trigger a 429 during the transcript fetching loop.
**Suggestion:** Ensure that the HTTP client executing the `download_url` fetch respects `429 Too Many Requests` by honoring the `Retry-After` header or using a robust exponential backoff. This prevents the entire sync cycle from failing due to transient rate limits.

### 5. Cursor Windowing Resumption

**Observation:** The recordings walk uses a `nimbus-zoom1:` cursor encoding the ≤1-month windowing state.
**Question:** If the sync breaks on a later page or midway through a 30-day window due to an error, does the cursor fallback logic start from the beginning of that same 30-day window on the next run?
**Improvement:** If it does replay the window, the `external_id` (uuid:file_id) deduplication is indeed critical and sufficient. However, just confirm that the HTTP fetch loop doesn't needlessly re-download large VTT files if the row already exists and hasn't changed.

## Conclusion

The registry refactor is the right approach and positions the framework well for future integrations. Implementing a robust single-flight refresh lock will be the most critical safeguard for the Zoom implementation.
