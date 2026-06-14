# Review & Suggestions — Mendeley Connector Implementation Plan

**Reviewer:** AI Coding Assistant (Antigravity)  
**Date:** 2026-06-14  
**Target Plan:** `2026-06-14-slice9-mendeley-connector.md`

This document details feedback, open questions, and recommended improvements for the Mendeley Connector Implementation Plan.

---

## 1. Recommendations & Improvements

### A. Date Format Millisecond Precision (Task 8 Step 3)
* **Context**: The plan specifies `modified_since` cursor outputting a standard `toISOString()` string (e.g. `2024-03-02T08:00:00.000Z`).
* **Issue**: Certain Mendeley API endpoints historically expect ISO datetime values *without* millisecond fractions (e.g., `YYYY-MM-DDTHH:mm:ssZ`) and will return HTTP `400 Bad Request` if milliseconds are present.
* **Recommendation**: Add a sanitation helper or warning note in Task 8 Step 3 to strip milliseconds if Elsevier's API rejects them:
  ```ts
  const formatCursorDate = (date: Date) => date.toISOString().replace(/\.\d+Z$/, "Z");
  ```

### B. Handle 401 Unauthorized Gracefully in MCP Server (Task 4 Step 5)
* **Context**: The `server.ts` is spawned with a fixed token injected via the environment: `MENDELEY_ACCESS_TOKEN`.
* **Issue**: If the token expires during an active session, any subsequent list or search calls will fail with `401 Unauthorized` until the lazy client is disconnected and re-spawned.
* **Recommendation**: In `server.ts`, if a fetch returns `401 Unauthorized`, ensure the error message contains `Unauthorized` or `401` explicitly so that the gateway client orchestrator can detect it, force disconnect the lazy client, and obtain a fresh token during the next attempt.

### C. OS-Specific Path Separators in Temporary Directories (Task 2 Step 7 / Task 8 Step 1)
* **Context**: `mkdtempSync(join(tmpdir(), "mendeley-..."))` is used.
* **Suggestion**: This is cross-platform safe since `join` from `node:path` dynamically resolves separators based on the host OS. However, remind the developer to ensure no raw `/` separators are introduced during assertion checks or file copying, satisfying the `audit:cross-platform` preflight gate.
