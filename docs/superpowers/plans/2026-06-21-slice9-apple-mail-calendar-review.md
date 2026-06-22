# Review & Feedback: Apple Mail & Calendar Connector Implementation Plan Review

**Review Date:** 2026-06-21  
**Plan Document Reviewed:** [2026-06-21-slice9-apple-mail-calendar.md](./2026-06-21-slice9-apple-mail-calendar.md)  
**Status:** Plan Feedback / Suggestions / Improvements

---

## 1. Monorepo Isolation: Avoid Cross-Package Relative Imports (Tasks A2 & D1)

### Context

In **Task A2 (Step 3)** and **Task D1 (Step 2)**, the plan suggests:
> *Verify the cross-package import path `../../imap/src/imap-core.ts` ... copy `toMessageMeta`/`previewFetchQuery` or import from the imap package if cross-package src import is allowed.*

### Suggestion

- **Monorepo Packaging Boundaries:** Cross-package relative source imports (like `../../imap/src/imap-core.ts` from `packages/mcp-connectors/apple/`) will break standard TypeScript compilation and bundling in the build pipeline. Bun/tsc outputs separate bundles per workspace, and referencing files outside the package root results in folder-nesting problems in `dist/`.
- **Recommendation:** Do **not** use relative imports pointing to sibling connector packages. Instead:
  1. Redefine the minimal required types locally in `apple-mail-core.ts`.
  2. If helper functions like `toMessageMeta` or `previewFetchQuery` need to be shared, move/refactor them into the shared connector toolkit `packages/mcp-connectors/shared/imap-tool-kit.ts` where they can be cleanly imported by both packages.

---

## 2. Dynamic Principal Host Redirect Handling in `tsdav` (Task D1)

### Context

In **Task D1 (Step 2)**, the CalDAV client is configured:
> *A CalDavClient via tsdav: login with caldav.icloud.com ... re-apply auth on every request to the discovered `p##-caldav.icloud.com` host (don't rely on transparent redirects).*

### Suggestions / Open Questions

1. **Client Re-initialization:**
   - In `tsdav`, the `DAVClient` requires credentials and an explicit server URL. If it initiates a request against the bootstrap host `https://caldav.icloud.com`, and discovers the `calendar-home-set` on `https://pXX-caldav.icloud.com`, simply executing sub-requests on the original client object might not dynamically route credentials to the new host depending on redirect policies.
   - **Recommendation:** Guide the developer to instantiate a bootstrap `DAVClient` first, perform principal discovery, and then explicitly construct the primary working `DAVClient` targeting the resolved `pXX-caldav.icloud.com` principal URL for all subsequent operations.

---

## 3. Generic Dispatch Mapping for Writes (Task I1)

### Context

In **Task I1** and the **Global Constraints**, the plan routes writes through the generic path:
> *Writes ride the generic path — `payload.mcpToolId = "apple_*"`, `action.type` = the existing generic HITL action. No `apple-write-tools.ts`, no `connector-write-registry.ts` / D20 / `SECURITY-INVARIANTS.md` edits.*

### Suggestions / Open Questions

1. **Routing Verification:**
   - If the write tools (e.g. `apple_mail_send`) bypass the custom connector-write registry, is the gateway-side tool-dispatcher already dynamically wired to route `email.send` actions to the matching active service connector tool?
   - **Recommendation:** Instruct the developer to verify how generic actions are dispatched to specific connectors (e.g., checking `packages/gateway/src/engine/executor.ts` or `packages/gateway/src/connectors/dispatch.ts`). If the dispatch logic requires explicit registration mapping (e.g. mapping `email.send` for service `apple` to `apple_mail_send`), ensure this mapping is added in Phase H.
