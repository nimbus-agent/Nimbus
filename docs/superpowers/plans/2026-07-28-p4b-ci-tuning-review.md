# P4b CI Tuning — Plan Review

Review of the implementation plan [2026-07-28-p4b-ci-tuning.md](./2026-07-28-p4b-ci-tuning.md).

---

## Suggestions and Improvements

### 1. Nested Package Auditing (Connectors / Shared Packages)

* **Observation:** The `detectPlatformBranchingFiles` function in Task 1 scans files matching `packages/*/src`. It does not recurse into nested packages or directories.
* **Problem:** If a first-party connector under `packages/mcp-connectors/<connector-name>/src` or a helper in `packages/mcp-connectors/shared/` introduces platform-branching code (e.g. using `process.platform`), the audit will silently skip it because `packages/mcp-connectors/src` does not exist.
* **Suggestion:** Update `detectPlatformBranchingFiles` to recursively locate all `src` folders under `packages/`, or explicitly iterate through subdirectories of `packages/mcp-connectors/` as well. For example:

  ```ts
  // Support both packages/*/src and packages/mcp-connectors/*/src
  const targets = [
    join(repoRoot, "packages"),
    join(repoRoot, "packages/mcp-connectors")
  ];
  ```

### 2. Broadening the Platform-Branching Detection Regex

* **Observation:** The audit checks for `/process\.platform|os\.platform\(\)/`.
* **Problem:** Developers might use destructured imports or alternative ways to query the platform:
  * `import { platform } from "node:os"; if (platform() === "win32") { ... }` (fails regex match)
  * Checking `os.type()` (fails regex match)
  * Checking `process.env.OS` or similar platform-specific environment variables.
* **Suggestion:** Document this limitation clearly in the file headers or expand the regex `/process\.platform|os\.platform\(\)/` to also capture generic `platform()` calls or destructuring imports of `platform` from `os`/`node:os`.

### 3. YAML Parsing Resilience

* **Observation:** `parseCoverageGateMatrix` uses a line-based parser with fixed indentation assumptions (`if (/^\s{0,8}\S/.test(line)) break;`).
* **Problem:** Formatting changes (e.g. from YAML formatters or structural workflow updates) could shift indentations and break the parser.
* **Suggestion:** Keep the line-based parser but add a robust warning comment, or ensure the unit test suite explicitly exercises varying indents to catch formatting-related drift early.

### 4. API Request Error Handling in Probes

* **Observation:** In `probe-dag.ts` and `probe-concurrency.ts`, the `api` helper returns `null` on `gh api` errors.
* **Problem:** If `api` returns `null` or a failed payload, the caller maps over properties without checks or prints generic error messages.
* **Suggestion:** Make sure the diagnostic tools fail fast with descriptive messages if `gh` is unauthenticated or the API returns a rate-limit error.

---

## Open Questions

1. **How should platform-branching in `packages/ui` be handled?**
   * If Tauri/frontend files under `packages/ui` use platform-branching logic, are they covered by the same coverage gate strategy? Should they be explicitly added to the platform branching allowlist or ignored by the audit?
