# Review: User MCP Servers That Actually Run (Design Spec)

**Target Spec:** [`2026-10-06-user-mcp-grants-design.md`](file:///C:/gitrep/Nimbus/.claude/worktrees/user-mcp-grants/docs/superpowers/specs/2026-10-06-user-mcp-grants-design.md)  
**Date:** 2026-10-06  
**Reviewer:** Antigravity  
**Branch:** `dev/asaf/user-mcp-grants`

---

## 1. Executive Summary & Verdict

The design document addresses a critical gap in Nimbus: making user-defined MCP servers functional, scaffoldable, and securely confined across Windows, macOS, and Linux, while eliminating the major security issue where sandboxed connectors had full read/write access to `paths.dataDir`.

The design is sound, adhering strictly to Nimbus's security invariants (`I1`, `I15`, `I41`) and the Principle of Least Privilege. 

This review highlights **key edge cases, OS-specific subtleties, open questions, and concrete improvements** to ensure a smooth, defect-free implementation.

---

## 2. Key Findings & Potential Pitfalls

### Finding 1: Windows DACL Permission Error When Automatically Appending `dirname(command)`
* **Context (Spec § B & Spike):** Section B states: *"the command's own directory is appended automatically"* to `readPaths`.
* **The Problem:** On Windows, `nimbus-sandbox-helper.exe` runs **unprivileged** as the standard user. When `--grant-read` is passed to the helper, it modifies DACLs via `SetNamedSecurityInfoW`. If a user registers an executable located in a system directory (e.g. `C:\Program Files\nodejs\node.exe`, `C:\Windows\System32\...`, or a globally installed package), attempting to write DACLs on `dirname(command)` will fail with `ERROR_ACCESS_DENIED` and cause the helper to abort the spawn with exit code `66`.
* **Key Insight from Windows Spike:** As confirmed in the Windows spike (lines 47–49 of the spec), the Windows AppContainer opens the executable image via `CreateProcessW` from the parent process outside the container, meaning **Windows does NOT require an explicit read grant or ACE on the binary or its directory to execute it**. Linux (bwrap bind mounts) and macOS (Seatbelt SBPL) do require read grants on the binary/directory.
* **Recommendation:**
  1. Only append `dirname(command)` to `readPaths` on Linux and macOS, OR
  2. On Windows, verify if the directory is user-writable before attempting an ACE grant, and avoid failing the spawn if `dirname(command)` is in a standard system directory (`Program Files`, `System32`, `WindowsApps`).

---

### Finding 2: Relative Command Path Resolution (CLI cwd vs. Gateway cwd)
* **Context (Spec § B):** *"The CLI resolves each `--read` to an absolute path against its cwd and sends structured `argv: string[]`... command: absolute path kept; a bare name resolved with `Bun.which` against the gateway's `PATH`"*.
* **The Problem:** The user runs `nimbus connector add --mcp` from their terminal in their current working directory (e.g., `./my-mcp/`), while the Gateway is a long-running daemon whose working directory may be the repo root, data directory, or system service root.
  If the user provides a relative path for the command (e.g., `nimbus connector add --mcp mcp_echo ./dist/server` or `.\dist\server.exe`), and the CLI sends `./dist/server` as-is, the Gateway will fail to resolve it against its own cwd or resolve it against the wrong directory.
* **Recommendation:** The CLI must resolve relative command paths (paths starting with `./`, `../`, `.\`, `..\` or containing path separators) to absolute paths against `process.cwd()` **in the CLI process** before sending the RPC payload to the Gateway. Bare command names (e.g. `python`, `node`, `my-tool`) should remain bare strings so the Gateway can resolve them via `Bun.which` against the environment `PATH`.

---

### Finding 3: Redundancy in Scaffold README vs. Automatic Command Directory Grant
* **Context (Spec § B & § C):**
  - Section B: *"the command's own directory is appended automatically"*
  - Section C: *"README.md — install, test, build, and the exact `nimbus connector add --mcp mcp_<name> --read <abs dist dir> -- <abs dist/<name>[.exe]>` line for the current OS"*
* **The Discrepancy:** If `<abs dist/<name>[.exe]>` is located inside `<abs dist dir>`, then `<abs dist dir>` is already the command's own directory and will be granted automatically. Asking the user to type `--read <abs dist dir>` is redundant and obscures the convenience of automatic binary directory inclusion.
* **Recommendation:**
  In `README.md`, simplify the registration instruction to:
  ```bash
  nimbus connector add --mcp mcp_<name> -- <abs dist/<name>[.exe]>
  ```
  Include a short explanatory note in the README showing how `--read <path>` can be added if the server needs to access external directories (e.g. data folders).

---

### Finding 4: Deterministic Sanitization for `sandboxDir/<sanitised manifest id>`
* **Context (Spec § A):** `wrapServerSpec` derives a per-policy directory `<sandboxDir>/<sanitised manifest id>`.
* **Considerations:**
  - Manifest IDs for user MCPs follow the pattern `user.mcp_<name>` (or `builtin.<service_id>` for bundled connectors).
  - Dots (`.`) are valid path characters, but on Windows, trailing dots/spaces or reserved names (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`) can cause filesystem issues.
* **Recommendation:** Define a centralized sanitization helper (e.g. in `platform/sandbox/paths.ts` or `canonical-path.ts`):
  ```ts
  export function sanitizePolicyIdForDir(policyId: string): string {
    return policyId.replaceAll(/[^a-zA-Z0-9_-]/g, "_");
  }
  ```
  This keeps directory naming 1:1 with `mcpServerKeyForUserConnector` and ensures clean filesystem paths across Windows, macOS, and Linux.

---

### Finding 5: Sandbox Directory Lifecycle and Cleanup
* **Context (Spec § A):** Working directories are created recursively under `PlatformPaths.sandboxDir` prior to spawning.
* **The Question:** When are these directories cleaned up?
  - Sandboxed servers may write cache, temporary files, or SQLite test files into their assigned cwd.
  - Over time, removed or upgraded MCP servers could leave abandoned directories.
* **Recommendation:**
  1. On `nimbus connector remove <service_id>`: As part of cleanup, asynchronously remove `<sandboxDir>/user.${service_id}` (best-effort, ignoring errors if locked).
  2. On Gateway startup (or in `dirs.ts`): Ensure `sandboxDir` exists, and optionally purge directories belonging to unregistered user MCP connectors.

---

## 3. Section-by-Section Review & Recommendations

### Section A: Per-connector sandbox working directory
| Requirement | Status | Feedback & Suggestions |
|---|---|---|
| `PlatformPaths.sandboxDir` across Windows, macOS, Linux, and Demo | Approved | Clean separation. Crucial: ensure `CliPlatformPaths` in `packages/cli/src/paths.ts` and `demo-root.ts` mirror this field to maintain parity (`scripts/parity/demo-root.parity.test.ts`). |
| Invariant property: `sandboxDir` outside `dataDir` and `configDir` | Approved | Tested across all resolvers and demo mode. |
| Pre-creation of directory before spawn | Approved | Prevents `canonical-path.ts` from falling back to non-canonical strings on non-existent directories. |
| Windows boot ACE revocation on `dataDir` | Approved | Idempotent, non-fatal on failure, skipped in demo mode. |

---

### Section B: User MCP grants & CLI Syntax
| Requirement | Status | Feedback & Suggestions |
|---|---|---|
| CLI Syntax: `nimbus connector add --mcp <id> [--read <path>]... [--net <host[:port]>]... -- <command> [args...]` | Approved | Ensure CLI flag parser supports both explicit `--` delimiter and trailing positional command if unambiguous. |
| Validation before HITL gate | Approved | Essential. Validating and resolving command, read paths, and net hosts *before* calling `toolExecutor.gate(...)` guarantees that the consent prompt displays exact canonical values and avoids prompting on malformed requests. |
| Schema Migration V65 | Approved | Adding `read_paths_json` and `net_hosts_json` (defaulting to `'[]'`) to `user_mcp_connector`. Update `CURRENT_SCHEMA_VERSION = 65` in `local-index.ts`. |
| Network Host validation | Approved | Ensure lowercase normalization and support for valid IPv4 literals (`127.0.0.1`, `10.0.0.1`) alongside RFC 1123 hostnames. |
| Windows network note | Approved | When `netHosts` is non-empty on Windows, include warning: *"AppContainer network access is all-or-nothing (internetClient)"* in the consent payload. |

---

### Section C: Scaffold
| Requirement | Status | Feedback & Suggestions |
|---|---|---|
| `nimbus scaffold mcp <name>` | Approved | Generates `./<name>/` directory with minimal working MCP echo server. |
| `package.json` dependencies | Approved | Pin `@modelcontextprotocol/sdk` to `1.32.0` and `zod` to `^4.6.5`. |
| Unit tests in scaffold (`src/server.test.ts`) | Approved | Using in-memory client transport to test `tools/list` and `tools/call`. |
| Windows `.exe` output | Note | `bun build --compile` on Windows appends `.exe` automatically. The README and CLI instructions should correctly reflect the executable name per OS. |

---

## 4. Open Questions for Implementation Alignment

1. **Bare Command vs. Absolute Path in DB Storage:**
   - The spec states: *"the stored command is the absolute path"*.
   - If a user specifies `python` (which resolves to `C:\Users\Alice\AppData\Local\Programs\Python\Python312\python.exe` or `/usr/bin/python3`), storing the absolute path guarantees deterministic execution and prevents `PATH` hijacking.
   - *Question:* What if the user switches node/python versions (e.g. via `nvm` or `pyenv`)?
   - *Resolution:* Storing the absolute path approved during HITL is the most secure behavior, matching invariant `I15`. If the runtime path moves, the user can re-register or update the connector.

2. **Error Formatting on Malformed Manifest JSON in DB:**
   - The spec mentions reusing the path from `recordArgsJsonFailure`.
   - *Suggestion:* Refactor `recordArgsJsonFailure` in `packages/gateway/src/connectors/lazy-mesh/user-mcp.ts` into a unified `recordUserMcpManifestFailure(ctx, serviceId, column, reason)` to cover `args_json`, `read_paths_json`, and `net_hosts_json`.

3. **CI Execution of `bun build --compile` in E2E Tests:**
   - In offline or locked CI test runners, does `bun build --compile` require network access to fetch the standalone Bun runtime binary, or is it already cached locally by Bun?
   - *Resolution:* In CI workflows running on Bun v1.2+, ensure the build step uses the host runner's local executable cache.

---

## 5. Summary of Recommended Adjustments to the Spec / Implementation

1. **Windows System Directory ACE handling**: Refine § B to note that `dirname(command)` is added to `readPaths` on macOS and Linux, while on Windows it is only granted if not already a system directory or if DACL edits are permitted.
2. **CLI Relative Command Resolution**: Clarify in § B that the CLI resolves relative paths for the `<command>` argument against `process.cwd()` before sending the RPC payload.
3. **Scaffold README**: Remove `--read <abs dist dir>` from the default README example in § C to showcase the zero-config experience for standard standalone binaries.
4. **Parity Check**: Update `CliPlatformPaths` in `packages/cli/src/paths.ts` and ensure parity tests pass with `sandboxDir`.
