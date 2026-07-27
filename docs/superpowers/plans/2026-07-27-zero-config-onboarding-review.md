# Plan Review: Zero-config Onboarding Implementation Plan

This document reviews [2026-07-27-zero-config-onboarding.md](./2026-07-27-zero-config-onboarding.md) and notes questions, suggestions, and improvements for the implementation steps.

---

## 1. Table-Awareness in `hasFilesystemRoot`

### Context-Blind Scanner Risk

- **Observation:** In `toml-append.ts` (Task 2, Step 3), `hasFilesystemRoot` splits the file into lines and checks for `path = "/repo/a"`.
- **Analysis:** This line-by-line check is context-blind. If the user has configured the same path under a different TOML section or table (e.g., `[custom_connector]` or `[llm]`), `hasFilesystemRoot` will return `true` and refuse to initialize the repository under `[[filesystem.roots]]`.
- **Recommendation:** Implement a simple table-tracking state machine in `hasFilesystemRoot` to ensure it only matches `path` lines under the `[[filesystem.roots]]` header context.
  
  For example:

  ```ts
  let currentTable = "";
  for (const line of source.split(/\r?\n/)) {
    const hash = line.indexOf("#");
    const code = (hash < 0 ? line : line.slice(0, hash)).trim();
    if (code.startsWith("[") && code.endsWith("]")) {
      currentTable = code;
      continue;
    }
    if (currentTable !== "[[filesystem.roots]]") continue;
    // ... process path matching ...
  }
  ```

---

## 2. Windows Path Serialization & Escaping Mismatches

### JSON Escape Slicing Issue

- **Observation:** `appendFilesystemRoot` uses `JSON.stringify(target)` to escape backslashes on Windows, writing `path = "C:\\\\gitrep\\\\Nimbus"`. `hasFilesystemRoot` uses `raw.slice(1, -1)` to extract this value.
- **Analysis:** Slicing outer quotes off `C:\\\\gitrep\\\\Nimbus` yields a string containing literal double-backslashes `C:\\gitrep\\Nimbus`, whereas the target directory string is `C:\gitrep\Nimbus`. When comparing `resolve(unquoted) === target`, they will mismatch, leading to duplicate blocks being appended.
- **Recommendation:** In `hasFilesystemRoot`, if the value starts with `"`, decode it using `JSON.parse` to evaluate escape characters correctly before resolving:

  ```ts
  let unquoted = raw;
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      unquoted = JSON.parse(raw);
    } catch {
      unquoted = raw.slice(1, -1);
    }
  } else if (raw.startsWith("'") && raw.endsWith("'")) {
    unquoted = raw.slice(1, -1);
  }
  ```

---

## 3. Selecting the Option (a) IPC Method for Smart Picker

### CLI IPC Integration

- **Observation:** Task 3, Step 5 presents a choice between **(a)** adding a read-only IPC method to return the symbol or **(b)** printing a generic `nimbus why <file>:<line>` next-step guide.
- **Suggestion:** Go with Option (a) to maximize onboarding wow-factor. To implement this:
  - Add the new method name `why.pickDemoSymbol` to the IPC schema in `packages/gateway/src/ipc/schema.ts` (or the corresponding gateway IPC routes).
  - Register the method handler in `packages/gateway/src/ipc/handlers/why.ts`.
  - Expose it through `ALLOWED_METHODS` in `ui/src-tauri/src/gateway_bridge.rs` (if Tauri desktop needs to access it).
  - Update `nimbus init` to call this IPC method, falling back to a generic file pointer if the daemon is offline.

---

## 4. subprocess Timeout in E2E Tests

### Test Execution Hanging Risk

- **Observation:** In Task 6, the test spawns a subprocess running the CLI via `Bun.spawn`.
- **Analysis:** If the CLI commands block or prompt for user interaction due to unexpected configurations, or if the daemon fails to exit, the E2E test suite could hang indefinitely in CI.
- **Suggestion:** Set a timeout or use `AbortController` to force-kill the subprocess if it does not exit within a reasonable window (e.g. 5 seconds), ensuring the runner fails explicitly instead of hanging the entire CI job.
