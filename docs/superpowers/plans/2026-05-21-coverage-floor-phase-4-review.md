# Review: Coverage Floor Phase 4 Implementation Plan

**Date:** 2026-05-21
**Target Plan:** [2026-05-20-coverage-floor-phase-4.md](./2026-05-20-coverage-floor-phase-4.md)

Overall, the implementation plan is extremely thorough, well-structured, and adheres perfectly to the precedents set in Phase 3. Splitting the most complex `mesh.ts` file into its own surgical commit is a great choice. 

Here are some open questions, suggestions, and improvements to consider before or during execution:

## 1. Test Isolation & Environment/Global Restoration
Several tasks require stubbing global state or environment variables. To prevent cross-test pollution (which can lead to flaky CI runs), explicitly specify the use of setup/teardown blocks.
* **Task 2 (`platform/assemble.ts`) & Task 15 (`platform/gateway-state-file.ts`):** Modifying `process.env` (e.g., unsetting `XDG_CONFIG_HOME` or altering `logPath`) must be reverted in an `afterEach` or `afterAll` block.
* **Task 15 (`platform/worker-security.ts`):** When stubbing `globalThis.origin` via `Object.defineProperty`, remember to store the original descriptor and restore it in an `afterEach` block. 

## 2. Mocking Subprocesses (`Bun.spawn`)
* **Task 14 (`voice/tts.ts` & `voice/wake-word.ts`):** When mocking `Bun.spawn`, the mocked return object must satisfy the expected `Subprocess` interface utilized by the voice modules. Be sure to mock necessary properties like `stdout`, `stderr` (e.g., as mocked streams or iterables), `exited`, and `kill()` to prevent runtime errors during the test.

## 3. Dynamic Import Mocks
* **Task 15 (`embedding/model.ts`):** The plan notes that mocking `@xenova/transformers` via `mock.module` can be tricky with dynamic imports. 
  * *Suggestion:* Ensure that `mock.module` is called at the very top of the test file, *before* any imports (even dynamic ones) could potentially evaluate. If Bun's mock cache proves too fragile here, moving this specific test into a completely separate file or relying solely on the fallback watermark strategy as planned is the safest approach.

## 4. Deterministic File System Tests
* **Task 10 (`db/backups-list.ts`):** For the case "Mixed scheduled + manual snapshots → sorted by timestamp descending", ensure that the test creates the fixture files with explicitly defined and distinct timestamps (using `fs.utimesSync` or by naming them with specific timestamps if the logic parses the filename). Relying purely on file creation order in a tight loop can cause race conditions and flaky tests on certain OS file systems.

## 5. Exclusions Formatting Parity
* **Task 1 (Sonar Properties):** When appending the 7 new structural exclusions to `sonar-project.properties`, ensure there are no trailing commas and that the exact path format strictly aligns with SonarQube's expected pattern matching (e.g., verifying if it requires wildcards or if exact relative paths are perfectly matched).

## Conclusion
The plan is highly robust. Addressing the test isolation (globals/env vars) and determinism points above will help ensure the newly added tests don't introduce CI flakiness.
