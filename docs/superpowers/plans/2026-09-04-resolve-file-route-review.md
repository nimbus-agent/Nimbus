# Implementation Plan Review: `GET /v1/items/resolve-file`

**Date:** 2026-09-04
**Reviewer:** Antigravity (AI Coding Assistant)
**Status:** Approved / Ready for Execution
**Target Plan:** [`2026-09-04-resolve-file-route.md`](./2026-09-04-resolve-file-route.md)
**Design Spec:** [`../specs/2026-09-04-resolve-file-route-design.md`](../specs/2026-09-04-resolve-file-route-design.md)
**Companion Client Spec:** `nimbus-web-clipper` -> `docs/superpowers/specs/2026-09-04-the-file-you-are-looking-at-design.md`

---

## 1. Summary of Review

The implementation plan is exceptionally well-scoped, modular, and adhering strictly to test-driven development (TDD) best practices. It directly implements the server-side HTTP read necessary to unblock the three source-file agent lanes in `nimbus-web-clipper` (Phase C7.1).

### Key Plan Highlights

1. **Atomic Auth & Scanner Pairing (Task 1):** Recognizes that the route constant in `http-route-auth.ts` and the `url.pathname === "/v1/items/resolve-file"` literal in `http-server.ts` must land in the same commit to satisfy the bidirectional static scanner in `http-route-auth.test.ts`.
2. **Strict Disclosure Protection (Task 1 Step 1):** Enforces field-by-field response projection (`{ ok: true, path }`), explicitly verified with `expect(Object.keys(body).sort()).toEqual(["ok", "path"])` to prevent `repoRoot` or `fileEntityId` from leaking over HTTP.
3. **Discrete Gate Verification (Task 2):** Tests `401 Unauthorized`, `403 Insufficient Scope` (with legacy token payload validation), and `404 Surface Disabled` independently without code regressions.
4. **Behavioral Boundary Pins (Task 3):** Exhaustively tests slashes in branch names (`feat/auth-v2/src/foo.ts`), directory traversal attempts (`../../secret.txt`), special characters (`+` and space), and distinct miss discriminants (`remote_not_tracked` vs `file_not_indexed`).
5. **Living Documentation Discipline (Task 4):** Synchronizes architectural docs, changelog, and machine-readable egress coverage comments (`egress-coverage.ts`).

---

## 2. Open Questions & Technical Clarifications

### Q2.1: Coordinate Trimming and Sanitization

* **Context (Task 1 Step 4):** `coordinateParam(url, name)` checks `raw === null || raw.trim() === ""` and returns `raw` untrimmed.
* **Analysis:**
  * For `refAndPath`, preserving exact characters is essential because file paths could theoretically have leading/trailing whitespace.
  * For `service` and `repo` (`owner/name`), whitespace is never valid in forge URLs. If `service` or `repo` carried trailing whitespace (e.g. from an erroneous caller), `wantedRepo` becomes `"github :acme/web "`, resulting in a `remote_not_tracked` miss rather than matching `r.external_id`.
* **Clarification:** Returning `raw` untrimmed matches `handleItemsResolve`'s handling of `?url=`. The client `gateway-client.ts` uses `URLSearchParams`, which does not introduce whitespace. Keeping `coordinateParam` uniform across all three parameters avoids unnecessary special-casing.

### Q2.2: Case Insensitivity over the HTTP Wire

* **Context (Task 3):** In `resolveFileByRemote.ts`, repository matching uses `LOWER(r.external_id) = LOWER(?)`.
* **Suggestion:** Add an integration test case verifying that casing differences between the forge URL and local clone (e.g. `coord("github", "ACME/Web", "main/src/foo.ts")` against a database seeded with `github:acme/web`) resolve cleanly over HTTP.

### Q2.3: Zero-Egress Ledger Verification

* **Context (Global Constraints & Task 4):** A fundamental invariant of `GET /v1/items/resolve-file` is that it appends no row to the egress ledger.
* **Suggestion:** In `items-resolve-file-route.test.ts`, add an explicit assertion querying the database after a successful resolve to verify that the table storing egress rows remains untouched (`SELECT COUNT(*) FROM graph_entity WHERE type = 'egress_item'` or equivalent table).

---

## 3. Improvements & Implementation Nuances

### I3.1: Cognitive Complexity Compliance (`Sonar S3776`)

* **Context (Task 1 Step 7):** `tryBearerAuthedGet` in `http-server.ts` was previously refactored to manage cognitive complexity.
* **Recommendation:** Ensure the route dispatcher is inserted as a simple one-line guard:

  ```ts
  if (url.pathname === "/v1/items/resolve-file")
    return await handleItemsResolveFile(req, url, db, opts);
  ```

  Keep `handleItemsResolveFile` as a separate, self-contained async function to avoid inflating the cyclomatic complexity of `tryBearerAuthedGet`.

### I3.2: Biome Import Ordering

* **Context (Task 1 Step 4):** Adding `import { resolveFileByRemote } from "../index/resolve-file-by-remote.ts";` to `http-server.ts`.
* **Note:** Ensure Biome's alphabetical import sorting is respected (`resolve-by-url.ts` is followed by `resolve-file-by-remote.ts`). Running `bun run lint` in Step 7 will automatically catch and format any minor placement discrepancies.

### I3.3: GitLab Deep Subgroup Fixture

* **Context (Task 3):** GitLab projects can be deeply nested (e.g. `gitlab.com/group/subgroup/project/-/blob/main/src/file.ts`).
* **Suggestion:** Include a test fixture in Task 3 for a subgroup repository coordinate: `coord("gitlab", "org/team/subgroup/repo", "main/src/foo.ts")` to verify that slash-delimited repository names in query parameters pass through `URLSearchParams` and `resolveFileByRemote` without truncation.

---

## 4. Task Structure & Execution Readiness

| Task | Scope | Risk / Complexity | Verification Gate |
| :--- | :--- | :--- | :--- |
| **Task 1: The route** | Route key, auth row, handler, routing literal, initial hit/400 test | Medium (Scanner sync) | `bun test items-resolve-file-route.test.ts && bun test http-route-auth.test.ts` |
| **Task 2: The gates** | 401 unauthorized, 403 scope gap, 404 unmounted surface | Low (Test only) | `bun test items-resolve-file-route.test.ts` (7 tests pass) |
| **Task 3: Resolution pins** | Both miss types, slashy refs, traversal immunity, special chars | Low (Test only) | `bun test items-resolve-file-route.test.ts` (12 tests pass) + Full gateway suite |
| **Task 4: Documentation** | Egress coverage comment, architecture table, changelog entry | Low (Docs & Comments) | `bun run lint:markdown && bun run lint` |

---

## 5. Conclusion

The implementation plan is complete, precise, and ready for immediate execution. It contains all necessary code snippets, exact test assertions, and step-by-step verification gates to ensure a zero-defect landing.
