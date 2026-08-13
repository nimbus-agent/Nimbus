# Sentry issue indexing — design review

**Date:** 2026-08-12  
**Reviewer:** AI Assistant (Antigravity)  
**Target Doc:** [2026-08-12-sentry-issue-indexing-design.md](./2026-08-12-sentry-issue-indexing-design.md)

---

## Suggestions & Open Questions

### 1. Pagination: Link Header Parsing & `results="false"`

- **Regex Robustness:** The current implementation of `LinkHeaderPagination` uses:

  ```typescript
  const m = /<([^<>]+)>;\s*rel="next"/.exec(part.trim());
  ```

  Sentry's `Link` header contains additional parameters (like `results="true/false"` and `cursor="..."`). The order of these parameters is not guaranteed by the standard. For example, a header could be:
  `<url>; results="false"; rel="next"` or `<url>; rel="next"; results="false"`.
- **Recommendation:** Update the regex or parser to extract parameters safely. When modifying `LinkHeaderPagination` to support checking the `results` parameter, ensure it matches `rel="next"` regardless of parameter ordering and correctly extracts `results="..."` if present (while defaulting to `true` if absent to preserve compatibility with Mendeley).

### 2. Graph Topology: Linking Issues to Projects

- **Issue-to-Project Relationship:** The design maps the issue to a `sentry:error_issue` entity but does not explicitly mention establishing a relationship between the issue and its parent project (`sentry:project -> sentry:error_issue`).
- **Recommendation:** Since the issue metadata contains the project slug/ID, the graph populator should build a `PARENT_OF` or similar relationship between the matching `sentry:project` entity and the `sentry:error_issue` entity. This will allow downstream queries to filter or aggregate issues by project.

### 3. Cursor Updating & Partial Sync Failures

- **Checkpointing:** The design states: *"HTTP non-OK -> return the incoming cursor unchanged"*. Since we query descending by date (`sort=date`) and page forward:
  - If a sync run fetches pages 1, 2, and 3 successfully, but fails on page 4, returning the incoming (older) cursor means the entire sync state is rolled back. On the next run, we will re-fetch pages 1, 2, and 3.
  - **Question:** Should we checkpoint the cursor during pagination? E.g., setting the cursor to the most recently indexed issue's `lastSeen` timestamp if a page succeeds, or updating the stored cursor to the start of the current run's successful batch so that subsequent runs don't re-process successfully indexed data?

### 4. Customizability of `initialSyncDepthDays`

- **Configuration:** The Spec changes `initialSyncDepthDays` from 1 to 30.
- **Question:** Is `initialSyncDepthDays` a hardcoded value in the connector, or is it governed by/customizable via the connector's runtime configuration (e.g., `nimbus.toml` or `connector_depth` registry)? It would be beneficial to specify how administrators can override this depth if they need to backfill a larger window or limit sync volume.

### 5. API Permission & Organization vs. Project Scope

- **Permissions:** `GET /organizations/{org}/issues/` queries issues org-wide. Some Sentry integration tokens are restricted to specific projects and may return a `403 Forbidden` on the org-wide issues endpoint.
- **Recommendation:** Add a note on the minimum required Sentry token scopes/permissions needed for org-wide issues access, and detail the fallback behavior if a token is only authorized for specific projects (e.g., whether we fall back to iterating over indexed projects, or log a clear user-facing error).
