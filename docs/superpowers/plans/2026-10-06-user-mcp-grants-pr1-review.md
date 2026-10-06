# Implementation Plan Review: User MCP Servers That Actually Run (PR 1)

**Target Plan:** [`2026-10-06-user-mcp-grants-pr1.md`](file:///C:/gitrep/Nimbus/.claude/worktrees/user-mcp-grants/docs/superpowers/plans/2026-10-06-user-mcp-grants-pr1.md)  
**Spec Reference:** [`2026-10-06-user-mcp-grants-design.md`](file:///C:/gitrep/Nimbus/.claude/worktrees/user-mcp-grants/docs/superpowers/specs/2026-10-06-user-mcp-grants-design.md)  
**Date:** 2026-10-06  
**Reviewer:** Antigravity  
**Branch:** `dev/asaf/user-mcp-grants`

---

## 1. Executive Summary & Verdict

The implementation plan is **exceptionally well-structured, comprehensive, and production-ready**. It adopts a strict Test-Driven Development (TDD) methodology across 13 clearly scoped tasks, with explicit failing tests before every implementation step, clear dependency boundaries, and strict adherence to Nimbus's security invariants (`I1`, `I14`, `I15`, `I41`, and the new `I42`).

The plan directly incorporates the architectural recommendations from the design review (e.g., bypassing Windows DACL writes for `dirname(command)`, pre-validation before the HITL gate, and resolving relative command paths in the CLI).

This review documents **refinements, edge-case observations, and checklist items** to ensure a smooth execution across all 13 tasks.

---

## 2. Key Strengths of the Plan

1. **Strict Red-Green-Refactor Discipline:** Every task starts with explicit failing test code (Step 1) and test commands (Step 2) before code changes (Step 3).
2. **Deep OS-Specific Nuances Handled:**
   - On Windows: Uses NTFS Junctions for test dependency linking (bypassing the need for elevated symlink privileges), handles AppContainer profileMoniker naming, addresses DACL inheritance on `paths.dataDir`, and respects Windows argument quoting rules (`CommandLineToArgvW`).
   - On Linux/macOS: Enforces bwrap mount point traversal and macOS Seatbelt SBPL literal ancestor traversal.
3. **Robust Security Boundaries:**
   - Validation and path canonicalization occur *before* the HITL prompt (Task 5 & 6).
   - Invariant `I42` ensures every user MCP tool execution is gated by the local owner, with delegation explicitly blocked.
   - `connector.userMcpTools` and `connector.userMcpCall` are LAN-forbidden and excluded from Tauri allowlists.
4. **Zero Test Contamination:** All test suites use temporary directories created via `mkdtempSync` and isolated dependency injection seams instead of module mocking (`mock.module`).

---

## 3. Key Observations & Recommended Refinements

### Refinement 1: Include `ensurePlatformDirectories` in Task 1 (`dirs.ts`)
* **Context (Task 1):** Task 1 adds `sandboxDir` to `PlatformPaths` and `CliPlatformPaths`.
* **Observation:** `packages/gateway/src/platform/dirs.ts` defines `ensurePlatformDirectories(paths: PlatformPaths)`, which creates the essential platform directories on Gateway boot (`configDir`, `configDir/vault`, `dataDir`, `logDir`, `extensionsDir`, `tempDir`, and socket parent dir).
* **Recommendation:**
  In Task 1, also update `packages/gateway/src/platform/dirs.ts` to include `paths.sandboxDir` in `dirs`:
  ```ts
  const dirs = [
    paths.configDir,
    join(paths.configDir, "vault"),
    paths.dataDir,
    paths.logDir,
    paths.extensionsDir,
    paths.tempDir,
    paths.sandboxDir,
  ];
  ```
  And update `packages/gateway/src/platform/dirs.test.ts` to assert that `paths.sandboxDir` is created. This ensures the root sandbox directory exists before any wrapper creates child leaves.

---

### Refinement 2: Windows Case-Insensitivity & Drive Letter Normalization in Protected Root Checks (Task 5)
* **Context (Task 5):** `resolveUserMcpRegistration` checks whether any read path is equal to, inside, or an ancestor of `dataDir`, `configDir`, or `sandboxDir` (`isSameOrInside(a, b) || isSameOrInside(b, a)`).
* **Observation:** On Windows:
  1. Paths are case-insensitive (`C:\Users\Alice` vs `c:\users\alice`).
  2. Drive letter casing and forward vs backward slashes can cause string comparisons to fail unless normalized.
* **Recommendation:**
  Ensure that when `env.platform === "win32"`, paths are normalized before `isSameOrInside` using `path.win32.normalize` and compared case-insensitively (e.g. `path.win32.relative(parent.toLowerCase(), child.toLowerCase())`). Since `realpathSync.native` is called first on existing paths, drive letter aliases and 8.3 short names are already expanded.

---

### Refinement 3: Windows Command Resolution with `.exe` / `PATHEXT` (Task 5 & 7)
* **Context (Task 5 & 7):** On Windows, `bun build --compile` outputs an executable with `.exe` (e.g. `dist/echo_srv.exe`).
* **Observation:** If a user runs `nimbus connector add --mcp mcp_echo ./dist/echo_srv` (omitting `.exe`), `realpathSync` on `./dist/echo_srv` may throw `ENOENT` if the file on disk is named `echo_srv.exe`.
* **Recommendation:**
  In `resolveUserMcpRegistration` (or CLI `parseAddMcpArgs`), if `env.platform === "win32"` and the exact path does not exist, check if appending `.exe` (or consulting `PATHEXT`) resolves to an existing file before throwing `ERR_USER_MCP_COMMAND_NOT_FOUND`.

---

### Refinement 4: Non-Blocking Cleanup on Removal (Task 6)
* **Context (Task 6):** `LazyConnectorMesh.removeUserMcpSandbox(serviceId)` stops the MCP client and removes `<sandboxDir>/user.<service_id>`.
* **Observation:** On Windows, file locks held by exiting child processes can take a few milliseconds to release after `stopUserMcpClient`.
* **Recommendation:** The plan's design to catch errors, log a warning, and allow `connector.remove` to succeed in SQLite is the right choice. Consider adding a short retry (e.g. 2 retries with 50ms delay) or leaving the cleanup best-effort to maximize resilience on Windows.

---

### Refinement 5: Schema V65 Migration Idempotency (Task 4)
* **Context (Task 4):** Migration step 64 -> 65 adds `read_paths_json`, `net_hosts_json`, and `model_access` to `user_mcp_connector`.
* **Observation:** `packages/gateway/src/index/migrations/runner.ts` applies `simpleStep(64, 65, ...)`.
* **Recommendation:** Verify that `packages/gateway/src/index/local-index.ts:282` updates `CURRENT_SCHEMA_VERSION = 65`, and ensure all existing migration tests (such as `packages/gateway/test/integration/index/index-health-real-schema.test.ts` and `runner-v*.test.ts`) are included in the Task 4 verification run.

---

### Refinement 6: Scaffold Generated Test Timeout & Package Isolation (Task 11)
* **Context (Task 11):** The generated test in `src/server.test.ts` uses `@modelcontextprotocol/sdk/inMemory.js` with `InMemoryTransport.createLinkedPair()`.
* **Observation:** In Task 11 Step 1, the test verifies that `bun test` runs inside the scaffolded project by junctioning `node_modules/@modelcontextprotocol` and `node_modules/zod`.
* **Recommendation:**
  Ensure the junction links point to the absolute paths of the CLI package's `node_modules` or repo root `node_modules`. On Windows, using `symlinkSync(target, link, "junction")` (as specified) avoids requiring developer mode. Setting `timeout: 60_000` for this spawned test ensures no timeouts on slower CI workers.

---

## 4. Task-by-Task Implementation Checklist

| Task | Title | Key Deliverable | Potential Risk / Focus |
|---|---|---|---|
| **Task 1** | `PlatformPaths.sandboxDir` | Adds `sandboxDir` to gateway & CLI paths | Update `dirs.ts` & ensure `scripts/parity/demo-root.parity.test.ts` passes. |
| **Task 2** | Per-policy sandbox working dir | `sandbox-cwd.ts`, `wrapServerSpec` uses per-policy leaf, wrapper creates directory | Ensure `mkdirSync(cwd, { recursive: true })` runs before `canonicalPath`. |
| **Task 3** | Windows boot revoke legacy ACEs | `win32-reap.ts` revokes legacy data-dir ACEs once, writes marker | Skip on demo gateways; keep sequential to avoid DACL write races. |
| **Task 4** | Schema V65 & Row Manifest | Migration 65, new columns, `userMcpManifestFromRow` | Update `CURRENT_SCHEMA_VERSION = 65` and `CLAUDE.md`/`GEMINI.md`. |
| **Task 5** | Pure Registration Resolver | `user-mcp-registration.ts` resolves command, checks protected roots, validates net | Bypasses `dirname(command)` on Windows; tests table of 3 directions × 3 roots. |
| **Task 6** | `connector.addMcp` Gating & Removal | Resolver runs before `gate()`; remove cleans sandbox directory | Verifies gate payload matches resolved inputs; remove handles locked folders gracefully. |
| **Task 7** | CLI `connector add --mcp` Flags | `parseAddMcpArgs` handles `--read`, `--net`, `--model`, `--` | Resolves relative command paths in CLI cwd; preserves bare command names. |
| **Task 8** | Invariant `I42` | Mandatory local owner HITL approval on `mcp_*.*` actions | Blocks delegated approval (`fallback`); updates all audit ceilings to `I42`. |
| **Task 9** | `connector.userMcpTools` & `Call` | Gateway IPC handlers + dispatching `ToolExecutor` | Excluded from LAN and Tauri allowlists; dispatches to `createConnectorDispatcher`. |
| **Task 10** | CLI `connector tools` & `call` | CLI subcommands with `--json` and exit codes (0/1/2) | Connects interactive consent prompt on `call`. |
| **Task 11** | `nimbus scaffold mcp` | Generates compilable MCP server with tests & README | Pinned SDK `1.32.0`; runs live in-memory test; clean README instructions. |
| **Task 12** | Full E2E Gateway Test | `user-mcp.e2e.test.ts` covers full lifecycle on all 3 OSes | Tests positive control & asserts probe tool is denied access to outside secrets. |
| **Task 13** | Documentation & Audits | Updates architecture, CLI reference, sandbox docs, invariants | Run `audit:status-drift`, `audit:doc-refs`, and `audit:invariants`. |

---

## 5. Open Questions for Final Alignment

1. **Pre-population of `PlatformPaths.sandboxDir` in E2E fixtures:**
   - In E2E test runners (e.g. `gateway-runner.ts`), `NIMBUS_E2E_PATHS_JSON` is passed as serialized JSON.
   - *Check:* Ensure `gateway-runner.ts` and test harnesses that deserialize `PlatformPaths` include `sandboxDir: join(tempRoot, "sandbox")` to prevent `undefined` paths in E2E environments.

2. **IPv6 Network Grants:**
   - The plan explicitly specifies that IPv6 host literals are not accepted in this slice (`ERR_USER_MCP_NET_HOST_INVALID`).
   - *Confirmation:* This is well-bounded and clearly documented in `docs/sandbox.md` (Task 13).

---

## 6. Conclusion

The plan is exceptionally thorough, robust, and safe to execute immediately as designed. Proceeding task-by-task with the specified subagent-driven workflow will result in a clean, high-quality delivery.
