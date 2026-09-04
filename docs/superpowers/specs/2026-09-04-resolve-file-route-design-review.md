# Design Review: Resolving a Forge File Coordinate to a Path in the Reader's Checkout

**Date:** 2026-09-04
**Reviewer:** Antigravity (AI Coding Assistant)
**Status:** Approved / Recommended for Implementation
**Target Spec:** [`2026-09-04-resolve-file-route-design.md`](./2026-09-04-resolve-file-route-design.md)
**Slot:** Track 2 → Client surfaces (`nimbus-web-clipper`)
**Companion Client Spec:** `nimbus-web-clipper` -> `docs/superpowers/specs/2026-09-04-the-file-you-are-looking-at-design.md`

---

## 1. Executive Summary & Architecture Assessment

The specification [`2026-09-04-resolve-file-route-design.md`](./2026-09-04-resolve-file-route-design.md) defines the server-side HTTP read `GET /v1/items/resolve-file` to unblock source file agent lanes in `nimbus-web-clipper` (Phase C7.1).

### Key Architectural Strengths

1. **Contractual Alignment with Shipped Client (§2):** The wire shape strictly matches the parser already shipped in `nimbus-web-clipper` (`src/background/gateway-client.ts`). The implementation fulfills an existing contract rather than introducing a new one.
2. **Information Disclosure & Privacy Boundaries (§4.2, §5):** The route projects `path` field-by-field, explicitly dropping `repoRoot` (the user's local filesystem absolute path) and `fileEntityId`. This prevents local filesystem structure leaks over HTTP clip bearer tokens.
3. **Loopback & Zero-Egress Invariants (§1.1, §5):** Resolution operates purely over the local index (`graph_entity` / `graph_relation`) without triggering outbound forge API requests or adding rows to the egress ledger.
4. **Scope Discipline (§4.1):** Placing the route under the `resolve` scope rather than `agents` guarantees that file status can be verified and miss banners rendered without requiring broad agent execution privileges.
5. **Fail-Closed & Missing Coordinate Protection (§4.3):** Returning `400 { error: "missing_coordinate" }` when `service`, `repo`, or `refAndPath` is blank avoids false `remote_not_tracked` misses caused by degenerate queries like `wantedRepo = ":acme/web"`.

---

## 2. Open Questions & Design Clarifications

### Q2.1: Directory Traversal and Path Normalization Immunity

* **Context (§1.1, §4.2):** A client or external script could pass malicious `refAndPath` values (e.g. `../../../../etc/passwd` or `..\..\Windows\System32`).
* **Security Finding:**
  * In [`packages/gateway/src/index/resolve-file-by-remote.ts`](../../../packages/gateway/src/index/resolve-file-by-remote.ts), `toPosix` replaces backslashes with slashes, and `split("/").filter(s => s !== "")` removes empty segments.
  * Candidate paths are looked up via `fileExternalId(repoRoot, path)` in SQLite:

    ```sql
    SELECT e.id AS id FROM graph_entity e WHERE e.type = 'source_file' AND e.external_id = ?
    ```

  * **Result:** Resolution never accesses the filesystem directly; it only matches entries that were already indexed as `source_file` in the workspace graph. Path traversal attempts simply result in `file_not_indexed`.
* **Recommendation:** Add an explicit test case in the test suite asserting that traversal sequences like `main/../../secret.txt` fail gracefully as `file_not_indexed` rather than throwing errors.

### Q2.2: Multi-Worktree Resolution Precedence

* **Context (§1.1):** A user may have multiple workspaces tracking the same remote (e.g., multiple local git worktrees for `acme/web` on different branches).
* **Behavior in `resolveFileByRemote`:**
  * `resolveFileByRemote` iterates through all matching workspaces and selects the hit with the maximum `indexedAt` timestamp (with `fileEntityId` as tiebreaker).
* **Clarification:** This ensures the route automatically resolves to the developer's most recently active/indexed worktree for that file without requiring extra client hints.

### Q2.3: Character Encoding in `refAndPath` Query Parameters

* **Context (§4.2):** Git branches and file paths may contain spaces, hash fragments, non-ASCII Unicode characters, or percent-encoded entities.
* **Assessment:**
  * In `http-server.ts`, `url.searchParams.get(name)` automatically decodes standard percent-encoding.
  * Slashes in `refAndPath` (`feat/branch/src/index.ts`) are preserved as-is.
* **Recommendation:** Verify test fixtures in `http-api-test-server.ts` include branch names with encoded characters and spaces (e.g., `feature%201/src/file%20name.ts`).

---

## 3. Technical Improvements & Code Health

### I3.1: Cognitive Complexity in `tryBearerAuthedGet` (§9)

* **Context (§4.4, §9):** `tryBearerAuthedGet` in [`packages/gateway/src/ipc/http-server.ts`](../../../packages/gateway/src/ipc/http-server.ts) is monitored under SonarQube `S3776`.
* **Suggestion:** Keep the route branch as a single linear guard:

  ```ts
  if (url.pathname === "/v1/items/resolve-file") return await handleItemsResolveFile(req, url, db, opts);
  ```

  Ensure `handleItemsResolveFile` is fully self-contained so `tryBearerAuthedGet` remains a flat dispatch function without nested branching.

### I3.2: Exact Source Scanner Compliance (`http-route-auth.test.ts`)

* **Context (§4.1):** `http-route-auth.test.ts` scans `http-server.ts` using regex:

  ```ts
  /(?:^|[^.\w])(?:path|url\.pathname)\s*===\s*"(\/[^"]*)"/g
  ```

* **Implementation Note:** Ensure the route check in `tryBearerAuthedGet` uses exact double quotes and `url.pathname === "/v1/items/resolve-file"` so the static AST/regex scanner detects it without triggering false stale-entry or missing-literal errors.

### I3.3: Prose & Comment Synchronization (§7)

* **Context (§7):** Update the comment in `egress/egress-coverage.ts` which refers to `GET /v1/items/resolve` as the newest local read. Update it to reference `GET /v1/items/resolve-file` as taking a forge coordinate and answering purely from the local graph without egress ledger additions.

---

## 4. Edge Cases & Boundary Conditions Matrix

| Scenario | Request | Expected Status & Body | Notes |
| :--- | :--- | :--- | :--- |
| **Tracked File Hit** | `GET /v1/items/resolve-file?service=github&repo=acme/web&refAndPath=main/src/app.ts` | `200 { ok: true, path: "src/app.ts" }` | No `repoRoot`, no `fileEntityId`. |
| **Branch with Slashes** | `GET /v1/items/resolve-file?service=github&repo=acme/web&refAndPath=feat/auth-v2/src/app.ts` | `200 { ok: true, path: "src/app.ts" }` | Gateway splits against indexed paths. |
| **Remote Not Tracked** | `GET /v1/items/resolve-file?service=github&repo=other/unknown&refAndPath=main/src/app.ts` | `200 { ok: false, reason: "remote_not_tracked", repo: "other/unknown" }` | Distinct miss sentence on client. |
| **File Not in Index** | `GET /v1/items/resolve-file?service=github&repo=acme/web&refAndPath=main/missing.ts` | `200 { ok: false, reason: "file_not_indexed", repo: "acme/web" }` | Distinct miss sentence on client. |
| **Missing Parameter** | `GET /v1/items/resolve-file?service=github&repo=&refAndPath=main/src/app.ts` | `400 { error: "missing_coordinate" }` | Refuses empty string parameter. |
| **Legacy Scope Token** | Token with `["clip", "briefs"]` | `403 { error: "insufficient_scope", required: "resolve", granted: ["clip", "briefs"] }` | Client displays `nimbus clip scopes`. |
| **Surface Disabled** | `clipsVault: undefined` | `404 { error: "resolve_disabled" }` | Client treats 404 as "gateway too old". |

---

## 5. Testing & Verification Guidance

The test suite in [`http-api-test-server.ts`](../../../packages/gateway/src/ipc/http-api-test-server.ts) and [`http-route-auth.test.ts`](../../../packages/gateway/src/ipc/http-route-auth.test.ts) should cover all 8 assertions defined in §6:

1. **Disclosure Guard:** Assert that `Object.keys(body)` on a `200` hit contains *only* `["ok", "path"]`.
2. **Discriminant Fidelity:** Test `remote_not_tracked` and `file_not_indexed` independently against seeded SQLite fixtures.
3. **Auth Rejection:** Test `401 Unauthorized` (missing/bad token) and `403 Forbidden` (token lacking `resolve`).
4. **Validation:** Test `400 Bad Request` for each missing/empty coordinate parameter.
5. **Surface Gate:** Test `404 Not Found` when `clipsVault` is undefined.

---

## 6. Conclusion

The specification is well-crafted, minimal, and fully addresses the gateway-blocked state of `nimbus-web-clipper`. Implementation can proceed immediately as planned.
