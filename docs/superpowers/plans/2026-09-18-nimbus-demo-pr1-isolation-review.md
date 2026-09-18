# `nimbus demo` PR 1 Implementation Plan Review — Open Questions, Improvements & Suggestions

**Target Document:** [`2026-09-18-nimbus-demo-pr1-isolation.md`](./2026-09-18-nimbus-demo-pr1-isolation.md)  
**Date:** 2026-09-18  
**Scope:** Review of PR 1 implementation tasks, test contracts, platform parity, security invariant I41 enforcement, and edge-case handling.

---

## 1. Executive Summary

The implementation plan in [`2026-09-18-nimbus-demo-pr1-isolation.md`](./2026-09-18-nimbus-demo-pr1-isolation.md) is thorough, well-structured, and ready for execution:
- **TDD Rigor:** Every task follows a strict fail-first -> implement -> wire -> verify cycle with explicit red-test proofs.
- **Architectural Soundness:** Resolves host-global state traps (macOS Keychain, Linux libsecret, Windows AppContainer profile reap, env-selected sidecars) cleanly via `EphemeralVault` and `bootPolicyFor(paths)`.
- **Parity by Design:** Gateway `platform/demo-root.ts` and CLI `lib/demo-root.ts` mirrors are continuously bound by the `demo-root.parity.test.ts` parity test.

Below are minor edge cases, open questions, and concrete improvements to refine the tasks before or during execution.

---

## 2. Key Findings & Actionable Improvements

### 2.1 Task 5 (I41 Test): Include `HOME` and `USERPROFILE` in `ENV_KEYS`
- **Location:** Task 5 Step 1 (`packages/gateway/src/security-invariants.test.ts`)
- **Finding:**
  In Task 5 Step 1, `ENV_KEYS` lists:
  ```ts
  const ENV_KEYS = [
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_RUNTIME_DIR",
    "TMPDIR",
    "NIMBUS_DEMO",
    "NIMBUS_CONFIG_DIR",
    "NIMBUS_GATEWAY_SOCKET",
  ] as const;
  ```
  `HOME` and `USERPROFILE` are omitted. When `createDarwinPaths()` is tested, it calls `homedir()`, which consults `process.env.HOME` on POSIX and `process.env.USERPROFILE` on Windows.
  While the relative isolation assertions still hold (because `demo` paths are computed from `real.dataDir`), Global Constraint Rule 23 states: *"Test data NEVER touches real state. Every test that resolves paths sets APPDATA/LOCALAPPDATA/HOME/USERPROFILE/XDG_*/TMPDIR/TEMP/TMP to temp dirs..."*
- **Improvement:**
  Add `"HOME"` and `"USERPROFILE"` to `ENV_KEYS` and assign them `join(root, "home")` in `beforeEach()`, matching the setups in Task 3 and Task 6.

---

### 2.2 Task 3 (CLI Entrypoint): Clack `intro` Execution Order on Refusal
- **Location:** Task 3 Step 5 (`packages/cli/src/index.ts`)
- **Finding:**
  In `packages/cli/src/index.ts`:
  ```ts
  if (!shouldSuppressBanner) intro("Nimbus");
  let paths: CliPlatformPaths;
  try {
    paths = getCliPlatformPaths();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
    return;
  }
  ```
  If an ambiguous env var is set (e.g. `NIMBUS_DEMO=true`) or demo mode is combined with `NIMBUS_CONFIG_DIR`, `intro("Nimbus")` has already printed `┌ Nimbus` to `stdout` before `getCliPlatformPaths()` throws. The refusal message is printed to `stderr`, and `main()` returns early without calling `outro("Done.")`, leaving an unclosed UI box.
- **Improvement:**
  Resolve `getCliPlatformPaths()` *before* invoking `intro("Nimbus")`:
  ```ts
  let paths: CliPlatformPaths;
  try {
    paths = getCliPlatformPaths();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
    return;
  }
  if (!shouldSuppressBanner) intro("Nimbus");
  ```

