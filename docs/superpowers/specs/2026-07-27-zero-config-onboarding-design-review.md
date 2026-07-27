# Design Review: Zero-config onboarding — Design

This document reviews [2026-07-27-zero-config-onboarding-design.md](./2026-07-27-zero-config-onboarding-design.md) and notes questions, suggestions, and improvements.

---

## 1. Safe TOML Merging & Comment Preservation

### Merge Logic and Comment Stripping

- **Observation:** `nimbus init` will merge a `[[filesystem.roots]]` block into the user's `nimbus.toml`.
- **Question:** How will the merging be implemented? Standard TOML parser-serializer cycles (e.g., parsing to a JS object, appending, and stringifying) often strip user-written comments, discard whitespace formatting, and reorder existing keys.
- **Suggestion:** Use a parser that preserves comments and formatting, or implement a targeted line-based merger specifically for adding roots. If modifying the file programmatically, back up the original `nimbus.toml` (e.g. to `nimbus.toml.bak`) before executing the write operation to prevent configuration loss in case of parse errors or crashes.

---

## 2. Selection Strategy for the Demo File

### Selecting a Representative `file:line`

- **Observation:** The design proposes printing a real `file:line` from the user's repository to guide them to run `nimbus why <file>:<line>`.
- **Question:** If the CLI arbitrarily picks a file, it might select a lockfile (`package-lock.json`), a configuration file (`tsconfig.json`), a dependency directory file, or a binary asset. This would result in a broken or uninteresting `nimbus why` response.
- **Suggestion:** Define a robust selection strategy for the file:
  - Run `git ls-files` to query tracked source files.
  - Filter out lockfiles, configurations, READMEs, markdowns, and files exceeding a certain size.
  - Prioritize standard code extensions based on detected workspace patterns (e.g. `.ts`, `.rs`, `.py`, `.go`, `.java`, `.cpp`).
  - Scan the chosen file for the first non-trivial line (e.g. a line containing a function signature or class declaration) rather than line 1, to make the output of `nimbus why` more compelling.

---

## 3. Sync Latency & Background Indexing

### Instant Experience on Large Repositories

- **Observation:** Running a first sync on large repositories might take several minutes, interrupting the onboarding flow.
- **Suggestion:** Set a file count or repository size threshold (e.g., 500 files or 50MB). If the repository is larger:
  - Run `git log --name-only -n 20` to identify the most active / recently modified files.
  - Prioritize indexing those files synchronously so that they are immediately queryable.
  - Run the remaining indexing tasks in the background, showing a non-blocking indicator in the CLI, and ensuring the printed demo next command points to one of the already-indexed active files.

---

## 4. Daemon Boot and Graceful Failure Contracts

### No LLM Schema Support

- **Observation:** The daemon needs to boot cleanly without any `[llm]` block in the configuration.
- **Question:** Are there currently any assertions or schema validators in `packages/gateway/src/config/nimbus-toml.ts` or initialization checks that fail if `llm` is not configured?
- **Suggestion:** Audit the configuration loaders to ensure the `[llm]` section is fully optional. Add explicit unit tests verifying the daemon lifecycle with empty configurations.

### RPC Failure Handling

- **Observation:** `nimbus ask` requires an LLM and must fail gracefully with a helpful message.
- **Suggestion:** Avoid throwing a raw RPC stack trace. The gateway should return a structured error code (e.g., `LLM_NOT_CONFIGURED`). The CLI should catch this error code and render a visually clean setup guide pointing to local Ollama setup or API key instructions.

---

## 5. E2E Test Isolation

### Sandbox Config and Vault Separation

- **Observation:** The design suggests adding an integration test with a fresh config directory and no LLM.
- **Important Rule:** The test must not read from or write to the developer's real configuration directory or local credentials vault (such as DPAPI on Windows or Keychain on macOS).
- **Suggestion:** Ensure the E2E test runs with isolated environment variables (e.g., custom `NIMBUS_CONFIG_DIR` pointing to a temporary path, and mocking the platform services vault adapter to run in-memory or in-file only).