---

### 2.3 Windows Named Pipe Prefix Case-Insensitivity
- **Location:** Task 1 Step 3 and Task 2 Step 3 (`demoSocketPathFor`)
- **Finding:**
  ```ts
  const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\";
  export function demoSocketPathFor(realSocketPath: string, demoRoot: string): string {
    if (realSocketPath.startsWith(WINDOWS_PIPE_PREFIX)) { ... }
  ```
  In `packages/gateway/src/platform/dirs.ts`, `isWindowsNamedPipe` checks `socketPath.toLowerCase().startsWith("\\\\.\\pipe\\")`.
- **Improvement:**
  Use `realSocketPath.toLowerCase().startsWith(WINDOWS_PIPE_PREFIX)` to guarantee pipe prefix matching regardless of drive casing or caller conventions.

---

### 2.4 E2E Test Teardown Resiliency on Windows
- **Location:** Task 3 Step 7 and Task 6 Step 1 (`afterAll` blocks)
- **Finding:**
  On Windows, child processes terminated with `proc.kill()` occasionally hold file locks on temporary directories or sockets for a few milliseconds after exiting.
- **Improvement:**
  Add a short retry loop (e.g. 3 attempts with a 50ms delay) around `rmSync(root, { recursive: true, force: true })` in `afterAll` to eliminate potential CI flakes on Windows runners.

---

### 2.5 Verification of Inherited `NIMBUS_PROFILE` in Demo Mode
- **Location:** Task 3 & Task 6 E2E tests
- **Finding:**
  If a user has `export NIMBUS_PROFILE=work` active in their shell, `nimbus --demo status` will pass `NIMBUS_PROFILE=work` to the spawned demo gateway.
  The demo gateway will call `resolveNimbusTomlForProfile(configDir)`, which looks for `<realDataDir>/demo/config/nimbus.work.toml`. Since only `nimbus.toml` will exist in the demo config directory, it correctly falls back to `nimbus.toml`.
- **Improvement:**
  Add a test case in `demo-flag.e2e.test.ts` verifying that passing `NIMBUS_PROFILE=custom` alongside `--demo` succeeds without error.

---

## 3. Checklist & Validation Matrix for PR 1

| Component / Task | Verification Gate | Pass Criteria |
|---|---|---|
| **Task 1: Gateway Demo Root** | `bun test packages/gateway/src/platform/demo-root.test.ts` | Refusal on ambiguous `NIMBUS_DEMO`; hash suffix on Windows pipe; subtree relocation under `<dataDir>/demo`. |
| **Task 2: CLI Mirror & Parity** | `bun test scripts/parity/demo-root.parity.test.ts` | 100% path & verdict agreement across Win32, Darwin, and Linux matrices. |
| **Task 3: CLI Flag & Logging** | `bun test packages/cli/test/e2e/demo-flag.e2e.test.ts` | CLI log created under `<dataDir>/demo/data/logs/`; `--demo` stripped from argv; real log directory never touched. |
| **Task 4: Ephemeral Vault & Boot Policy** | `bun test packages/gateway/src/vault/` & `demo-boot.test.ts` | Vault factory returns `EphemeralVault` before OS switch; AppContainer reap and env sidecars skipped. |
| **Task 5: Invariant I41** | `bun test packages/gateway/src/security-invariants.test.ts -t "I41"` | All 4 clauses pass; negative controls fail; `audit:status-drift` and `audit:doc-refs` clean. |
| **Task 6: Real Gateway E2E** | `bun test packages/gateway/test/e2e/demo-root-isolation.e2e.test.ts` | Real entry boots on demo socket; `gateway.ping` ok; no sidecars; 0 stray files outside demo root. |
| **Task 7: Docs & Preflight** | `bun run preflight` | 33/33 preflight gates green; docs updated with I41. |
